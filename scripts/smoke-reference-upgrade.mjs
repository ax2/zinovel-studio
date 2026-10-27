import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  access,
  cp,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
import { waitForCondition } from "./windows-installer-observation.mjs";

if (process.platform !== "win32" || !process.argv[2] || !process.argv[3])
  throw new Error(
    "Usage: node scripts/smoke-reference-upgrade.mjs PUBLIC40_EXE PUBLIC40_MANIFEST",
  );
const root = resolve(import.meta.dirname, ".."),
  run = promisify(execFile),
  pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const source = JSON.parse(await readFile(resolve(process.argv[3]), "utf8")),
  pinned = JSON.parse(
    await readFile(
      join(
        root,
        "assessments/release/v0.1.0-alpha.40/ci-public/release-manifest.json",
      ),
      "utf8",
    ),
  );
const hash = (v) => createHash("sha256").update(v).digest("hex"),
  fileHash = async (p) => hash(await readFile(p));
const oldInstaller = resolve(process.argv[2]),
  newInstaller = join(
    root,
    "release",
    `ZiNovel-Studio-${pkg.version}-windows-x64-setup.exe`,
  ),
  currentAsar = await fileHash(
    join(root, "release/win-unpacked/resources/app.asar"),
  );
assert.equal(source.version, "0.1.0-alpha.40");
assert.equal(source.sha256, pinned.sha256);
assert.equal(basename(oldInstaller), source.installer);
assert.equal(await fileHash(oldInstaller), source.sha256);
const registry =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a";
async function registered() {
  try {
    await run("reg.exe", ["query", registry], { windowsHide: true });
    return true;
  } catch (e) {
    if (e.code === 1) return false;
    throw e;
  }
}
assert.equal(
  await registered(),
  false,
  "Refusing to replace an existing user installation",
);
const work = await mkdtemp(join(root, ".cache/reference-upgrade-")),
  install = join(work, "中文 参考编辑升级"),
  exe = join(install, "ZiNovel Studio.exe"),
  out = join(root, "screenshots/release/reference-upgrade");
