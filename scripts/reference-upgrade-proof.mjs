import { createHash } from "node:crypto";
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validateReferenceUpgrade(report, producer, source, target) {
  const draft = producer.upgradeState?.draftValue;
  if (
    ![
      report.previousInstallerSha256,
      report.previousAsarSha256,
      report.currentInstallerSha256,
      report.appAsarSha256,
    ].every(sha) ||
    typeof draft !== "string" ||
    createHash("sha256").update(draft).digest("hex") !== report.draftSha256
  )
    throw new Error(
      "Public40 source draft fingerprint or executable identity is invalid",
    );
  if (
    report.status !== "passed" ||
    report.fromVersion !== "0.1.0-alpha.40" ||
    source.version !== report.fromVersion ||
    report.toVersion !== target.version ||
    report.previousInstallerSha256 !== source.sha256 ||
    report.previousAsarSha256 !== source.referenceEditing?.appAsarSha256 ||
    report.currentInstallerSha256 !== target.sha256 ||
    report.appAsarSha256 !== target.appAsarSha256 ||
    producer.status !== "passed" ||
    producer.packaged !== true ||
    producer.version !== source.version ||
    producer.appAsarSha256 !== report.previousAsarSha256 ||
    producer.forcedEditRestart !== true ||
    producer.requests !== 2 ||
    producer.checks?.length !== 5 ||
    producer.errors?.length !== 0 ||
    JSON.parse(producer.upgradeState?.draftValue || "null")?.schemaVersion !==
      2 ||
    report.sourceRequests !== 2 ||
    report.replayRequests !== 0 ||
    report.readbacks !== 3 ||
    report.uninstallPreserved !== true ||
    !sha(report.draftSha256) ||
    !sha(report.profileSha256) ||
    !Number.isFinite(report.upgradeMs) ||
    report.upgradeMs <= 0 ||
    report.checks?.length !== 4 ||
    report.errors?.length !== 0 ||
    !Array.isArray(report.protectedFiles) ||
    report.protectedFiles.length < 10 ||
    report.protectedFiles.some(
      (f) =>
        typeof f.path !== "string" ||
        !f.path ||
        f.path.startsWith("/") ||
        f.path.split("/").some((p) => p === ".." || !p) ||
        !sha(f.sha256),
    ) ||
    ![
      producer.upgradeState?.adoptedTaskId,
      producer.upgradeState?.unknownTaskId,
    ].every((id) =>
      report.protectedFiles.some(
        (f) => f.path === `.zinovel/image-tasks/${id}.json`,
      ),
    )
  )
    throw new Error(
      "Public40 schema3 reference tasks/draft upgrade proof is missing or stale",
    );
  return {
    fromVersion: report.fromVersion,
    toVersion: report.toVersion,
    appAsarSha256: report.appAsarSha256,
    previousInstallerSha256: report.previousInstallerSha256,
    currentInstallerSha256: report.currentInstallerSha256,
    checks: report.checks,
    readbacks: report.readbacks,
    sourceRequests: report.sourceRequests,
    replayRequests: report.replayRequests,
    draftSha256: report.draftSha256,
    profileSha256: report.profileSha256,
    protectedFiles: report.protectedFiles,
    scope: report.scope,
  };
}
