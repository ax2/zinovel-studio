import test from "node:test";
import assert from "node:assert/strict";
import {
  originalProcessesAbsent,
  originalProcessSurvivors,
} from "../scripts/windows-owned-processes.mjs";

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
