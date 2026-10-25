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
  const anonymousResponse = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ZiNovel-release-verifier",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  assert.equal(
    anonymousResponse.status,
    200,
    "Release must be visible without authentication",
  );
  const anonymousRelease = await anonymousResponse.json();
  assert.equal(anonymousRelease.tag_name, tag);
  assert.equal(anonymousRelease.html_url, release.url);
  assert.equal(anonymousRelease.draft, false);
  assert.equal(anonymousRelease.prerelease, true);
  assert.equal(anonymousRelease.assets.length, 4);
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
  const alpha = /^0\.1\.0-alpha\.(\d+)$/.exec(manifest.version);
  assert.ok(
    alpha,
    "Public verification contracts for this release family must be configured explicitly",
  );
  const milestone = Number(alpha[1]);
  assert.ok(Number.isSafeInteger(milestone) && milestone > 0);
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
  const anonymousInstaller = anonymousRelease.assets.find(
    (item) => item.name === manifest.installer,
  );
  assert.equal(anonymousInstaller?.digest, `sha256:${manifest.sha256}`);
  assert.equal(anonymousInstaller?.size, manifest.bytes);
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
  if (milestone >= 32) {
    const recent = manifest.recentUpgrade;
    assert.equal(recent?.fromVersion, "0.1.0-alpha.31");
    assert.equal(
      recent.previousInstallerSha256,
      "7c41eed5bc9844dd3ca187690efa5dea9cf53683f23ef2b51ff987b6f63e93dc",
    );
    assert.ok(recent.upgradeMs > 0);
    assert.equal(recent.appAsarSha256, manifest.imageStudio.appAsarSha256);
    for (const key of [
      "reviewedOldCandidateWithoutRequest",
      "credentialsPreserved",
      "profileBytesPreserved",
      "uninstallPreserved",
    ])
      assert.equal(recent[key], true);
    assert.deepEqual(recent.requests, { text: 0, image: 2 });
    assert.equal(manifest.imageStudio.checks.length, 11);
    for (const key of [
      "reviewedTargetAdoption",
      "reviewedChapterAdoption",
      "reviewedTargetNarrowConfirmation",
    ])
      assert.equal(manifest.imageStudio[key], true);
  }
  if (milestone >= 33) {
    assert.equal(manifest.processRecovery?.handlePinned, true);
    assert.equal(manifest.processRecovery?.birthPrecision, "100ns");
    assert.equal(manifest.processRecovery?.rootStatus, "terminated");
    assert.equal(
      manifest.processRecovery?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
  }
  if (milestone >= 34) {
    const current = manifest.currentPublicUpgrade;
    assert.equal(current?.fromVersion, "0.1.0-alpha.33");
    assert.equal(
      current.previousInstallerSha256,
      "403acb68b027ff23e069391fe755f3f7bef53a30b1e4140647b16f2063b2a38f",
    );
    assert.equal(
      current.previousAsarSha256,
      "0f406e098c4070226b1306573c22010c283377a8003a84751e268d684ff59b89",
    );
    assert.equal(current.appAsarSha256, manifest.imageStudio.appAsarSha256);
    assert.ok(current.upgradeMs > 0);
    assert.deepEqual(current.requests, { text: 0, image: 3 });
    for (const key of [
      "reviewedOldCandidateWithoutRequest",
      "credentialsPreserved",
      "profileBytesPreserved",
      "uninstallPreserved",
      "previousV2ReceiptPreserved",
      "previousV2Readable",
      "previousAdoptedAssetPreserved",
    ])
      assert.equal(current[key], true);
    assert.equal(current.previousV2Files.length, 3);
    assert.equal(manifest.characterLooks?.version, manifest.version);
    assert.equal(
      manifest.characterLooks?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
    assert.equal(manifest.characterLooks?.checks?.length, 4);
  }
  if (milestone >= 36) {
    assert.equal(manifest.sceneTree?.version, manifest.version);
    assert.equal(
      manifest.sceneTree?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
    assert.equal(manifest.sceneTree?.checks?.length, 4);
    assert.equal(manifest.sceneTreeOperations?.version, manifest.version);
    assert.equal(
      manifest.sceneTreeOperations?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
    assert.equal(manifest.sceneTreeOperations?.checks?.length, 5);
    const appearance = manifest.appearanceUpgrade;
    assert.equal(appearance?.fromVersion, "0.1.0-alpha.35");
    assert.equal(
      appearance.previousInstallerSha256,
      "a063382bc44bf4aad5ba70e731ab456a33f7ce4638d9d1f80cefb9ba41a6896a",
    );
    assert.equal(
      appearance.previousAsarSha256,
      "b3ade2abee031f9444cb51ec226df23740e5dca7d6d997009a64e7adc4b8a5f2",
    );
    assert.equal(appearance.appAsarSha256, manifest.imageStudio.appAsarSha256);
    assert.ok(appearance.upgradeMs > 0);
    assert.deepEqual(appearance.requests, { text: 0, image: 3 });
    assert.equal(appearance.checks.length, 5);
    assert.equal(appearance.previousV2Files.length, 3);
    assert.ok(appearance.appearanceFiles.length >= 3);
    for (const key of [
      "reviewedOldCandidateWithoutRequest",
      "credentialsPreserved",
      "profileBytesPreserved",
      "uninstallPreserved",
      "previousV2ReceiptPreserved",
      "previousV2Readable",
      "previousAdoptedAssetPreserved",
      "fixedAppearancePreserved",
      "fixedAppearancePreviewReadable",
      "lookDraftPreserved",
      "legacyDraftPreservedUntilExplicitSave",
      "explicitSchema1DraftCreated",
      "postUninstallDataReadable",
    ])
      assert.equal(appearance[key], true);
    for (const file of [
      ...appearance.previousV2Files,
      ...appearance.appearanceFiles,
    ]) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    }
    assert.match(appearance.newScene.diskHash, /^[a-f0-9]{64}$/);
    assert.match(appearance.lookDraftSha256, /^[a-f0-9]{64}$/);
    assert.match(appearance.oldMaterialDraftSha256, /^[a-f0-9]{64}$/);
  }
  if (milestone >= 37) {
    assert.equal(manifest.importBoundary?.version, manifest.version);
    assert.equal(
      manifest.importBoundary?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
    assert.equal(manifest.importBoundary?.checks?.length, 3);
    assert.deepEqual(manifest.importBoundary?.encodings, [
      "utf-8",
      "utf-16le",
      "utf-16be",
      "gb18030",
    ]);
    assert.equal(manifest.importReview?.version, manifest.version);
    assert.equal(
      manifest.importReview?.appAsarSha256,
      manifest.imageStudio.appAsarSha256,
    );
    assert.equal(manifest.importReview?.checks?.length, 4);
    const scene = manifest.sceneUpgrade;
    assert.equal(scene?.fromVersion, "0.1.0-alpha.36");
    assert.equal(
      scene.previousInstallerSha256,
      "50425dd87f735bfda379863e1844d6846632ceafe70611a575743cfa58ecb3d3",
    );
    assert.equal(
      scene.previousAsarSha256,
      "6684495567bd9d2a0c057277e3877905deaeba448fbd478cbc48601c6425421c",
    );
    assert.equal(scene.appAsarSha256, manifest.imageStudio.appAsarSha256);
    assert.equal(scene.originalMaterialDraftSchema, 1);
    assert.ok(scene.sceneTreeReadbacks >= 3);
    assert.ok(Number.isSafeInteger(scene.sceneTreeReadbacks));
    assert.match(scene.plannedScene.id, /^[a-f0-9-]{36}$/);
    assert.match(scene.plannedScene.chapterId, /^[a-f0-9-]{36}$/);
    assert.ok(
      Number.isSafeInteger(scene.plannedScene.planningRevision) &&
        scene.plannedScene.planningRevision > 0,
    );
    assert.match(scene.plannedScene.diskHash, /^[a-f0-9]{64}$/);
    assert.match(scene.plannedScene.planningHash, /^[a-f0-9]{64}$/);
    assert.match(scene.newScene.id, /^[a-f0-9-]{36}$/);
    assert.ok(
      Number.isSafeInteger(scene.newScene.revision) &&
        scene.newScene.revision > 0,
    );
    assert.ok(scene.upgradeMs > 0);
    assert.equal(scene.checks?.length, 6);
    assert.deepEqual(scene.requests, { text: 0, image: 3 });
    for (const key of [
      "plannedScenePreserved",
      "schema1DraftPreservedUntilExplicitSave",
      "fixedAppearancePreserved",
      "fixedAppearancePreviewReadable",
      "postUninstallDataReadable",
      "uninstallPreserved",
      "previousV2Readable",
      "previousV2ReceiptPreserved",
      "previousAdoptedAssetPreserved",
      "lookDraftPreserved",
      "reviewedOldCandidateWithoutRequest",
      "credentialsPreserved",
      "profileBytesPreserved",
      "explicitSchema1DraftCreated",
    ])
      assert.equal(scene[key], true);
    assert.equal(scene.sceneFiles?.length, 2);
    assert.equal(scene.previousV2Files?.length, 3);
    assert.ok(scene.appearanceFiles?.length >= 3);
    for (const file of [
      ...scene.sceneFiles,
      ...scene.previousV2Files,
      ...scene.appearanceFiles,
    ]) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    }
    assert.equal(
      scene.sceneFiles.find((file) => file.name === "planning.json")?.sha256,
      scene.plannedScene.planningHash,
    );
    assert.equal(
      scene.sceneFiles.find(
        (file) => file.name === `${scene.plannedScene.id}.json`,
      )?.sha256,
      scene.plannedScene.diskHash,
    );
    assert.match(scene.newScene.diskHash, /^[a-f0-9]{64}$/);
    assert.match(scene.lookDraftSha256, /^[a-f0-9]{64}$/);
    assert.match(scene.oldMaterialDraftSha256, /^[a-f0-9]{64}$/);
  }
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
    anonymouslyVisible: true,
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
