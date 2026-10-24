const path = require("node:path");

module.exports = {
  appId: "com.zicode.zinovelstudio",
  productName: "ZiNovel Studio",
  copyright: "Copyright © 2026 ZiNovel Studio contributors",
  directories: { output: "release", buildResources: "assets/app" },
  // Electron's Node mode supports ASAR ESM loading. Native modules and external
  // executables are automatically unpacked by electron-builder.
  asar: true,
  npmRebuild: false,
  allowMissingDependencies: false,
  electronDist: path.dirname(require("electron")),
  files: [
    "dist/desktop/main.cjs",
    "dist/desktop/preload.cjs",
    "dist/workbench/**/*",
    "dist/resources/**/*",
    "package.json",
    "LICENSE",
    "NOTICE",
    "licenses/**/*",
    "apps/desktop/upstream/LICENSE",
  ],
  extraMetadata: { author: "ZiNovel Studio contributors" },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    executableName: "ZiNovel Studio",
    icon: "assets/app/icon.ico",
  },
  nsis: {
    guid: "81b55339-fc21-4fe7-949e-a90dc443ef5a",
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    installerLanguages: ["en_US", "zh_CN"],
    artifactName: "ZiNovel-Studio-${version}-windows-${arch}-setup.exe",
  },
  publish: null,
};
