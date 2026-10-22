import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
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
  harness: pkg.dependencies["@deepseek-ai/dsh"],
  qualification: smoke.checks,
  generatedAt: new Date().toISOString(),
};
await writeFile(new URL("SHA256SUMS.txt", release), `${sha256}  ${name}\n`);
await writeFile(
  new URL("release-manifest.json", release),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
