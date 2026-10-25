import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import koffi from "koffi";
import {
  originalProcessesAbsent,
  originalProcessSurvivors,
  ownedProcessIdentities,
  captureOwnedProcesses,
  terminateOwnedProcesses,
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

test("same-millisecond ancestry still excludes an older stale-parent process using full 100ns birth order", () => {
  const root = {
    ProcessId: 101,
    ParentProcessId: 4,
    CreationDate: "2026-10-25T07:00:00.1234567Z",
  };
  const stale = {
      ProcessId: 202,
      ParentProcessId: 101,
      CreationDate: "2026-10-25T07:00:00.1234566Z",
    },
    actual = {
      ProcessId: 203,
      ParentProcessId: 101,
      CreationDate: "2026-10-25T07:00:00.1234568Z",
    };
  assert.deepEqual(
    [...ownedProcessIdentities(101, [stale, actual, root]).keys()],
    [101, 203],
  );
});

async function child() {
  const p = fork(
    new URL("./fixtures/owned-process-child.mjs", import.meta.url),
    [],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(p, "message");
  return p;
}
test(
  "real Windows termination leaves an unrelated live child alone and refuses a mismatched exact birth time",
  { skip: process.platform !== "win32" },
  async () => {
    const target = await child(),
      other = await child();
    const { windowsProcessSnapshot, terminateWindowsProcessIdentity } =
      await import("../scripts/windows-process-snapshot.mjs");
    try {
      const owned = await captureOwnedProcesses(target.pid),
        created = JSON.parse(owned.get(target.pid));
      assert.match(created, /\.\d{7}Z$/);
      const wrong = created.replace(
        /(\d)Z$/,
        (_all, digit) => `${(Number(digit) + 1) % 10}Z`,
      );
      assert.equal(
        (
          await terminateWindowsProcessIdentity(
            target.pid,
            JSON.stringify(wrong),
          )
        ).status,
        "different-identity",
      );
      assert.ok(
        windowsProcessSnapshot().some((p) => p.ProcessId === target.pid),
      );
      const exited = once(target, "exit");
      await terminateOwnedProcesses(owned);
      await exited;
      assert.ok(
        windowsProcessSnapshot().some((p) => p.ProcessId === other.pid),
      );
    } finally {
      for (const p of [target, other])
        if (p.exitCode === null) {
          const owned = await captureOwnedProcesses(p.pid);
          const exited = once(p, "exit");
          await terminateOwnedProcesses(owned);
          await exited;
        }
    }
  },
);
test(
  "an exited Windows process retained by a native handle is absent from live inventory and safe to recheck",
  { skip: process.platform !== "win32" },
  async () => {
    const p = await child(),
      dll = koffi.load(`${process.env.SystemRoot}\\System32\\kernel32.dll`),
      open = dll.func(
        "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
      ),
      close = dll.func("int __stdcall CloseHandle(void *handle)"),
      wait = dll.func(
        "uint32_t __stdcall WaitForSingleObject(void *handle,uint32_t timeout)",
      ),
      { windowsProcessSnapshot, terminateWindowsProcessIdentity } =
        await import("../scripts/windows-process-snapshot.mjs");
    const owned = await captureOwnedProcesses(p.pid),
      handle = open(0x101000, 0, p.pid);
    assert.ok(handle);
    try {
      const exited = once(p, "exit");
      p.send("exit");
      await exited;
      assert.equal(wait(handle, 0), 0);
      assert.ok(
        !windowsProcessSnapshot().some((row) => row.ProcessId === p.pid),
      );
      const result = await terminateWindowsProcessIdentity(
        p.pid,
        owned.get(p.pid),
      );
      assert.ok(["absent", "already-exited"].includes(result.status));
    } finally {
      close(handle);
    }
  },
);

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