await mkdir(out, { recursive: true });
const opts = {
  cwd: work,
  windowsHide: true,
  timeout: 600000,
  maxBuffer: 4 * 1024 * 1024,
};
let app, page, owned, observer, state, beforeFiles;
const report = {
  status: "running",
  fromVersion: source.version,
  toVersion: pkg.version,
  previousInstallerSha256: source.sha256,
  currentInstallerSha256: await fileHash(newInstaller),
  previousAsarSha256: source.referenceEditing.appAsarSha256,
  appAsarSha256: currentAsar,
  checks: [],
  errors: [],
  sourceRequests: 0,
  replayRequests: 0,
  readbacks: 0,
  scope:
    "Exact pinned public40 NSIS creates actual schema3 adopted/unknown edit tasks and schema2 draft through its own UI; current NSIS upgrade/restart/uninstall portable readback; synthetic keys/pictures, no real provider or downgrade claim",
};
async function close() {
  owned = await captureOwnedProcesses(app.process().pid);
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function launch(executable = exe) {
  const env = { ...process.env, ZINOVEL_DATA_ROOT: state.data };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
  app = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: work,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(runtime.version, pkg.version);
  assert.equal(runtime.packaged, true);
  assert.equal(await fileHash(runtime.path), currentAsar);
}
const host = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function inventory(base) {
  const result = [];
  async function walk(path, prefix = "") {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const p = prefix + e.name;
      assert.equal(e.isSymbolicLink(), false);
      if (e.isDirectory()) await walk(join(path, e.name), p + "/");
      else {
        assert.equal(e.isFile(), true);
        result.push({ path: p, sha256: await fileHash(join(path, e.name)) });
      }
    }
  }
  await walk(base);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function verify(label) {
  const bookRoot = join(state.data, "library", state.bookId);
  assert.deepEqual(await inventory(bookRoot), beforeFiles);
  assert.equal(
    await fileHash(join(state.data, "model-profiles.json")),
    report.profileSha256,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), state.draftKey),
    state.draftValue,
  );
  const adopted = await host("image.read", {
      bookId: state.bookId,
      id: state.adoptedTaskId,
    }),
    unknown = await host("image.read", {
      bookId: state.bookId,
      id: state.unknownTaskId,
    });
  assert.equal(adopted.schemaVersion, 3);
  assert.equal(adopted.candidates[0].decision, "accepted");
  assert.equal(unknown.schemaVersion, 3);
  assert.equal(unknown.status, "remote-unknown");
  for (const task of [adopted, unknown]) {
    const preview = await host("image.reference-preview", {
      bookId: state.bookId,
      id: task.id,
    });
    assert.deepEqual(preview.reference, task.reference);
    assert.equal(
      hash(Buffer.from(preview.dataUrl.split(",")[1], "base64")),
      task.reference.derivative.sha256,
    );
  }
  await page
    .locator(".book-card")
    .filter({ hasText: "参考编辑合成验收" })
    .click();
  await page.getByRole("button", { name: "AI 图像", exact: true }).click();
  const panel = page.getByRole("dialog", {
    name: "AI 图像工作室",
    exact: true,
  });
  await panel.locator(`[data-task-id="${state.unknownTaskId}"]`).click();
  await panel.getByText("远端结果未知。", { exact: false }).waitFor();
  const image = panel.getByRole("img", { name: "本次固定参考图", exact: true });
  await image.waitFor();
  await image.evaluate((img) => img.decode());
  assert.equal(report.replayRequests, 0);
  await page.screenshot({ path: join(out, `${label}.png`) });
  report.readbacks++;
}
async function uninstallOwned() {
  const name = (await readdir(install)).find((n) =>
    /^Uninstall .*\.exe$/i.test(n),
  );
  assert.ok(name);
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a').UninstallString | ConvertTo-Json -Compress",
    ],
    { windowsHide: true },
  );
  const registeredPath = JSON.parse(
      result.stdout.replace(/^\uFEFF/, "").trim(),
    ),
    match = /^"([^"]+)"|^(.+?\.exe)(?:\s|$)/i.exec(registeredPath);
  assert.equal(
    resolve(match?.[1] || match?.[2] || "").toLowerCase(),
    resolve(join(install, name)).toLowerCase(),
    "Refusing to uninstall another registered installation",
  );
  assert.ok(
    [report.previousAsarSha256, currentAsar].includes(
      await fileHash(join(install, "resources/app.asar")),
    ),
  );
  await run(join(install, name), ["/S", "/currentuser"], opts);
  await waitForCondition(
    async () => !(await registered()),
    "Reference upgrade registration remained",
  );
  await waitForCondition(async () => {
    try {
      await access(exe);
      return false;
    } catch (e) {
      if (e.code === "ENOENT") return true;
      throw e;
    }
  }, "Owned upgraded executable remained");
}
try {
  await run(oldInstaller, ["/S", `/D=${install}`], opts);
  assert.equal(
    await fileHash(join(install, "resources/app.asar")),
    report.previousAsarSha256,
  );
  await run(
    process.execPath,
    [join(root, "scripts/smoke-reference-images.mjs")],
    {
      ...opts,
      env: {
        ...process.env,
        ZINOVEL_TEST_EXECUTABLE: exe,
        ZINOVEL_QA_STAGE: "release/reference-upgrade/old-public40",
        ZINOVEL_REFERENCE_UPGRADE_EXPORT: "1",
      },
    },
  );
  const producer = JSON.parse(
    await readFile(
      join(out, "old-public40/reference-images/reference-images-smoke.json"),
      "utf8",
    ),
  );
  assert.equal(producer.status, "passed");
  assert.equal(producer.version, source.version);
  assert.equal(producer.appAsarSha256, report.previousAsarSha256);
  assert.equal(producer.requests, 2);
  assert.equal(producer.forcedEditRestart, true);
  assert.equal(producer.checks.length, 5);
  state = producer.upgradeState;
  assert.equal(JSON.parse(state.draftValue).schemaVersion, 2);
  report.sourceRequests = producer.requests;
  report.draftSha256 = hash(state.draftValue);
  report.profileSha256 = await fileHash(
    join(state.data, "model-profiles.json"),
  );
  beforeFiles = await inventory(join(state.data, "library", state.bookId));
  report.protectedFiles = beforeFiles;
  observer = createServer(async (req, res) => {
    report.replayRequests++;
    for await (const _ of req) {
    }
    res.writeHead(500).end("Unexpected replay");
  });
  await new Promise((resolve, reject) => {
    observer.once("error", reject);
    observer.listen(state.modelPort, "127.0.0.1", resolve);
  });
  const archive = `D:/zinovel-releases/v${source.version}/ci-public/win-installed`;
  try {
    await lstat(archive);
    assert.equal(
      await fileHash(join(archive, "resources/app.asar")),
      report.previousAsarSha256,
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await mkdir(resolve(archive, ".."), { recursive: true });
    await cp(install, archive, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const started = Date.now();
  await run(newInstaller, ["/S", `/D=${install}`], opts);
  report.upgradeMs = Date.now() - started;
  await launch();
  await verify("after-upgrade");
  await close();
  await launch();
  await verify("after-restart");
  await close();
  await uninstallOwned();
  report.uninstallPreserved = true;
  await launch(join(root, "release/win-unpacked/ZiNovel Studio.exe"));
  await verify("after-uninstall-portable");
  await close();
  assert.deepEqual(report.errors, []);
  assert.equal(report.replayRequests, 0);
  report.checks.push(
    "Pinned public40 executable actually creates schema3 adopted and interrupted reference-edit tasks plus schema2 draft with five original UI checks and two real synthetic HTTP requests",
    "Current NSIS upgrade preserves every canonical book/task/reference/blob/profile byte and exact schema2 draft; schema3 adopted receipt and remote-unknown remain readable with matching frozen PNG previews",
    "Full upgraded-host restart retains all identities and shows unknown state with zero new HTTP requests",
    "Actual uninstall removes owned registration/executable while retaining data; current exact portable runtime independently reads all protected bytes and previews without replay",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    await terminateOwnedProcesses(
      await captureOwnedProcesses(app.process().pid),
    );
    app = null;
  }
  if (report.status === "failed" && (await registered()))
    await uninstallOwned().catch((e) => {
      report.cleanupFailure = String(e);
    });
  if (observer) {
    observer.closeAllConnections();
    await new Promise((r) => observer.close(r));
  }
  await writeFile(
    join(out, "reference-upgrade-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
