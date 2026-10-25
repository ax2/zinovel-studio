import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  readdir,
  access,
} from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { waitForCondition } from "./windows-installer-observation.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

if (process.platform !== "win32" || !process.argv[2] || !process.argv[3])
  throw new Error(
    "Usage on Windows: node scripts/smoke-recent-upgrade.mjs PUBLIC_ALPHA31_INSTALLER PUBLIC_ALPHA31_MANIFEST",
  );
const root = resolve(import.meta.dirname, ".."),
  run = promisify(execFile),
  pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  previous = JSON.parse(await readFile(resolve(process.argv[3]), "utf8")),
  oldInstaller = resolve(process.argv[2]),
  newInstaller = join(
    root,
    "release",
    `ZiNovel-Studio-${pkg.version}-windows-x64-setup.exe`,
  ),
  digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  baseline = (value) => ({
    revision: value.revision,
    diskHash: value.diskHash,
  }),
  expected = (value) => ({ id: value.id, ...baseline(value) });
assert.equal(previous.version, "0.1.0-alpha.31");
assert.notEqual(pkg.version, previous.version);
assert.equal(basename(oldInstaller), previous.installer);
assert.equal(await digest(oldInstaller), previous.sha256);
const pinned = JSON.parse(
  await readFile(
    join(
      root,
      "assessments/release/v0.1.0-alpha.31/ci-public/release-manifest.json",
    ),
    "utf8",
  ),
);
assert.equal(
  previous.sha256,
  pinned.sha256,
  "Recent upgrade uses exact independently verified public alpha.31 bytes",
);
const currentInstallerSha256 = await digest(newInstaller),
  registry =
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a";
async function registrationExists() {
  try {
    await run("reg.exe", ["query", registry], { windowsHide: true });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
assert.equal(
  await registrationExists(),
  false,
  "Refusing to replace an existing user installation",
);
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache/recent-upgrade-")),
  install = join(work, "中文 最近版升级"),
  data = join(work, "synthetic-data"),
  executable = join(install, "ZiNovel Studio.exe"),
  out = join(root, "screenshots/release/recent-upgrade"),
  options = {
    cwd: work,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  };
await mkdir(out, { recursive: true });
const store = new NovelStore(join(data, "library")),
  body = "公开31升级合成原稿𠮷🌊。候选操作不改正文。",
  book = await store.importBook("最近公开版升级验收", [
    { title: "港口", body: "初始化合成正文。" },
  ]);
const bytes = await sharp({
    create: { width: 96, height: 144, channels: 3, background: "#217c91" },
  })
    .png()
    .toBuffer(),
  keys = {
    text: "synthetic-recent-text-key",
    image: "synthetic-recent-image-key",
  },
  calls = { text: 0, image: 0 };
const server = createServer(async (request, response) => {
  if (request.url !== "/image/v1/images/generations") {
    calls.text++;
    response.writeHead(400);
    response.end();
    return;
  }
  calls.image++;
  try {
    assert.equal(request.headers.authorization, `Bearer ${keys.image}`);
    const parts = [];
    for await (const part of request) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
    assert.equal(input.n, 1);
    assert.equal(input.response_format, "b64_json");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }),
    );
  } catch {
    response.writeHead(500);
    response.end("Synthetic recent-upgrade fixture failure");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`,
  report = {
    status: "running",
    fromVersion: previous.version,
    toVersion: pkg.version,
    previousInstallerSha256: previous.sha256,
    currentInstallerSha256,
    installDirectory: install,
    syntheticDataDirectory: data,
    checks: [],
    errors: [],
    scope:
      "Exact public alpha.31 NSIS to current candidate; synthetic initial book seeded by current core, actual old UI writes manuscript and old host creates encrypted profiles/image task, actual current UI reviews old paid candidate. No real provider, native IME or full downgrade qualification",
  };
let app, page, owned;
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env))
  if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
    delete env[key];
env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
const request = (action, payload = {}) =>
    page.evaluate(
      ({ action, payload }) => window.novel.request(action, payload),
      { action, payload },
    ),
  panel = () =>
    page.getByRole("dialog", { name: "AI 图像工作室", exact: true });
async function launch(version) {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: work,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  assert.deepEqual(
    await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
    })),
    { version, packaged: true },
  );
  const installedAsar = await digest(
    await app.evaluate(({ app }) => app.getAppPath()),
  );
  if (version === previous.version) {
    assert.equal(installedAsar, previous.imageStudio.appAsarSha256);
    report.previousAsarSha256 = installedAsar;
  } else {
    assert.equal(
      installedAsar,
      await digest(join(root, "release/win-unpacked/resources/app.asar")),
    );
    report.appAsarSha256 = installedAsar;
  }
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("Unexpected renderer request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
async function close() {
  await app.close();
  app = null;
  await confirmOwnedProcessesExited(owned);
  owned = null;
}
async function openImages() {
  await page.getByRole("button", { name: "AI 图像", exact: true }).click();
  await panel().getByLabel("图像提示词", { exact: true }).waitFor();
}
async function generate(prompt) {
  await panel().getByLabel("图像提示词", { exact: true }).fill(prompt);
  await panel()
    .getByRole("button", { name: "准备图像任务（不发送）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "任务已保存，尚未发送" })
    .waitFor();
  const id = (await request("image.list", { bookId: book.id })).tasks[0].id;
  await panel()
    .getByLabel("我确认提示词、用途、所选图像服务及可能的费用，明确发送一次")
    .check();
  await panel()
    .getByRole("button", { name: "确认发送图像请求", exact: true })
    .click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  return request("image.read", { bookId: book.id, id });
}
try {
  let started = Date.now();
  await run(oldInstaller, ["/S", `/D=${install}`], options);
  report.previousInstallMs = Date.now() - started;
  await launch(previous.version);
  await page.getByLabel("正文编辑器").fill(body);
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  await request("settings.save", {
    baseURL: `${baseURL}/text/v1`,
    model: "synthetic-recent-text",
    apiKey: keys.text,
  });
  let profiles = await request("profiles.list");
  profiles = await request("profiles.migrate", {
    legacyToken: profiles.legacyToken,
  });
  profiles = await request("profiles.add", {
    expected: baseline(profiles),
    input: {
      label: "公开31图像配置",
      protocol: "openai-images",
      baseURL: `${baseURL}/image/v1`,
      model: "synthetic-recent-image",
      apiKey: keys.image,
      imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
      imageOptions: { responseMode: "request-base64" },
    },
  });
  const profile = profiles.profiles.find((p) => p.label === "公开31图像配置");
  await request("profiles.select", {
    capability: "image",
    id: profile.id,
    expected: baseline(profiles),
  });
  const character = await request("materials.save", {
    bookId: book.id,
    input: {
      title: "合成旅行者",
      kind: "character",
      status: "planned",
      fields: { appearance: "旧蓝衣" },
      notes: "生成前设定",
      chapterIds: [],
    },
  });
  await openImages();
  await panel()
    .getByLabel("图像用途", { exact: true })
    .selectOption("portrait");
  await panel()
    .getByLabel("目标人物", { exact: true })
    .selectOption(character.id);
  const oldTask = await generate("公开31生成后保留的合成人物候选。");
  assert.equal(oldTask.schemaVersion, 1);
  assert.equal(oldTask.candidates[0].decision, "pending");
  assert.deepEqual(calls, { text: 0, image: 1 });
  const currentCharacter = await request("materials.save", {
    bookId: book.id,
    expected: expected(character),
    input: {
      title: character.title,
      kind: "character",
      status: "planned",
      fields: { appearance: "旅行斗篷𠮷" },
      notes: "公开31作者生成后修改",
      chapterIds: [],
    },
  });
  await page.screenshot({ path: join(out, "before-upgrade.png") });
  await close();
  const taskPath = join(
      data,
      "library",
      book.id,
      ".zinovel/image-tasks",
      oldTask.id + ".json",
    ),
    manuscript = join(
      data,
      "library",
      book.id,
      "manuscript",
      book.chapters[0].id + ".md",
    ),
    beforeTask = await readFile(taskPath),
    beforeProfiles = await readFile(join(data, "model-profiles.json")),
    beforeBody = await readFile(manuscript);
  assert.equal(beforeBody.toString("utf8"), body);
  started = Date.now();
  await run(newInstaller, ["/S", `/D=${install}`], options);
  report.upgradeMs = Date.now() - started;
  await launch(pkg.version);
  assert.deepEqual(await readFile(taskPath), beforeTask);
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(calls, { text: 0, image: 1 });
  await openImages();
  await panel().locator(`[data-task-id="${oldTask.id}"]`).click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await panel()
    .getByRole("region", { name: "目标版本复评", exact: true })
    .getByText("旅行斗篷𠮷", { exact: true })
    .waitFor();
  await panel()
    .getByLabel(
      "我已核对画面与当前目标，确认将旧候选关联当前版本（不重新生成）",
      { exact: true },
    )
    .check();
  await panel()
    .getByRole("button", {
      name: "确认按当前目标采用（不重新生成）",
      exact: true,
    })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已有候选已按明确复评的当前目标采用" })
    .waitFor();
  const reviewed = await request("image.read", {
    bookId: book.id,
    id: oldTask.id,
  });
  assert.equal(reviewed.schemaVersion, 2);
  assert.deepEqual(reviewed.target, oldTask.target);
  assert.equal(reviewed.responseHash, oldTask.responseHash);
  assert.equal(reviewed.candidates[0].assetId, oldTask.candidates[0].assetId);
  assert.equal(
    reviewed.candidates[0].adoption.targetReview.target.material.revision,
    currentCharacter.revision,
  );
  assert.deepEqual(calls, { text: 0, image: 1 });
  report.reviewedOldCandidateWithoutRequest = true;
  await page.screenshot({ path: join(out, "after-review.png") });
  await generate("当前安装版明确发起的新候选，用原公开31图像Key。");
  assert.deepEqual(calls, { text: 0, image: 2 });
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  report.credentialsPreserved = true;
  report.profileBytesPreserved = true;
  const taskAfter = await readFile(taskPath);
  await close();
  await launch(pkg.version);
  assert.deepEqual(await readFile(taskPath), taskAfter);
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(calls, { text: 0, image: 2 });
  await close();
  const uninstaller = (await readdir(install)).find((name) =>
    /^Uninstall .*\.exe$/i.test(name),
  );
  assert.ok(uninstaller);
  await run(join(install, uninstaller), ["/S", "/currentuser"], options);
  await waitForCondition(async () => {
    try {
      await access(executable);
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }, "Recent upgrade uninstaller did not remove its executable");
  await waitForCondition(
    async () => !(await registrationExists()),
    "Recent upgrade registration remained",
  );
  assert.deepEqual(await readFile(taskPath), taskAfter);
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  assert.deepEqual(report.errors, []);
  report.requests = calls;
  report.uninstallPreserved = true;
  report.checks.push(
    "Exact public alpha.31 installed in an isolated Chinese/space path; old UI saves Unicode manuscript and old host encrypts independent image profile and generates a v1 pending candidate",
    "Current NSIS upgrade preserves exact manuscript/profile/v1-task bytes; actual UI explicitly reviews the old candidate into v2 without a new request; original Key makes only a separately confirmed later request",
    "Full restart retains both target facts without replay; real uninstall removes executable/registration while preserving manuscript, encrypted profiles and v2 receipt",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (owned) await terminateOwnedProcesses(owned);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(out, "recent-upgrade-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
