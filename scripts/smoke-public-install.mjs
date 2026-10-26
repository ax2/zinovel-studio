import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  readdir,
  access,
  cp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { waitForCondition } from "./windows-installer-observation.mjs";
// Run only after independently downloading and verifying the immutable public release.
const root = resolve(import.meta.dirname, ".."),
  version = process.argv[2];
if (
  process.platform !== "win32" ||
  !/^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/.test(version || "") ||
  !process.argv[3]
)
  throw Error(
    "Usage on Windows: node scripts/smoke-public-install.mjs VERSION RETAINED_PUBLIC_DIRECTORY",
  );
const base = join(root, `assessments/release/v${version}/ci-public`),
  archive = resolve(process.argv[3]),
  run = promisify(execFile);
const read = async (p) =>
  JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/, ""));
const verification = await read(join(base, "verification.json")),
  manifest = await read(join(base, "release-manifest.json"));
assert.equal(verification.status, "passed");
assert.equal(manifest.version, version);
assert.equal(
  manifest.installer,
  `ZiNovel-Studio-${version}-windows-x64-setup.exe`,
);
assert.equal(verification.tag, `v${version}`);
assert.equal(verification.sha256, manifest.sha256);
assert.equal(verification.bytes, manifest.bytes);
assert.equal(verification.downloadedInstallerSha256Verified, true);
assert.equal(verification.metadataDigestsVerified, true);
assert.equal(verification.anonymouslyVisible, true);
const setup = join(archive, manifest.installer),
  hash = async (p) =>
    createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
assert.equal(await hash(setup), manifest.sha256);
const registry =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a";
try {
  await run("reg.exe", ["query", registry], { windowsHide: true });
  throw Error("An existing install must not be replaced");
} catch (e) {
  if (e.code !== 1) throw e;
}
const work = await mkdtemp(join(root, ".cache", "public-install-")),
  install = join(work, "公开 中文安装目录"),
  executable = join(install, "ZiNovel Studio.exe");
const options = {
  cwd: work,
  windowsHide: true,
  timeout: 600000,
  maxBuffer: 4 * 1024 * 1024,
};
const report = {
  status: "running",
  version,
  installerSha256: manifest.sha256,
  appAsarSha256: manifest.imageStudio.appAsarSha256,
  checks: [],
};
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
assert.equal(
  await exists(join(archive, "win-installed")),
  false,
  "Previously retained public runtime must not be replaced",
);
let installed = false,
  removed = false;
async function uninstall() {
  const names = await readdir(install),
    name = names.find((n) => /^Uninstall .*\.exe$/i.test(n));
  assert.ok(name);
  await run(join(install, name), ["/S", "/currentuser"], options);
  report.executableRemoval = await waitForCondition(
    async () => !(await exists(executable)),
    "Public EXE was not removed",
  );
  report.registryRemoval = await waitForCondition(async () => {
    try {
      await run("reg.exe", ["query", registry], { windowsHide: true });
      return false;
    } catch (e) {
      if (e.code === 1) return true;
      throw e;
    }
  }, "Public install registration was not removed");
  removed = true;
}
try {
  const started = Date.now();
  await run(setup, ["/S", `/D=${install}`], options);
  installed = true;
  await waitForCondition(
    () => exists(executable),
    "Public executable not installed",
  );
  report.installMs = Date.now() - started;
  assert.equal(
    await hash(join(install, "resources/app.asar")),
    manifest.imageStudio.appAsarSha256,
  );
  const p = await run(
    executable,
    [
      "-e",
      'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))',
      join(install, "resources/app.asar/package.json"),
    ],
    { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  assert.equal(JSON.parse(p.stdout).version, version);
  report.checks.push(
    "Actual independently downloaded public NSIS installs to a Chinese/space directory; installed manifest version and complete asar SHA match the public CI manifest",
  );
  const result = await run(
    process.execPath,
    [join(root, "scripts/smoke-desktop.mjs")],
    {
      ...options,
      timeout: 240000,
      env: {
        ...process.env,
        ZINOVEL_TEST_EXECUTABLE: executable,
        ZINOVEL_QA_STAGE: `release/v${version}/ci-public/desktop`,
      },
    },
  );
  await writeFile(
    join(base, "installed-desktop.txt"),
    result.stdout + result.stderr,
  );
  const desktop = await read(
    join(
      root,
      `screenshots/release/v${version}/ci-public/desktop/desktop-smoke.json`,
    ),
  );
  assert.equal(desktop.status, "passed");
  assert.equal(desktop.checks.length, 11);
  await writeFile(
    join(base, "desktop-smoke.json"),
    JSON.stringify(desktop, null, 2) + "\n",
  );
  report.checks.push(...desktop.checks);
  const library = join(desktop.dataDirectory, "library"),
    bodies = [];
  for (const book of await readdir(library, { withFileTypes: true }))
    if (book.isDirectory() && /^[a-f0-9-]{36}$/.test(book.name)) {
      const dir = join(library, book.name, "manuscript");
      for (const name of await readdir(dir))
        if (/^[a-f0-9-]{36}\.md$/.test(name))
          bodies.push({
            path: join(dir, name),
            sha256: await hash(join(dir, name)),
          });
    }
  assert.ok(bodies.length > 0);
  const retained = join(archive, "win-installed");
  await cp(install, retained, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  assert.equal(
    await hash(join(retained, "resources/app.asar")),
    manifest.imageStudio.appAsarSha256,
  );
  report.retainedRuntime = retained;
  const startedUninstall = Date.now();
  await uninstall();
  report.uninstallMs = Date.now() - startedUninstall;
  for (const item of bodies) assert.equal(await hash(item.path), item.sha256);
  report.preservedManuscripts = bodies.length;
  report.checks.push(
    "Exact public installed runtime retained without ZIP; actual uninstall removes executable/registration and preserves all synthetic manuscript hashes",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  throw e;
} finally {
  try {
    if (installed && !removed) await uninstall();
  } catch (e) {
    report.status = "failed";
    report.cleanupFailure = String(e);
  }
  await mkdir(base, { recursive: true });
  await writeFile(
    join(base, "public-install.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
  if (report.status !== "passed") process.exitCode = 1;
}
