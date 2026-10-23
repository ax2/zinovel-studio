import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run = promisify(execFile);
async function snapshot() {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
  );
  const value = JSON.parse(stdout);
  return Array.isArray(value) ? value : value ? [value] : [];
}

export async function captureOwnedProcesses(rootPid) {
  assert.ok(Number.isInteger(rootPid) && rootPid > 0);
  const processes = await snapshot(),
    owned = new Set([rootPid]);
  assert.ok(
    processes.some((item) => item.ProcessId === rootPid),
    "owned desktop must exist before termination",
  );
  for (let size = -1; size !== owned.size; ) {
    size = owned.size;
    for (const item of processes)
      if (owned.has(item.ParentProcessId)) owned.add(item.ProcessId);
  }
  const identities = new Map();
  for (const item of processes)
    if (owned.has(item.ProcessId)) {
      assert.ok(
        item.CreationDate,
        "owned process creation time must be readable",
      );
      identities.set(item.ProcessId, JSON.stringify(item.CreationDate));
    }
  return identities;
}

export function originalProcessesAbsent(owned, processes) {
  const active = new Map(processes.map((item) => [item.ProcessId, item]));
  for (const [pid, created] of owned) {
    const current = active.get(pid);
    if (!current) continue;
    assert.ok(
      current.CreationDate,
      "Cannot confirm process exit: creation time unreadable",
    );
    if (JSON.stringify(current.CreationDate) === created) return false;
  }
  return true;
}

export async function confirmOwnedProcessesExited(owned, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const processes = await snapshot();
    if (originalProcessesAbsent(owned, processes)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(
    "Original owned process identities remain alive after termination",
  );
}

/** Failed synthetic UI probes must not hang behind a native save-confirmation dialog. */
export async function terminateOwnedProcesses(owned) {
  for (const [pid, created] of owned) {
    const current = (await snapshot()).find((item) => item.ProcessId === pid);
    if (!current || JSON.stringify(current.CreationDate) !== created) continue;
    try {
      await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 15000,
      });
    } catch (error) {
      const after = (await snapshot()).find((item) => item.ProcessId === pid);
      if (after && JSON.stringify(after.CreationDate) === created) throw error;
    }
  }
  await confirmOwnedProcessesExited(owned);
}
