import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const name = `ZiNovel-Studio-${pkg.version}-windows-x64-setup.exe`;
const release = new URL("release/", root);
const installer = new URL(name, release);
const sha256 = createHash("sha256")
  .update(await readFile(installer))
  .digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const smoke = JSON.parse(
  await readFile(
    new URL("screenshots/release/installer-smoke.json", root),
    "utf8",
  ),
);
if (
  smoke.status !== "passed" ||
  smoke.version !== pkg.version ||
  smoke.installerSha256 !== sha256
)
  throw new Error(
    "Installer has not passed the exact-version, exact-bytes installation test",
  );
const manifest = {
  product: "ZiNovel Studio",
  version: pkg.version,
  commit,
  platform: "win32",
  arch: "x64",
  installer: name,
  bytes: (await stat(installer)).size,
  sha256,
  signature: "unsigned-preview",
  electron: pkg.devDependencies.electron,
  embeddedNode: JSON.parse(
    await readFile(
      new URL("screenshots/release/installed/desktop-smoke.json", root),
      "utf8",
    ),
  ).runtime.node,
  harness: pkg.dependencies["@deepseek-ai/dsh"],
  qualification: smoke.checks,
  generatedAt: new Date().toISOString(),
};
const imageRuntime = JSON.parse(
  await readFile(new URL("image-runtime-verification.json", release), "utf8"),
);
const taskRecovery = JSON.parse(
  await readFile(
    new URL("screenshots/release/installed/tasks/task-smoke.json", root),
    "utf8",
  ),
);
const appAsarSha256 = createHash("sha256")
  .update(await readFile(new URL("win-unpacked/resources/app.asar", release)))
  .digest("hex");
if (
  taskRecovery.status !== "passed" ||
  taskRecovery.version !== pkg.version ||
  taskRecovery.packaged !== true ||
  taskRecovery.appAsarSha256 !== appAsarSha256 ||
  taskRecovery.checks?.length !== 3 ||
  taskRecovery.termination?.handlePinned !== true ||
  taskRecovery.termination.birthPrecision !== "100ns" ||
  taskRecovery.termination.rootStatus !== "terminated" ||
  taskRecovery.termination.ownedProcessesConfirmedExited < 3
)
  throw new Error(
    "Installed pinned-handle task recovery proof is missing or stale",
  );
manifest.processRecovery = {
  version: taskRecovery.version,
  appAsarSha256,
  handlePinned: true,
  birthPrecision: "100ns",
  rootStatus: "terminated",
  originalProcessesConfirmedExited:
    taskRecovery.termination.ownedProcessesConfirmedExited,
  verification: taskRecovery.termination.verification,
};
const characterLooks = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/character-looks/character-looks-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  characterLooks.status !== "passed" ||
  characterLooks.version !== pkg.version ||
  characterLooks.packaged !== true ||
  characterLooks.appAsarSha256 !== appAsarSha256 ||
  characterLooks.checks?.length !== 4 ||
  characterLooks.errors?.length !== 0
)
  throw new Error(
    "Installed fixed character appearance and explicit portrait choice proof is missing or stale",
  );
manifest.characterLooks = {
  version: characterLooks.version,
  appAsarSha256,
  checks: characterLooks.checks,
  scope: characterLooks.scope,
};
if (
  imageRuntime.status !== "passed" ||
  imageRuntime.version !== pkg.version ||
  imageRuntime.sharp !== pkg.dependencies.sharp ||
  imageRuntime.appAsarSha256 !== appAsarSha256
)
  throw new Error("Packaged image runtime verification is missing or stale");
manifest.imageRuntime = imageRuntime;
const pdfPublication = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/publication-pdf/publication-pdf-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  pdfPublication.status !== "passed" ||
  pdfPublication.version !== pkg.version ||
  !/^[a-f0-9]{64}$/.test(pdfPublication.sha256 || "") ||
  !/^[a-f0-9]{64}$/.test(pdfPublication.snapshotHash || "") ||
  !Number.isSafeInteger(pdfPublication.bytes) ||
  pdfPublication.bytes < 10 ||
  !Array.isArray(pdfPublication.checks) ||
  pdfPublication.checks.length < 2
)
  throw new Error(
    "Installed PDF export independent verification is missing or stale",
  );
