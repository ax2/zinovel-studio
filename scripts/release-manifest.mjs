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
const appAsarSha256 = createHash("sha256")
  .update(await readFile(new URL("win-unpacked/resources/app.asar", release)))
  .digest("hex");
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
await writeFile(new URL("SHA256SUMS.txt", release), `${sha256}  ${name}\n`);
await writeFile(
  new URL("release-manifest.json", release),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
