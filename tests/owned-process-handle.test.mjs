import test from "node:test";
import assert from "node:assert/strict";
import { terminateOriginalWithHandle } from "../scripts/owned-process-handle.mjs";

const born = "2026-10-25T07:00:00.1234567Z",
  identity = JSON.stringify(born);
function fake({
  states = [258, 0],
  created = born,
  opened = true,
  error = 5,
  terminated = true,
  readonly = false,
} = {}) {
  const calls = { terminate: 0, closed: 0, readOnly: 0, wait: 0 };
  return {
    calls,
    api: {
      open: () => (opened ? {} : null),
      error: () => error,
      openReadOnly: () => {
        calls.readOnly++;
        return readonly ? {} : null;
      },
      creationDate: () => created,
      wait: () => {
        calls.wait++;
        return states.length > 1 ? states.shift() : states[0];
      },
      terminate: () => {
        calls.terminate++;
        return terminated;
      },
      close: () => calls.closed++,
    },
  };
}
test("a signaled retained process object is already exited and must not be terminated again", async () => {
  const f = fake({ states: [0] });
  assert.equal(
    (await terminateOriginalWithHandle(12, identity, f.api)).status,
    "already-exited",
  );
  assert.equal(f.calls.terminate, 0);
  assert.equal(f.calls.closed, 1);
});
test("exit racing a failed termination is confirmed by the same pinned handle, not an English error message or PID", async () => {
  const f = fake({ states: [258, 258, 0], terminated: false });
  assert.equal(
    (
      await terminateOriginalWithHandle(12, identity, f.api, {
        pause: async () => {},
      })
    ).status,
    "exited-during-termination",
  );
  assert.equal(f.calls.terminate, 1);
  assert.equal(f.calls.closed, 1);
});
test("a process with the same PID and millisecond but a different 100ns birth identity is never touched", async () => {
  const f = fake({ created: born.replace("4567Z", "4568Z") });
  assert.equal(
    (await terminateOriginalWithHandle(12, identity, f.api)).status,
    "different-identity",
  );
  assert.equal(f.calls.terminate, 0);
  assert.equal(f.calls.wait, 0);
  assert.equal(f.calls.closed, 1);
});
test("access denied is not success while the original remains live; read-only exit confirmation is allowed", async () => {
  const live = fake({ states: [258], opened: false, readonly: true });
  await assert.rejects(
    terminateOriginalWithHandle(12, identity, live.api),
    /Cannot terminate/,
  );
  assert.equal(live.calls.terminate, 0);
  assert.equal(live.calls.closed, 1);
  const dead = fake({ states: [0], opened: false, readonly: true });
  assert.equal(
    (await terminateOriginalWithHandle(12, identity, dead.api)).status,
    "already-exited",
  );
  assert.equal(dead.calls.terminate, 0);
  assert.equal(dead.calls.closed, 1);
});
test("missing PID is safe, unreadable birth time and failed waits remain unproven", async () => {
  const missing = fake({ opened: false, error: 87 });
  assert.equal(
    (await terminateOriginalWithHandle(12, identity, missing.api)).status,
    "absent",
  );
  assert.equal(missing.calls.terminate, 0);
  assert.equal(missing.calls.closed, 0);
  for (const config of [{ created: null }, { states: [0xffffffff] }]) {
    const f = fake(config);
    await assert.rejects(
      terminateOriginalWithHandle(12, identity, f.api),
      /Cannot/,
    );
    assert.equal(f.calls.terminate, 0);
    assert.equal(f.calls.closed, 1);
  }
});
test("termination timeout and post-termination wait failure close the handle and never broaden the target", async () => {
  for (const states of [[258], [258, 0xffffffff]]) {
    const f = fake({ states, terminated: false });
    await assert.rejects(
      terminateOriginalWithHandle(12, identity, f.api, { timeoutMs: 0 }),
      /did not exit|Cannot observe/,
    );
    assert.equal(f.calls.terminate, 1);
    assert.equal(f.calls.closed, 1);
  }
});
