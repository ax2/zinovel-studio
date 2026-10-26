import { createHash } from "node:crypto";
const hashIsValid = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Shared validation for actual pinned source installers with schema1 origin records. */
export function validateOriginUpgrade(
  originUpgrade,
  originSource,
  target,
  fromVersion,
) {
  const { sha256, appAsarSha256 } = target;
  const originalOrigin = originUpgrade.originalImportOrigin;
  const originFlags = [
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
    "explicitSchema1DraftCreated",
    "postUninstallDataReadable",
    "schema1DraftPreservedUntilExplicitSave",
    "plannedScenePreserved",
    "legacyImportPreserved",
    "importOriginPreserved",
  ];
  if (
    originUpgrade.status !== "passed" ||
    originUpgrade.fromVersion !== fromVersion ||
    originUpgrade.toVersion === fromVersion ||
    originSource.version !== originUpgrade.fromVersion ||
    originUpgrade.toVersion !== target.version ||
    originUpgrade.currentInstallerSha256 !== sha256 ||
    originUpgrade.appAsarSha256 !== appAsarSha256 ||
    originUpgrade.previousInstallerSha256 !== originSource.sha256 ||
    originUpgrade.previousAsarSha256 !==
      originSource.imageStudio.appAsarSha256 ||
    originUpgrade.checks?.length !== 8 ||
    originUpgrade.errors?.length !== 0 ||
    !originFlags.every((key) => originUpgrade[key] === true) ||
    !Number.isSafeInteger(originUpgrade.originReadbacks) ||
    originUpgrade.originReadbacks < 3 ||
    !Number.isSafeInteger(originUpgrade.legacyImportReadbacks) ||
    originUpgrade.legacyImportReadbacks < 3 ||
    !Number.isSafeInteger(originUpgrade.sceneTreeReadbacks) ||
    originUpgrade.sceneTreeReadbacks < 3 ||
    originUpgrade.originalMaterialDraftSchema !== 1 ||
    !Number.isFinite(originUpgrade.upgradeMs) ||
    originUpgrade.upgradeMs <= 0 ||
    JSON.stringify(originUpgrade.requests) !==
      JSON.stringify({ text: 0, image: 3 }) ||
    originalOrigin?.schemaVersion !== 1 ||
    originalOrigin.applicationVersion !== originSource.version ||
    originalOrigin.importedBookId !== originUpgrade.legacyImportedBook?.id ||
    originalOrigin.originalChapterCount !== 2 ||
    originalOrigin.manualAdjustmentCount !== 2 ||
    originalOrigin.encoding !== "utf-8" ||
    originalOrigin.automaticSplit !== true ||
    !Number.isFinite(Date.parse(originalOrigin.importedAt)) ||
    !/^[a-f0-9-]{36}$/.test(originalOrigin.importedBookId || "") ||
    originalOrigin.sources?.length !== 1 ||
    originalOrigin.chapters?.length !== 3 ||
    originUpgrade.legacyImportedBook?.chapterIds?.length !== 3 ||
    new Set(originUpgrade.legacyImportedBook?.chapterIds).size !== 3 ||
    originUpgrade.legacyImportedBook?.chapterHashes?.length !== 3 ||
    !originalOrigin.sources.every(
      (source) =>
        hashIsValid(source.sha256) &&
        Number.isSafeInteger(source.bytes) &&
        source.bytes > 0,
    ) ||
    !originalOrigin.chapters.every(
      (chapter, index) =>
        /^[a-f0-9-]{36}$/.test(chapter.id || "") &&
        chapter.id === originUpgrade.legacyImportedBook?.chapterIds?.[index] &&
        hashIsValid(chapter.sha256) &&
        chapter.sha256 ===
          originUpgrade.legacyImportedBook?.chapterHashes?.[index],
    ) ||
    originUpgrade.legacyImportFiles?.length !== 4 ||
    originUpgrade.originFiles?.length !== 1 ||
    originUpgrade.originFiles[0].name !== "import-origin.json" ||
    originUpgrade.originFiles[0].sha256 !==
      createHash("sha256")
        .update(JSON.stringify(originalOrigin, null, 2) + "\n")
        .digest("hex") ||
    originUpgrade.sceneFiles?.length !== 2 ||
    originUpgrade.previousV2Files?.length !== 3 ||
    !Array.isArray(originUpgrade.appearanceFiles) ||
    originUpgrade.appearanceFiles.length < 3 ||
    ![
      ...(originUpgrade.legacyImportFiles || []),
      ...(originUpgrade.originFiles || []),
      ...(originUpgrade.sceneFiles || []),
      ...(originUpgrade.previousV2Files || []),
      ...(originUpgrade.appearanceFiles || []),
    ].every(
      (file) =>
        hashIsValid(file.sha256) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0,
    ) ||
    !originUpgrade.legacyImportFiles.some(
      (file) => file.name === "book.json",
    ) ||
    !originalOrigin.chapters.every(
      (chapter) =>
        originUpgrade.legacyImportFiles.find(
          (file) => file.name === `${chapter.id}.md`,
        )?.sha256 === chapter.sha256,
    ) ||
    !hashIsValid(originUpgrade.plannedScene?.diskHash) ||
    !/^[a-f0-9-]{36}$/.test(originUpgrade.plannedScene?.id || "") ||
    !/^[a-f0-9-]{36}$/.test(originUpgrade.plannedScene?.chapterId || "") ||
    !Number.isSafeInteger(originUpgrade.plannedScene?.planningRevision) ||
    originUpgrade.plannedScene.planningRevision < 1 ||
    !hashIsValid(originUpgrade.plannedScene?.planningHash) ||
    originUpgrade.sceneFiles.find((file) => file.name === "planning.json")
      ?.sha256 !== originUpgrade.plannedScene.planningHash ||
    originUpgrade.sceneFiles.find(
      (file) => file.name === `${originUpgrade.plannedScene.id}.json`,
    )?.sha256 !== originUpgrade.plannedScene.diskHash ||
    !hashIsValid(originUpgrade.newScene?.diskHash) ||
    !/^[a-f0-9-]{36}$/.test(originUpgrade.newScene?.id || "") ||
    !Number.isSafeInteger(originUpgrade.newScene?.revision) ||
    originUpgrade.newScene.revision < 1 ||
    !hashIsValid(originUpgrade.lookDraftSha256) ||
    !hashIsValid(originUpgrade.oldMaterialDraftSha256)
  )
    throw new Error(
      "Pinned public original import-origin and exact manuscript upgrade proof is missing or stale",
    );
  return {
    fromVersion: originUpgrade.fromVersion,
    previousInstallerSha256: originUpgrade.previousInstallerSha256,
    previousAsarSha256: originUpgrade.previousAsarSha256,
    appAsarSha256,
    upgradeMs: originUpgrade.upgradeMs,
    ...Object.fromEntries(originFlags.map((key) => [key, true])),
    originReadbacks: originUpgrade.originReadbacks,
    legacyImportReadbacks: originUpgrade.legacyImportReadbacks,
    sceneTreeReadbacks: originUpgrade.sceneTreeReadbacks,
    originalMaterialDraftSchema: originUpgrade.originalMaterialDraftSchema,
    originalImportOrigin: originalOrigin,
    originFiles: originUpgrade.originFiles,
    legacyImportedBook: originUpgrade.legacyImportedBook,
    legacyImportFiles: originUpgrade.legacyImportFiles,
    plannedScene: originUpgrade.plannedScene,
    sceneFiles: originUpgrade.sceneFiles,
    previousV2Files: originUpgrade.previousV2Files,
    appearanceFiles: originUpgrade.appearanceFiles,
    newScene: originUpgrade.newScene,
    lookDraftSha256: originUpgrade.lookDraftSha256,
    oldMaterialDraftSha256: originUpgrade.oldMaterialDraftSha256,
    requests: originUpgrade.requests,
    checks: originUpgrade.checks,
    scope: originUpgrade.scope,
  };
}
