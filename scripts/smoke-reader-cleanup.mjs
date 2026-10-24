import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  run = promisify(execFile);
let failure;
try {
  await run(process.execPath, [join(root, "scripts/smoke-reader.mjs")], {
    cwd: root,
    windowsHide: true,
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      ZINOVEL_QA_STAGE: "stage-005/reader-cleanup-negative",
      ZINOVEL_READER_CLEANUP_FAULT: "1",
    },
  });
} catch (error) {
  failure = error;
}
assert.equal(
  failure?.code,
  1,
  "intentional failed probe must exit, not hang or pass",
);
const receipt =
    "screenshots/stage-005/reader-cleanup-negative/reader/reader-smoke.json",
  result = JSON.parse(await readFile(join(root, receipt), "utf8"));
assert.equal(result.status, "failed");
assert.match(result.failure, /synthetic-reader-cleanup-checkpoint/);
assert.equal(result.failedCleanupConfirmed, true);
assert.ok(Number.isInteger(result.cleanupOwnership?.rootPid));
assert.ok(Number.isInteger(result.cleanupOwnership?.rendererPid));
assert.notEqual(
  result.cleanupOwnership.rootPid,
  result.cleanupOwnership.rendererPid,
);
assert.ok(result.cleanupOwnership.captured >= 2);
assert.equal(
  result.ownedProcessesConfirmedExited,
  result.cleanupOwnership.captured,
);
const report = {
  status: "passed",
  ownedProcessesConfirmedExited: result.ownedProcessesConfirmedExited,
  cleanupOwnership: result.cleanupOwnership,
  checks: [
    "intentional reader failure is persisted as failed before cleanup; captured original Windows process identities all exit and the driver returns exit 1 without a native close-confirmation hang",
  ],
  expectedFailureReceipt: receipt,
  scope:
    "QA cleanup only; expected failed reader checkpoint is not product qualification",
};
await mkdir(join(root, "assessments/stage-005"), { recursive: true });
await writeFile(
  join(root, "assessments/stage-005/reader-cleanup-negative.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
