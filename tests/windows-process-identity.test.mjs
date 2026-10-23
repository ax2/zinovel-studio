import test from "node:test";
import assert from "node:assert/strict";
import {
  originalProcessesAbsent,
  originalProcessSurvivors,
  ownedProcessIdentities,
} from "../scripts/windows-owned-processes.mjs";

test(
  "native Windows inventory reads the live process identity without returning names or command lines",
  { skip: process.platform !== "win32" },
  async () => {
    const { windowsProcessSnapshot } = await import(
      "../scripts/windows-process-snapshot.mjs"
    );
    const inventory = windowsProcessSnapshot();
    const current = inventory.find((item) => item.ProcessId === process.pid);
    assert.ok(current);
    assert.equal(current.ParentProcessId, process.ppid);
    assert.ok(
      Math.abs(
        Date.parse(current.CreationDate) -
          (Date.now() - process.uptime() * 1000),
      ) < 3000,
    );
    assert.deepEqual(Object.keys(current).sort(), [
      "CreationDate",
      "ParentProcessId",
      "ProcessId",
    ]);
    const owned = ownedProcessIdentities(process.pid, inventory);
    assert.equal(owned.get(process.pid), JSON.stringify(current.CreationDate));
  },
);

test("owned descendants exclude older stale-parent processes and their children after a parent PID is reused", () => {
  const process = (pid, parent, time) => ({
    ProcessId: pid,
    ParentProcessId: parent,
    CreationDate: `/Date(${time})/`,
  });
  const inventory = [
    process(303, 202, 1300),
    process(999, 888, 100),
    process(202, 101, 1200),
    process(888, 101, 100),
    process(101, 4, 1000),
    process(304, 202, 1200),
  ];
  const owned = ownedProcessIdentities(101, inventory);
  assert.deepEqual([...owned.keys()], [101, 202, 304, 303]);
  assert.equal(owned.has(888), false);
  assert.equal(owned.has(999), false);
});

test("ownership requires readable birth times along the entire ancestry", () => {
  const root = {
    ProcessId: 101,
    ParentProcessId: 4,
    CreationDate: "2026-10-24T00:00:00.000Z",
  };
  assert.deepEqual(
    [
      ...ownedProcessIdentities(101, [
        root,
        {
          ProcessId: 202,
          ParentProcessId: 101,
          CreationDate: "2026-10-24T00:00:01.000Z",
        },
      ]).keys(),
    ],
    [101, 202],
  );
  assert.throws(
    () =>
      ownedProcessIdentities(101, [
        root,
        { ProcessId: 202, ParentProcessId: 101, CreationDate: null },
      ]),
    /readable/,
  );
  assert.throws(
    () => ownedProcessIdentities(101, [{ ...root, CreationDate: null }]),
    /readable/,
  );
});

test("exit verification distinguishes living original processes, reused PIDs and unreadable identities", () => {
  const owned = new Map([
    [123, JSON.stringify("original creation")],
    [456, JSON.stringify("worker creation")],
  ]);
  assert.equal(originalProcessesAbsent(owned, []), true);
  assert.equal(
    originalProcessesAbsent(owned, [
      { ProcessId: 123, CreationDate: "original creation" },
    ]),
    false,
  );
  assert.equal(
    originalProcessesAbsent(owned, [
      { ProcessId: 456, CreationDate: "worker creation" },
    ]),
    false,
  );
  assert.equal(
    originalProcessesAbsent(owned, [
      { ProcessId: 123, CreationDate: "new unrelated process" },
    ]),
    true,
  );
  assert.throws(
    () =>
      originalProcessesAbsent(owned, [{ ProcessId: 123, CreationDate: null }]),
    /unreadable/,
  );
  assert.equal(
    originalProcessesAbsent(owned, [{ ProcessId: 999, CreationDate: null }]),
    true,
  );
  assert.deepEqual(
    originalProcessSurvivors(owned, [
      { ProcessId: 123, CreationDate: "new unrelated process" },
      {
        ProcessId: 456,
        CreationDate: "worker creation",
        CommandLine: "SYNTHETIC_SECRET",
      },
    ]),
    [{ pid: 456, createdAt: "worker creation" }],
  );
});
