import assert from "node:assert/strict";

async function snapshot() {
  const { windowsProcessSnapshot } = await import(
    "./windows-process-snapshot.mjs"
  );
  return windowsProcessSnapshot();
}

export async function captureOwnedProcesses(rootPid) {
  return ownedProcessIdentities(rootPid, await snapshot());
}

function creationTime(value) {
  const legacy =
    typeof value === "string" &&
    /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const time = legacy
    ? Number(legacy[1])
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  assert.ok(
    Number.isFinite(time),
    "owned process creation time must be readable",
  );
  const fraction =
    typeof value === "string" && /\.\d{3}(\d{1,4})Z$/.exec(value);
  return (
    BigInt(time) * 10000n + BigInt(fraction ? fraction[1].padEnd(4, "0") : 0)
  );
}

/** ParentProcessId survives parent exit; an older process cannot belong to a reused PID. */
export function ownedProcessIdentities(rootPid, processes) {
  assert.ok(Number.isInteger(rootPid) && rootPid > 0);
  const active = new Map(processes.map((item) => [item.ProcessId, item]));
  const owned = new Set([rootPid]);
  assert.ok(
    processes.some((item) => item.ProcessId === rootPid),
    "owned desktop must exist before termination",
  );
  creationTime(active.get(rootPid).CreationDate);
  for (let size = -1; size !== owned.size; ) {
    size = owned.size;
    for (const item of processes)
      if (
        owned.has(item.ParentProcessId) &&
        !owned.has(item.ProcessId) &&
        creationTime(item.CreationDate) >=
          creationTime(active.get(item.ParentProcessId).CreationDate)
      )
        owned.add(item.ProcessId);
  }
  const identities = new Map();
  for (const pid of owned) {
    const item = active.get(pid);
    assert.ok(
      item.CreationDate,
      "owned process creation time must be readable",
    );
    identities.set(item.ProcessId, JSON.stringify(item.CreationDate));
  }
  return identities;
}

export function originalProcessSurvivors(owned, processes) {
  const active = new Map(processes.map((item) => [item.ProcessId, item]));
  const survivors = [];
  for (const [pid, created] of owned) {
    const current = active.get(pid);
    if (!current) continue;
    assert.ok(
      current.CreationDate,
      "Cannot confirm process exit: creation time unreadable",
    );
    if (JSON.stringify(current.CreationDate) === created)
      survivors.push({ pid, createdAt: current.CreationDate });
  }
  return survivors;
}
export function originalProcessesAbsent(owned, processes) {
  return originalProcessSurvivors(owned, processes).length === 0;
}

export async function confirmOwnedProcessesExited(owned, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let survivors = [];
  do {
    const processes = await snapshot();
    survivors = originalProcessSurvivors(owned, processes);
    if (!survivors.length) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(
    `Original owned process identities remain alive after termination: ${JSON.stringify(survivors)}`,
  );
}

/** Failed synthetic UI probes must not hang behind a native save-confirmation dialog. */
export async function terminateOwnedProcesses(owned) {
  // Stop the host first so a synthetic abrupt shutdown cannot persist a child
  // exit as an ordinary task failure. Verified handles pin each original object;
  // a PID-only tree could include unrelated processes after parent PID reuse.
  const { terminateWindowsProcessIdentity } = await import(
    "./windows-process-snapshot.mjs"
  );
  const outcomes = [];
  for (const [pid, created] of owned)
    outcomes.push({
      pid,
      ...(await terminateWindowsProcessIdentity(pid, created)),
    });
  await confirmOwnedProcessesExited(owned);
  return outcomes;
}
