import test from "node:test";
import assert from "node:assert/strict";
import { waitForCondition } from "../scripts/windows-installer-observation.mjs";
const denied = (code) =>
  Object.assign(new Error("synthetic access uncertainty"), { code });

test("installer observation retries permission uncertainty but requires an actual conclusive condition", async () => {
  let calls = 0;
  const receipt = await waitForCondition(
    async () => {
      calls++;
      if (calls === 1) throw denied("EPERM");
      if (calls === 2) throw denied("EACCES");
      return calls === 4;
    },
    "not gone",
    1000,
    0,
  );
  assert.equal(calls, 4);
  assert.equal(receipt.attempts, 4);
  assert.equal(receipt.permissionRetries, 2);
  assert.deepEqual(receipt.permissionErrorCodes, ["EPERM", "EACCES"]);
});
test("permanent permission denial cannot pass as a missing executable", async () => {
  const original = denied("EPERM");
  await assert.rejects(
    waitForCondition(
      async () => {
        throw original;
      },
      "absence not confirmed",
      0,
      0,
    ),
    (error) => {
      assert.equal(error.code, "OBSERVATION_TIMEOUT");
      assert.equal(error.cause, original);
      assert.equal(error.observation.permissionRetries, 1);
      return true;
    },
  );
});
test("unrelated IO failures fail immediately rather than being silently retried", async () => {
  const original = denied("EIO");
  let calls = 0;
  await assert.rejects(
    waitForCondition(
      async () => {
        calls++;
        throw original;
      },
      "not gone",
      1000,
      0,
    ),
    (error) => error === original,
  );
  assert.equal(calls, 1);
});
test("a remaining executable or registration still fails at the observation deadline", async () => {
  await assert.rejects(
    waitForCondition(async () => false, "registration still present", 0, 0),
    (error) => {
      assert.equal(error.code, "OBSERVATION_TIMEOUT");
      assert.equal(error.cause, undefined);
      assert.equal(error.observation.permissionRetries, 0);
      return true;
    },
  );
});
