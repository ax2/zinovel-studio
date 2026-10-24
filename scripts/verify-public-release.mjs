import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  tag = process.argv[2],
  runId = process.argv[3];
if (
  !/^v\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/.test(tag || "") ||
  !/^\d+$/.test(runId || "")
)
  throw new Error(
    "Usage: node scripts/verify-public-release.mjs v0.1.0-alpha.N RELEASE_RUN_ID [output-directory] [installer-directory]",
  );
const output = resolve(
    root,
    process.argv[4] || `assessments/release/${tag}/ci-public`,
  ),
  repository = "ax2/zinovel-studio";
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
const json = (value) => JSON.parse(value.replace(/^\uFEFF/, ""));
mkdirSync(output, { recursive: true });
const receipt = (value) =>
  writeFileSync(
    join(output, "verification.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
const attempt = { tag, runId, checkedAt: new Date().toISOString() };
receipt({ ...attempt, status: "checking" });
try {
  const expectedCommit = run("git", [
    "rev-parse",
    "--verify",
    `refs/tags/${tag}^{commit}`,
  ]).trim();
  const ci = json(
    run("gh", [
      "run",
      "view",
      runId,
      "--repo",
      repository,
      "--json",
      "status,conclusion,headSha,headBranch,workflowName,url",
    ]),
  );
  assert.equal(ci.status, "completed");
  assert.equal(ci.conclusion, "success");
  assert.equal(ci.workflowName, "Windows release");
  assert.equal(ci.headSha, expectedCommit);
  assert.equal(ci.headBranch, tag);
  const release = json(
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,url,isDraft,isPrerelease,publishedAt,assets",
    ]),
  );
  assert.equal(release.tagName, tag);
  assert.equal(release.isDraft, false);
  assert.equal(release.isPrerelease, true);
  assert.equal(release.assets.length, 4);
  mkdirSync(output, { recursive: true });
  const metadata = [
    "release-manifest.json",
    "runtime-inventory.json",
    "SHA256SUMS.txt",
  ];
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--dir",
    output,
    "--clobber",
    ...metadata.flatMap((name) => ["--pattern", name]),
  ]);
  const manifest = json(readFileSync(join(output, metadata[0]), "utf8")),
    inventory = json(readFileSync(join(output, metadata[1]), "utf8"));
  assert.equal(manifest.commit, expectedCommit);
  assert.equal(manifest.version, tag.slice(1));
  assert.equal(inventory.version, manifest.version);
  assert.equal(
    manifest.installer,
    `ZiNovel-Studio-${manifest.version}-windows-x64-setup.exe`,
  );
  const installer = release.assets.find(
    (item) => item.name === manifest.installer,
  );
  assert.ok(installer);
  assert.equal(installer.digest, `sha256:${manifest.sha256}`);
  assert.equal(installer.size, manifest.bytes);
  for (const name of metadata)
    assert.equal(
      release.assets.find((item) => item.name === name)?.digest,
      `sha256:${createHash("sha256")
        .update(readFileSync(join(output, name)))
        .digest("hex")}`,
    );
  assert.equal(
    readFileSync(join(output, "SHA256SUMS.txt"), "utf8"),
    `${manifest.sha256}  ${manifest.installer}\n`,
  );
  assert.ok(
    manifest.qualification.some((item) =>
      item.includes("same-version reinstall preserves exact manuscript bytes"),
    ),
  );
  assert.ok(
    manifest.qualification.some((item) =>
      item.includes("real NSIS uninstall removes app"),
    ),
  );
  assert.ok(
    manifest.upgrade?.previousInstallerSha256 && manifest.upgrade.upgradeMs > 0,
  );
  const installerDirectory = resolve(
    root,
    process.argv[5] || join(output, "installer"),
  );
  mkdirSync(installerDirectory, { recursive: true });
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--dir",
    installerDirectory,
    "--clobber",
    "--pattern",
    manifest.installer,
  ]);
  const downloadedInstaller = join(installerDirectory, manifest.installer);
  assert.equal(statSync(downloadedInstaller).size, manifest.bytes);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(downloadedInstaller))
      .digest("hex"),
    manifest.sha256,
  );
  const verification = {
    ...attempt,
    status: "passed",
    release: release.url,
    publishedAt: release.publishedAt,
    ci: ci.url,
    commit: expectedCommit,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    metadataDigestsVerified: true,
    downloadedInstallerSha256Verified: true,
    downloadedInstaller,
    publicInstallerExecutionEvidence:
      "Release CI installed exact manifest bytes; actual public EXE downloaded and independently rehashed locally; no additional local execution claimed",
  };
  writeFileSync(
    join(output, "verification.json"),
    JSON.stringify(verification, null, 2) + "\n",
  );
  console.log(verification);
} catch (error) {
  receipt({
    ...attempt,
    status: "failed",
    error: String(error.message || error),
  });
  throw error;
}
