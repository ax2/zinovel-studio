import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateReferenceUpgrade } from "../scripts/reference-upgrade-proof.mjs";
function fixture() {
  const source = {
      version: "0.1.0-alpha.40",
      sha256: "a".repeat(64),
      referenceEditing: { appAsarSha256: "b".repeat(64) },
    },
    target = {
      version: "0.1.0-alpha.41",
      sha256: "c".repeat(64),
      appAsarSha256: "d".repeat(64),
    },
    draftValue = JSON.stringify({
      schemaVersion: 2,
      reference: { id: "fixed-reference" },
    });
  const producer = {
    status: "passed",
    packaged: true,
    version: source.version,
    appAsarSha256: source.referenceEditing.appAsarSha256,
    forcedEditRestart: true,
    requests: 2,
    checks: Array(5).fill("Synthetic source author check"),
    errors: [],
    upgradeState: {
      draftValue,
      adoptedTaskId: "old-adopted",
      unknownTaskId: "old-unknown",
    },
  };
  const report = {
    status: "passed",
    fromVersion: source.version,
    toVersion: target.version,
    previousInstallerSha256: source.sha256,
    previousAsarSha256: producer.appAsarSha256,
    currentInstallerSha256: target.sha256,
    appAsarSha256: target.appAsarSha256,
    sourceRequests: 2,
    replayRequests: 0,
    readbacks: 3,
    uninstallPreserved: true,
    draftSha256: createHash("sha256").update(draftValue).digest("hex"),
    profileSha256: "e".repeat(64),
    upgradeMs: 1000,
    checks: Array(4).fill("Synthetic upgrade check"),
    errors: [],
    protectedFiles: [
      ".zinovel/image-tasks/old-adopted.json",
      ".zinovel/image-tasks/old-unknown.json",
      ...Array.from({ length: 8 }, (_, n) => `asset-${n}.json`),
    ].map((path) => ({ path, sha256: "f".repeat(64) })),
  };
  return { report, producer, source, target };
}
test("public40 reference upgrade requires the actual old executable producer, protected tasks, fixed draft and all readbacks", () => {
  const f = fixture();
  assert.equal(
    validateReferenceUpgrade(f.report, f.producer, f.source, f.target)
      .readbacks,
    3,
  );
  for (const mutate of [
    (f) => {
      f.producer.packaged = false;
    },
    (f) => {
      f.producer.version = "0.1.0-alpha.39";
    },
    (f) => {
      f.report.appAsarSha256 = "a".repeat(64);
    },
    (f) => {
      f.report.replayRequests = 1;
    },
    (f) => {
      f.report.readbacks = 2;
    },
    (f) => {
      f.report.protectedFiles[0].path = "other.json";
    },
    (f) => {
      f.producer.upgradeState.draftValue = '{"schemaVersion":1}';
    },
    (f) => {
      f.report.uninstallPreserved = false;
    },
  ]) {
    const g = fixture();
    mutate(g);
    assert.throws(() =>
      validateReferenceUpgrade(g.report, g.producer, g.source, g.target),
    );
  }
});