manifest.pdfPublication = {
  version: pdfPublication.version,
  snapshotHash: pdfPublication.snapshotHash,
  sha256: pdfPublication.sha256,
  bytes: pdfPublication.bytes,
  checks: pdfPublication.checks,
  scope:
    "Synthetic frozen selection exported by installed EXE; independent parser and PDFium, no professional print certification",
};
const docxPublication = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/publication-docx/publication-docx-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  docxPublication.status !== "passed" ||
  docxPublication.version !== pkg.version ||
  !/^[a-f0-9]{64}$/.test(docxPublication.sha256 || "") ||
  !/^[a-f0-9]{64}$/.test(docxPublication.snapshotHash || "") ||
  !Number.isSafeInteger(docxPublication.bytes) ||
  docxPublication.bytes < 10 ||
  docxPublication.reader?.backend !== "native" ||
  !Array.isArray(docxPublication.checks) ||
  docxPublication.checks.length < 2
)
  throw new Error(
    "Installed DOCX export independent verification is missing or stale",
  );
manifest.docxPublication = {
  version: docxPublication.version,
  snapshotHash: docxPublication.snapshotHash,
  sha256: docxPublication.sha256,
  bytes: docxPublication.bytes,
  reader: docxPublication.reader,
  checks: docxPublication.checks,
  scope:
    "Actual installed host export; editable OOXML and native development-only LibreOffice reader; no installed Word claim",
};
const imagePublication = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/publication-resources/publication-resources-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  imagePublication.status !== "passed" ||
  imagePublication.version !== pkg.version ||
  !/^[a-f0-9]{64}$/.test(imagePublication.snapshotHash) ||
  !Array.isArray(imagePublication.imageFiles) ||
  imagePublication.imageFiles.length !== 2 ||
  !imagePublication.imageFiles.every(
    (item) =>
      item.path === `images/${item.sha256}.png` &&
      /^[a-f0-9]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.bytes) &&
      item.bytes > 0,
  ) ||
  !Array.isArray(imagePublication.checks) ||
  imagePublication.checks.length !== 4
)
  throw new Error(
    "Installed frozen image publication proof is missing or stale",
  );
manifest.imagePublication = {
  version: imagePublication.version,
  snapshotHash: imagePublication.snapshotHash,
  images: imagePublication.imageFiles,
  checks: imagePublication.checks,
  scope: imagePublication.scope,
};
const offlineWriting = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/offline-writing/offline-writing-smoke.json",
      root,
    ),
    "utf8",
  ),
);
const readingLayout = offlineWriting.readingLayout;
const readableParagraph = readingLayout?.paragraph;
const readingViewport = readingLayout?.viewport;
if (
  offlineWriting.status !== "passed" ||
  offlineWriting.version !== pkg.version ||
  offlineWriting.switchedTaskStatus !== "cancelled" ||
  offlineWriting.failedTaskStatus !== "failed" ||
  offlineWriting.foreignBookTextSent !== false ||
  offlineWriting.rendererRequestsDenied !== 1 ||
  offlineWriting.providerRequests < 2 ||
  readingLayout?.horizontalOverflow !== false ||
  !Number.isFinite(readingLayout?.layout?.height) ||
  readingLayout.layout.height <= 100 ||
  ![
    readableParagraph?.left,
    readableParagraph?.right,
    readableParagraph?.top,
    readableParagraph?.bottom,
    readableParagraph?.width,
    readingViewport?.width,
    readingViewport?.height,
  ].every(Number.isFinite) ||
  readableParagraph.width < 200 ||
  readableParagraph.left < 0 ||
  readableParagraph.right > readingViewport.width ||
  readableParagraph.top < 0 ||
  readableParagraph.bottom > readingViewport.height ||
  !Array.isArray(offlineWriting.errors) ||
  offlineWriting.errors.length !== 0 ||
  !Array.isArray(offlineWriting.checks) ||
  offlineWriting.checks.length !== 4
)
  throw new Error("Installed offline writing proof is missing or stale");
manifest.offlineWriting = {
  version: offlineWriting.version,
  readingLayout,
  checks: offlineWriting.checks,
  scope: offlineWriting.scope,
};
const backupBoundary = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/independent-backup/independent-backup-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  backupBoundary.status !== "passed" ||
  backupBoundary.version !== pkg.version ||
  backupBoundary.packaged !== true ||
  backupBoundary.appAsarSha256 !== appAsarSha256 ||
  backupBoundary.backupFiles !== 10 ||
  !/^[a-f0-9]{64}$/.test(backupBoundary.backupManifestSha256 || "") ||
  !Array.isArray(backupBoundary.checks) ||
  backupBoundary.checks.length !== 4 ||
  !Array.isArray(backupBoundary.errors) ||
  backupBoundary.errors.length !== 0 ||
  !Number.isInteger(backupBoundary.sourceDisk?.DiskNumber) ||
  !Number.isInteger(backupBoundary.backupDisk?.DiskNumber) ||
  backupBoundary.independentDisks !==
    (backupBoundary.sourceDisk.DiskNumber !==
      backupBoundary.backupDisk.DiskNumber)
)
  throw new Error("Installed backup boundary proof is missing or stale");
manifest.backupBoundary = {
  version: backupBoundary.version,
  appAsarSha256: backupBoundary.appAsarSha256,
  independentDisks: backupBoundary.independentDisks,
  sourceDisk: backupBoundary.sourceDisk,
  backupDisk: backupBoundary.backupDisk,
  backupFiles: backupBoundary.backupFiles,
  checks: backupBoundary.checks,
  scope: backupBoundary.scope,
};
const incrementalBackup = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/incremental-backup/incremental-backup-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  incrementalBackup.status !== "passed" ||
  incrementalBackup.version !== pkg.version ||
  incrementalBackup.packaged !== true ||
  incrementalBackup.appAsarSha256 !== appAsarSha256 ||
  incrementalBackup.checks?.length !== 4 ||
  incrementalBackup.errors?.length !== 0 ||
  incrementalBackup.manifests?.length !== 3 ||
  incrementalBackup.geometry?.scrollWidth >
    incrementalBackup.geometry?.clientWidth + 1
)
  throw new Error("Installed incremental backup proof is missing or stale");
manifest.incrementalBackup = {
  version: incrementalBackup.version,
  appAsarSha256: incrementalBackup.appAsarSha256,
  independentDisks: incrementalBackup.independentDisks,
  sourceDisk: incrementalBackup.sourceDisk,
  backupDisk: incrementalBackup.backupDisk,
  checks: incrementalBackup.checks,
  scope: incrementalBackup.scope,
};
const diagnostics = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/diagnostics/diagnostics-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  diagnostics.status !== "passed" ||
  diagnostics.version !== pkg.version ||
  diagnostics.packaged !== true ||
  diagnostics.appAsarSha256 !== appAsarSha256 ||
  diagnostics.errors?.length !== 0 ||
  diagnostics.checks?.length !== 3 ||
  !Number.isSafeInteger(diagnostics.exportBytes) ||
  diagnostics.exportBytes < 1
)
  throw new Error("Installed diagnostic privacy proof is missing or stale");
manifest.diagnostics = {
  version: diagnostics.version,
  appAsarSha256: diagnostics.appAsarSha256,
  checks: diagnostics.checks,
  scope: diagnostics.scope,
};
const modelCredentials = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/model-credentials/model-credentials-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  modelCredentials.status !== "passed" ||
  modelCredentials.version !== pkg.version ||
  modelCredentials.packaged !== true ||
  modelCredentials.appAsarSha256 !== appAsarSha256 ||
  modelCredentials.oldCredentialForwarded !== false ||
  modelCredentials.newCredentialRequests !== 3 ||
  modelCredentials.errors?.length !== 0 ||
  modelCredentials.checks?.length !== 3
)
  throw new Error(
    "Installed service credential isolation proof is missing or stale",
  );
manifest.modelCredentials = {
  version: modelCredentials.version,
  appAsarSha256: modelCredentials.appAsarSha256,
  oldCredentialForwarded: false,
  checks: modelCredentials.checks,
  scope: modelCredentials.scope,
};
const modelProfiles = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/model-profiles/model-profiles-smoke.json",
      root,
    ),
    "utf8",
  ),
);
const imageStudio = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/installed/image-studio/image-studio-smoke.json",
      root,
    ),
    "utf8",
  ),
);
if (
  imageStudio.status !== "passed" ||
  imageStudio.version !== pkg.version ||
  imageStudio.packaged !== true ||
  imageStudio.appAsarSha256 !== appAsarSha256 ||
  imageStudio.errors?.length !== 0 ||
  imageStudio.checks?.length !== 11 ||
  JSON.stringify(imageStudio.requests) !== JSON.stringify([0, 9, 0]) ||
  imageStudio.closeProtected !== true ||
  imageStudio.remoteUnknownAfterRestart !== true ||
  imageStudio.retainedSaveRecoveredLocally !== true ||
  imageStudio.originalsPreserved !== true ||
  imageStudio.mixedBatchRecovery !== true ||
  imageStudio.crashCredentialsRetained !== true ||
  imageStudio.characterTargetVersionChecked !== true ||
  imageStudio.chapterTargetVersionChecked !== true ||
  imageStudio.rendererRecoveryRetainsPaidResult !== true ||
  imageStudio.reviewedTargetAdoption !== true ||
  imageStudio.reviewedChapterAdoption !== true ||
  imageStudio.reviewedTargetNarrowConfirmation !== true
)
  throw new Error("Installed image author workflow proof is missing or stale");
manifest.imageStudio = {
  version: imageStudio.version,
  appAsarSha256: imageStudio.appAsarSha256,
  checks: imageStudio.checks,
  scope: imageStudio.scope,
  requests: imageStudio.requests,
  closeProtected: true,
  remoteUnknownAfterRestart: true,
  retainedSaveRecoveredLocally: true,
  originalsPreserved: true,
  mixedBatchRecovery: true,
  crashCredentialsRetained: true,
  characterTargetVersionChecked: true,
  chapterTargetVersionChecked: true,
  rendererRecoveryRetainsPaidResult: true,
  reviewedTargetAdoption: true,
  reviewedChapterAdoption: true,
  reviewedTargetNarrowConfirmation: true,
};
if (
  modelProfiles.status !== "passed" ||
  modelProfiles.version !== pkg.version ||
  modelProfiles.packaged !== true ||
  modelProfiles.appAsarSha256 !== appAsarSha256 ||
  modelProfiles.errors?.length !== 0 ||
  modelProfiles.checks?.length !== 6 ||
  modelProfiles.newCredentialEnvelope !== "win-dpapi-v1" ||
  modelProfiles.legacyCipherAfterRestart !== true ||
  JSON.stringify(modelProfiles.requests) !== JSON.stringify([3, 6, 0])
)
  throw new Error(
    "Installed independent model profile proof is missing or stale",
  );
manifest.modelProfiles = {
  newCredentialEnvelope: modelProfiles.newCredentialEnvelope,
  legacyCipherAfterRestart: true,
  version: modelProfiles.version,
  appAsarSha256: modelProfiles.appAsarSha256,
  checks: modelProfiles.checks,
  scope: modelProfiles.scope,
  requests: modelProfiles.requests,
};
const upgrade = JSON.parse(
  await readFile(
    new URL("screenshots/release/upgrade/upgrade-smoke.json", root),
    "utf8",
  ),
);
if (
  upgrade.status !== "passed" ||
  upgrade.toVersion !== pkg.version ||
  upgrade.currentInstallerSha256 !== sha256
)
  throw new Error(
    "Installer has not passed the exact-bytes cross-version upgrade test",
  );
manifest.upgrade = {
  fromVersion: upgrade.fromVersion,
  previousInstallerSha256: upgrade.previousInstallerSha256,
  upgradeMs: upgrade.upgradeMs,
};
manifest.qualification.push(
  ...upgrade.checks.map((check) => `upgrade: ${check}`),
);
const recent = JSON.parse(
    await readFile(
      new URL(
        "screenshots/release/recent-upgrade/recent-upgrade-smoke.json",
        root,
      ),
      "utf8",
    ),
  ),
  previousPublic = JSON.parse(
    await readFile(
      new URL(
        "assessments/release/v0.1.0-alpha.31/ci-public/release-manifest.json",
        root,
      ),
      "utf8",
    ),
  );
if (
  recent.status !== "passed" ||
  recent.fromVersion !== previousPublic.version ||
  recent.toVersion !== pkg.version ||
  recent.currentInstallerSha256 !== sha256 ||
  recent.previousInstallerSha256 !== previousPublic.sha256 ||
  recent.appAsarSha256 !== appAsarSha256 ||
  recent.previousAsarSha256 !== previousPublic.imageStudio.appAsarSha256 ||
  recent.errors?.length !== 0 ||
  recent.checks?.length !== 3 ||
  !Number.isFinite(recent.upgradeMs) ||
  recent.upgradeMs <= 0 ||
  recent.reviewedOldCandidateWithoutRequest !== true ||
  recent.credentialsPreserved !== true ||
  recent.profileBytesPreserved !== true ||
  recent.uninstallPreserved !== true ||
  JSON.stringify(recent.requests) !== JSON.stringify({ text: 0, image: 2 })
)
  throw new Error(
    "Recent public-version encrypted profile and image-task upgrade proof is missing or stale",
  );
manifest.recentUpgrade = {
  fromVersion: recent.fromVersion,
  previousInstallerSha256: recent.previousInstallerSha256,
  upgradeMs: recent.upgradeMs,
  appAsarSha256: recent.appAsarSha256,
  reviewedOldCandidateWithoutRequest: true,
  credentialsPreserved: true,
  profileBytesPreserved: true,
  uninstallPreserved: true,
  requests: recent.requests,
  checks: recent.checks,
  scope: recent.scope,
};
manifest.qualification.push(
  ...recent.checks.map((check) => `recent-upgrade: ${check}`),
);
const currentPublic = JSON.parse(
  await readFile(
    new URL(
      "screenshots/release/current-upgrade/recent-upgrade-smoke.json",
      root,
    ),
    "utf8",
  ),
);
const currentSource = JSON.parse(
  await readFile(
    new URL(
      "assessments/release/v0.1.0-alpha.33/ci-public/release-manifest.json",
      root,
    ),
    "utf8",
  ),
);
if (
  currentPublic.status !== "passed" ||
  currentPublic.fromVersion !== currentSource.version ||
  currentPublic.toVersion !== pkg.version ||
  currentPublic.currentInstallerSha256 !== sha256 ||
  currentPublic.previousInstallerSha256 !== currentSource.sha256 ||
  currentPublic.previousAsarSha256 !==
    currentSource.imageStudio.appAsarSha256 ||
  currentPublic.appAsarSha256 !== appAsarSha256 ||
  currentPublic.errors?.length !== 0 ||
  currentPublic.checks?.length !== 3 ||
  !Number.isFinite(currentPublic.upgradeMs) ||
  currentPublic.upgradeMs <= 0 ||
  JSON.stringify(currentPublic.requests) !==
    JSON.stringify({ text: 0, image: 3 }) ||
  ![
    "reviewedOldCandidateWithoutRequest",
    "credentialsPreserved",
    "profileBytesPreserved",
    "uninstallPreserved",
    "previousV2ReceiptPreserved",
    "previousV2Readable",
    "previousAdoptedAssetPreserved",
  ].every((key) => currentPublic[key] === true) ||
  currentPublic.previousV2Files?.length !== 3 ||
  !currentPublic.previousV2Files.every(
    (file) =>
      /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isSafeInteger(file.bytes) &&
      file.bytes > 0,
  )
)
  throw new Error(
    "Current public-version v1 candidate and actual v2 receipt/asset upgrade proof is missing or stale",
  );
manifest.currentPublicUpgrade = {
  fromVersion: currentPublic.fromVersion,
  previousInstallerSha256: currentPublic.previousInstallerSha256,
  previousAsarSha256: currentPublic.previousAsarSha256,
  appAsarSha256,
  upgradeMs: currentPublic.upgradeMs,
  requests: currentPublic.requests,
  reviewedOldCandidateWithoutRequest: true,
  credentialsPreserved: true,
  profileBytesPreserved: true,
  uninstallPreserved: true,
  previousV2ReceiptPreserved: true,
  previousV2Readable: true,
  previousAdoptedAssetPreserved: true,
  previousV2Files: currentPublic.previousV2Files,
  checks: currentPublic.checks,
  scope: currentPublic.scope,
};
manifest.qualification.push(
  ...currentPublic.checks.map((check) => `current-public-upgrade: ${check}`),
);
await writeFile(new URL("SHA256SUMS.txt", release), `${sha256}  ${name}\n`);
await writeFile(
  new URL("release-manifest.json", release),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
