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
    "Usage on Windows: node scripts/smoke-recent-upgrade.mjs PUBLIC_SOURCE_INSTALLER PUBLIC_SOURCE_MANIFEST [recent-upgrade|current-upgrade|appearance-upgrade|scene-upgrade|import-upgrade]",
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
const stage = process.argv[4] ?? "recent-upgrade";
assert.ok(
  [
    "recent-upgrade",
    "current-upgrade",
    "appearance-upgrade",
    "scene-upgrade",
    "import-upgrade",
    "origin-upgrade",
  ].includes(stage),
);
const originPublic = stage === "origin-upgrade",
  importPublic = stage === "import-upgrade" || originPublic,
  scenePublic = stage === "scene-upgrade" || importPublic,
  appearancePublic = stage === "appearance-upgrade" || scenePublic,
  currentPublic = stage !== "recent-upgrade",
  sourceVersion = importPublic
    ? originPublic
      ? "0.1.0-alpha.38"
      : "0.1.0-alpha.37"
    : scenePublic
      ? "0.1.0-alpha.36"
      : appearancePublic
        ? "0.1.0-alpha.35"
        : currentPublic
          ? "0.1.0-alpha.33"
          : "0.1.0-alpha.31",
  sourceLabel = importPublic
    ? originPublic
      ? "公开38"
      : "公开37"
    : scenePublic
      ? "公开36"
      : appearancePublic
        ? "公开35"
        : currentPublic
          ? "公开33"
          : "公开31";
assert.equal(previous.version, sourceVersion);
const sourceSuffix = sourceVersion.split(".").at(-1);
if (appearancePublic) {
  assert.equal(previous.characterLooks?.version, sourceVersion);
  assert.equal(
    previous.characterLooks?.appAsarSha256,
    previous.imageStudio.appAsarSha256,
  );
}
assert.notEqual(pkg.version, previous.version);
assert.equal(basename(oldInstaller), previous.installer);
assert.equal(await digest(oldInstaller), previous.sha256);
const pinned = JSON.parse(
  await readFile(
    join(
      root,
      `assessments/release/v${sourceVersion}/ci-public/release-manifest.json`,
    ),
    "utf8",
  ),
);
assert.equal(
  previous.sha256,
  pinned.sha256,
  `Upgrade uses exact independently verified public ${sourceVersion} bytes`,
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
async function removeFailedOwnedInstall() {
  if (!(await registrationExists())) return;
  const name = (await readdir(install)).find((item) =>
    /^Uninstall .*\.exe$/i.test(item),
  );
  assert.ok(name);
  const uninstaller = join(install, name);
  const registered = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\81b55339-fc21-4fe7-949e-a90dc443ef5a').UninstallString | ConvertTo-Json -Compress",
    ],
    { windowsHide: true },
  );
  const value = JSON.parse(registered.stdout.replace(/^\uFEFF/, "").trim());
  assert.ok(value, "Owned uninstall registration is missing");
  const match = /^"([^"]+)"|^(.+?\.exe)(?:\s|$)/i.exec(value);
  assert.equal(
    resolve(match?.[1] || match?.[2] || "").toLowerCase(),
    resolve(uninstaller).toLowerCase(),
    "Refusing to remove another installation",
  );
  const asar = await digest(join(install, "resources/app.asar"));
  assert.ok(
    [
      previous.imageStudio.appAsarSha256,
      await digest(join(root, "release/win-unpacked/resources/app.asar")),
    ].includes(asar),
    "Unknown installed runtime must be retained",
  );
  await run(uninstaller, ["/S", "/currentuser"], options);
  await waitForCondition(
    async () => !(await registrationExists()),
    "Failed QA fixture registration remained",
  );
  await waitForCondition(async () => {
    try {
      await access(executable);
      return false;
    } catch (e) {
      if (e.code === "ENOENT") return true;
      throw e;
    }
  }, "Failed QA fixture executable remained");
  report.failedOwnedInstallRemoved = true;
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
  out = join(root, "screenshots/release", stage),
  options = {
    cwd: work,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  };
await mkdir(out, { recursive: true });
const store = new NovelStore(join(data, "library")),
  body = `${sourceLabel}升级合成原稿𠮷🌊。候选操作不改正文。`,
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
    scope: `Exact public ${sourceVersion} NSIS to current candidate; synthetic initial book seeded by current core, actual old UI writes manuscript and old host creates encrypted profiles/image task, actual current UI reviews old paid candidate. No real provider, native IME or full downgrade qualification`,
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
async function launch(version, binary = executable) {
  app = await electron.launch({
    executablePath: binary,
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
async function openCharacterForm(character) {
  if (await panel().isVisible())
    await panel()
      .getByRole("button", { name: "关闭图像工作室", exact: true })
      .click();
  const tab = page.getByRole("button", { name: "资料卡", exact: true });
  if (!(await tab.isVisible()))
    await page.getByTitle("打开创作参考", { exact: true }).click();
  await tab.click();
  const form = page.getByRole("region", { name: "创作资料", exact: true });
  await form
    .getByRole("combobox", { name: "资料类型", exact: true })
    .selectOption("character");
  await form.getByLabel("搜索资料", { exact: true }).fill("");
  await form
    .locator(".material-list button")
    .filter({ hasText: character.title })
    .click();
  await form.getByLabel("资料标题", { exact: true }).waitFor();
  const details = page.locator(".character-looks");
  await details.waitFor();
  if (!((await details.getAttribute("open")) !== null))
    await details.locator(":scope > summary").click();
  await page
    .getByRole("region", { name: "人物形象版本", exact: true })
    .getByRole("button", { name: "新建形象版本", exact: true })
    .waitFor();
  return form;
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
async function reviewTarget(task, target) {
  await panel().locator(`[data-task-id="${task.id}"]`).click();
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
    id: task.id,
  });
  assert.equal(reviewed.schemaVersion, 2);
  assert.deepEqual(reviewed.target, task.target);
  assert.equal(reviewed.responseHash, task.responseHash);
  assert.equal(reviewed.candidates[0].assetId, task.candidates[0].assetId);
  assert.equal(
    reviewed.candidates[0].adoption.targetReview.target.material.revision,
    target.revision,
  );
  return reviewed;
}
try {
  let started = Date.now();
  await run(oldInstaller, ["/S", `/D=${install}`], options);
  report.previousInstallMs = Date.now() - started;
  await launch(previous.version);
  let legacyImportedBook = null;
  const legacyImportRecords = [];
  let importedOrigin = null;
  const originRecords = [];
  if (importPublic) {
    const source = join(work, `${sourceLabel}手工分章原稿𠮷.txt`);
    await writeFile(
      source,
      "第一章 原题\n甲𠮷🙂乙\n第二章 尾声\n旧版导入的结尾。",
    );
    await page.getByTitle("返回书库", { exact: true }).click();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [source],
      });
    }, source);
    await page.getByRole("button", { name: "导入作品", exact: true }).click();
    await page
      .getByRole("button", { name: "选择 TXT / Markdown", exact: true })
      .click();
    await page.getByText("1 个源文件 · 2 章", { exact: false }).waitFor();
    await page.getByText("手工调整章节名称与边界", { exact: true }).click();
    await page.getByLabel("预览章名", { exact: true }).fill("旧版确认的首章");
    await page
      .getByRole("button", { name: "应用卷章名称", exact: true })
      .click();
    await page
      .locator(".import-preview button")
      .filter({ hasText: "旧版确认的首章" })
      .waitFor();
    const previewBody = page.getByLabel("预览正文（选择拆分位置）", {
      exact: true,
    });
    await previewBody.focus();
    await previewBody.press("Control+Home");
    await previewBody.press("ArrowRight");
    await previewBody.press("ArrowRight");
    assert.equal(
      await previewBody.evaluate((field) => field.selectionStart),
      3,
    );
    await page
      .getByLabel("拆分后新章名称", { exact: true })
      .fill("旧版手工后半章");
    await page
      .getByRole("button", { name: "从光标处拆分", exact: true })
      .click();
    await page.getByText("1 个源文件 · 3 章", { exact: false }).waitFor();
    await page.getByLabel("导入作品名称").fill(`${sourceLabel}手工导入升级书`);
    await page
      .getByRole("button", { name: "确认导入为新作品", exact: true })
      .click();
    await page.getByLabel("正文编辑器").waitFor();
    legacyImportedBook = (await request("library.list")).books.find(
      (item) => item.id !== book.id,
    );
    assert.ok(legacyImportedBook);
    assert.equal(legacyImportedBook.chapters.length, 3);
    assert.equal(legacyImportedBook.chapters[0].title, "旧版确认的首章");
    assert.deepEqual(
      await Promise.all(
        legacyImportedBook.chapters.map(
          async (chapter) =>
            (
              await request("chapter.read", {
                bookId: legacyImportedBook.id,
                chapterId: chapter.id,
              })
            ).body,
        ),
      ),
      ["甲𠮷", "🙂乙", "旧版导入的结尾。"],
    );
    const importedRoot = join(data, "library", legacyImportedBook.id);
    for (const path of [
      join(importedRoot, "book.json"),
      ...legacyImportedBook.chapters.map((chapter) =>
        join(importedRoot, "manuscript", chapter.id + ".md"),
      ),
    ])
      legacyImportRecords.push({ path, bytes: await readFile(path) });
    if (originPublic) {
      importedOrigin = await request("book.import-origin", {
        bookId: legacyImportedBook.id,
      });
      assert.equal(importedOrigin.origin.schemaVersion, 1);
      assert.equal(importedOrigin.origin.applicationVersion, sourceVersion);
      assert.equal(importedOrigin.origin.sources.length, 1);
      assert.equal(importedOrigin.origin.chapters.length, 3);
      assert.equal(importedOrigin.origin.originalChapterCount, 2);
      assert.ok(importedOrigin.origin.manualAdjustmentCount >= 2);
      assert.equal(importedOrigin.restoredCopy, false);
      const path = join(importedRoot, ".zinovel/import-origin.json");
      originRecords.push({ path, bytes: await readFile(path) });
    } else
      await assert.rejects(
        access(join(importedRoot, ".zinovel/import-origin.json")),
        { code: "ENOENT" },
      );
    await page.screenshot({
      path: join(out, `old-public${sourceSuffix}-manual-import.png`),
    });
    await page.getByTitle("返回书库", { exact: true }).click();
    await page
      .locator(".book-card")
      .filter({
        has: page.getByRole("heading", { name: book.title, exact: true }),
      })
      .click();
    await page.getByLabel("正文编辑器").waitFor();
  }
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
      label: `${sourceLabel}图像配置`,
      protocol: "openai-images",
      baseURL: `${baseURL}/image/v1`,
      model: "synthetic-recent-image",
      apiKey: keys.image,
      imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
      imageOptions: { responseMode: "request-base64" },
    },
  });
  const profile = profiles.profiles.find(
    (p) => p.label === `${sourceLabel}图像配置`,
  );
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
  let oldTask = await generate(`${sourceLabel}生成后保留的合成人物候选。`);
  assert.equal(oldTask.schemaVersion, 1);
  assert.equal(oldTask.candidates[0].decision, "pending");
  assert.deepEqual(calls, { text: 0, image: 1 });
  let currentCharacter = await request("materials.save", {
    bookId: book.id,
    expected: expected(character),
    input: {
      title: character.title,
      kind: "character",
      status: "planned",
      fields: { appearance: "旅行斗篷𠮷" },
      notes: `${sourceLabel}作者生成后修改`,
      chapterIds: [],
    },
  });
  const priorRecords = [];
  const appearanceRecords = [];
  const sceneRecords = [];
  let oldAppearance = null,
    oldLookDraft = null,
    oldMaterialDraft = null,
    newScene = null,
    oldArrangedScene = null,
    oldPlanning = null;
  async function verifySceneTree(name) {
    if (await panel().isVisible())
      await panel()
        .getByRole("button", { name: "关闭图像工作室", exact: true })
        .click();
    if (!(await page.locator(".chapters").isVisible()))
      await page
        .getByRole("button", { name: "关闭创作参考", exact: true })
        .click();
    await page.getByRole("button", { name: "刷新场景树", exact: true }).click();
    const summary = page.getByLabel(`${book.chapters[0].title}的计划场景`, {
      exact: true,
    });
    await summary.waitFor();
    if ((await summary.locator("..").getAttribute("open")) === null)
      await summary.click();
    await page
      .getByRole("group", {
        name: `${book.chapters[0].title}的场景列表`,
        exact: true,
      })
      .getByRole("button", { name: oldArrangedScene.title, exact: true })
      .waitFor();
    await page.screenshot({ path: join(out, name) });
  }
  const lookKey = `zinovel.character-look-draft.${book.id}.${character.id}`,
    materialKey = `zinovel.material-draft.${book.id}.new`,
    cacheHash = (raw) =>
      createHash("sha256")
        .update(raw ?? "<absent>")
        .digest("hex");
  let previousReviewed = null,
    previousAsset = null;
  if (currentPublic) {
    const oldReviewed = await reviewTarget(oldTask, currentCharacter);
    assert.match(oldReviewed.diskHash, /^[a-f0-9]{64}$/);
    previousReviewed = oldReviewed;
    assert.equal(oldReviewed.schemaVersion, 2);
    assert.deepEqual(calls, { text: 0, image: 1 });
    const asset = await request("assets.read", {
      bookId: book.id,
      id:
        oldReviewed.candidates[0].adoption.assetId ??
        oldReviewed.candidates[0].assetId,
    });
    previousAsset = asset;
    assert.match(previousAsset.diskHash, /^[a-f0-9]{64}$/);
    for (const path of [
      join(
        data,
        "library",
        book.id,
        ".zinovel/image-tasks",
        oldTask.id + ".json",
      ),
      join(data, "library", book.id, "assets/items", asset.id + ".json"),
      join(
        data,
        "library",
        book.id,
        "assets/blobs",
        asset.blob.sha256 + "." + asset.blob.format,
      ),
    ])
      priorRecords.push({ path, bytes: await readFile(path) });
    await page.screenshot({ path: join(out, "old-public-reviewed-v2.png") });
    await panel()
      .getByRole("button", { name: "关闭图像工作室", exact: true })
      .click();
    await openImages();
    await panel()
      .getByLabel("图像用途", { exact: true })
      .selectOption("portrait");
    await panel()
      .getByLabel("目标人物", { exact: true })
      .selectOption(character.id);
    oldTask = await generate(
      `${sourceLabel}另行生成的待采用候选，升级后再明确复评。`,
    );
    assert.equal(oldTask.schemaVersion, 1);
    assert.equal(oldTask.candidates[0].decision, "pending");
    currentCharacter = await request("materials.save", {
      bookId: book.id,
      expected: expected(currentCharacter),
      input: {
        title: character.title,
        kind: "character",
        status: "planned",
        fields: { appearance: "旅行斗篷𠮷" },
        notes: `${sourceLabel}已有v2回执后再次修改人物`,
        chapterIds: [],
      },
    });
  }
  if (appearancePublic) {
    if (scenePublic) {
      oldArrangedScene = await request("materials.save", {
        bookId: book.id,
        input: {
          kind: "scene",
          title: `${sourceLabel}已安排场景𠮷🌊`,
          status: "planned",
          fields: { goal: "旧程序安排的计划位置" },
          notes: "合成升级场景",
          chapterIds: [],
        },
      });
      oldPlanning = await request("planning.move", {
        bookId: book.id,
        mutation: {
          sceneId: oldArrangedScene.id,
          chapterId: book.chapters[0].id,
          beforeId: null,
        },
        expected: await request("planning.read", { bookId: book.id }),
      });
      for (const path of [
        join(data, "library", book.id, "planning.json"),
        join(
          data,
          "library",
          book.id,
          "materials",
          `${oldArrangedScene.id}.json`,
        ),
      ])
        sceneRecords.push({ path, bytes: await readFile(path) });
      await verifySceneTree(`old-public${sourceSuffix}-arranged-scene.png`);
    }
    const form = await openCharacterForm(currentCharacter),
      looks = page.getByRole("region", { name: "人物形象版本", exact: true });
    await looks
      .getByRole("button", { name: "新建形象版本", exact: true })
      .click();
    await looks
      .getByLabel("形象名称", { exact: true })
      .fill(`${sourceLabel}少年定妆𠮷🌊`);
    await looks.getByLabel("年龄描述", { exact: true }).fill("十六岁");
    await looks.getByLabel("衣装", { exact: true }).fill("少年蓝衣");
    await looks
      .getByLabel("此版本使用的固定图像", { exact: true })
      .selectOption(previousAsset.id);
    await looks
      .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
      .click();
    await looks
      .getByRole("status")
      .filter({ hasText: "形象版本已保存" })
      .waitFor();
    assert.equal(
      (
        await request("looks.read", {
          bookId: book.id,
          characterId: character.id,
        })
      ).record.selected,
      null,
    );
    await looks
      .getByRole("button", { name: "预览此形象", exact: true })
      .click();
    await looks.getByAltText("形象候选固定版本预览", { exact: true }).waitFor();
    await looks
      .getByLabel("我已核对人物与固定版本，确认本次定妆选择", { exact: true })
      .check();
    await looks
      .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
      .click();
    await looks.getByRole("status").filter({ hasText: "已明确选定" }).waitFor();
    await looks
      .getByRole("button", { name: "编辑形象版本", exact: true })
      .click();
    await looks.getByLabel("年龄描述", { exact: true }).fill("三十岁");
    await looks.getByLabel("衣装", { exact: true }).fill("成年灰衣");
    await looks
      .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
      .click();
    await looks
      .getByRole("status")
      .filter({ hasText: "形象版本已保存" })
      .waitFor();
    oldAppearance = await request("looks.read", {
      bookId: book.id,
      characterId: character.id,
    });
    assert.equal(oldAppearance.selectedEntry.input.outfit, "少年蓝衣");
    assert.equal(oldAppearance.record.entries[0].input.outfit, "成年灰衣");
    assert.equal(oldAppearance.selectedError, null);
    const collectionPath = join(
        data,
        "library",
        book.id,
        "world/character-looks",
        character.id + ".json",
      ),
      history = join(
        data,
        "library",
        book.id,
        ".zinovel/character-look-history",
        character.id,
      );
    for (const path of [
      collectionPath,
      ...(await readdir(history)).map((name) => {
        assert.match(name, /^\d+-[a-f0-9]{64}\.json$/);
        return join(history, name);
      }),
    ])
      appearanceRecords.push({ path, bytes: await readFile(path) });
    assert.ok(appearanceRecords.length >= 3);
    await looks
      .getByRole("button", { name: "新建形象版本", exact: true })
      .click();
    await looks
      .getByLabel("形象名称", { exact: true })
      .fill(`${sourceLabel}未保存形象𠮷🌊`);
    await looks.getByLabel("衣装", { exact: true }).fill("待作者决定的外套");
    await looks
      .getByLabel("此版本使用的固定图像", { exact: true })
      .selectOption(previousAsset.id);
    oldLookDraft = await page.evaluate(
      (key) => localStorage.getItem(key),
      lookKey,
    );
    assert.ok(oldLookDraft);
    await page.screenshot({
      path: join(
        out,
        scenePublic
          ? `old-public${sourceSuffix}-fixed-look-and-draft.png`
          : "old-public35-fixed-look-and-draft.png",
      ),
    });
    await form
      .getByRole("combobox", { name: "新建类型", exact: true })
      .selectOption("scene");
    await form.getByRole("button", { name: "新建资料", exact: true }).click();
    await form
      .getByLabel("资料标题", { exact: true })
      .fill(`${sourceLabel}未保存场景𠮷🌊`);
    await form.getByLabel("场景目标", { exact: true }).fill("找到旧桥的送信人");
    await form
      .getByLabel("资料笔记", { exact: true })
      .fill("留待新版本由作者明确保存。");
    oldMaterialDraft = await page.evaluate(
      (key) => localStorage.getItem(key),
      materialKey,
    );
    assert.ok(oldMaterialDraft);
    assert.equal(
      Object.hasOwn(JSON.parse(oldMaterialDraft), "schemaVersion"),
      scenePublic,
    );
    if (scenePublic)
      assert.equal(JSON.parse(oldMaterialDraft).schemaVersion, 1);
    assert.deepEqual(calls, { text: 0, image: 2 });
  }
  const beforeRequests = currentPublic ? 2 : 1,
    finalRequests = beforeRequests + 1;
  const verifyPrior = async () => {
    for (const item of [
      ...priorRecords,
      ...appearanceRecords,
      ...sceneRecords,
      ...legacyImportRecords,
      ...originRecords,
    ])
      assert.deepEqual(await readFile(item.path), item.bytes);
  };
  const verifyPriorInHost = async () => {
    await verifyPrior();
    if (!previousReviewed) return;
    const receipt = await request("image.read", {
      bookId: book.id,
      id: previousReviewed.id,
    });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.diskHash, previousReviewed.diskHash);
    assert.deepEqual(
      receipt.candidates[0].adoption,
      previousReviewed.candidates[0].adoption,
    );
    const asset = await request("assets.read", {
      bookId: book.id,
      id: previousAsset.id,
    });
    assert.equal(asset.diskHash, previousAsset.diskHash);
    assert.deepEqual(asset.blob, previousAsset.blob);
    if (appearancePublic) {
      const view = await request("looks.read", {
        bookId: book.id,
        characterId: character.id,
      });
      assert.deepEqual(view.record, oldAppearance.record);
      assert.deepEqual(view.selectedEntry, oldAppearance.selectedEntry);
      assert.equal(view.selectedError, null);
      await openCharacterForm(currentCharacter);
      const looks = page.getByRole("region", {
        name: "人物形象版本",
        exact: true,
      });
      assert.equal(
        await looks.getByLabel("形象名称", { exact: true }).inputValue(),
        `${sourceLabel}未保存形象𠮷🌊`,
      );
      assert.equal(
        cacheHash(
          await page.evaluate((key) => localStorage.getItem(key), lookKey),
        ),
        cacheHash(oldLookDraft),
      );
      assert.equal(
        await looks
          .getByLabel("我已核对人物与固定版本，确认本次定妆选择", {
            exact: true,
          })
          .isChecked(),
        false,
      );
      await looks
        .getByRole("button", { name: "预览当前定妆", exact: true })
        .click();
      await page.waitForFunction(() => {
        const image = document.querySelector('img[alt="当前定妆固定版本预览"]');
        return image?.complete && image.naturalWidth > 0;
      });
      if (newScene) {
        const scene = await request("materials.read", {
          bookId: book.id,
          id: newScene.id,
        });
        assert.equal(scene.diskHash, newScene.diskHash);
        assert.equal(scene.fields.goal, "找到旧桥的送信人");
      } else
        assert.equal(
          cacheHash(
            await page.evaluate(
              (key) => localStorage.getItem(key),
              materialKey,
            ),
          ),
          cacheHash(oldMaterialDraft),
        );
    }
    if (scenePublic) {
      const currentPlanning = await request("planning.read", {
        bookId: book.id,
      });
      assert.equal(currentPlanning.revision, oldPlanning.revision);
      assert.equal(currentPlanning.diskHash, oldPlanning.diskHash);
      assert.equal(
        currentPlanning.columns.find(
          (column) => column.id === book.chapters[0].id,
        ).scenes[0].id,
        oldArrangedScene.id,
      );
      assert.equal(
        (
          await request("materials.read", {
            bookId: book.id,
            id: oldArrangedScene.id,
          })
        ).diskHash,
        oldArrangedScene.diskHash,
      );
      await verifySceneTree(`new-public${sourceSuffix}-arranged-scene.png`);
      report.sceneTreeReadbacks = (report.sceneTreeReadbacks || 0) + 1;
    }
    if (importPublic) {
      const actual = (await request("library.list")).books.find(
        (item) => item.id === legacyImportedBook.id,
      );
      assert.deepEqual(actual.chapters, legacyImportedBook.chapters);
      for (const chapter of actual.chapters)
        assert.equal(
          (
            await request("chapter.read", {
              bookId: actual.id,
              chapterId: chapter.id,
            })
          ).diskHash,
          chapter.hash,
        );
      assert.deepEqual(
        await request("book.import-origin", { bookId: actual.id }),
        originPublic ? importedOrigin : { origin: null, restoredCopy: false },
      );
      if (!originPublic)
        await assert.rejects(
          access(
            join(data, "library", actual.id, ".zinovel/import-origin.json"),
          ),
          { code: "ENOENT" },
        );
      if (!report.legacyImportReadbacks) {
        await page.getByTitle("返回书库", { exact: true }).click();
        await page
          .locator(".book-card")
          .filter({
            has: page.getByRole("heading", { name: actual.title, exact: true }),
          })
          .click();
        await page
          .getByRole("button", { name: "管理作品 / 回收站", exact: true })
          .click();
        await page.getByText("导入来源与确认记录", { exact: true }).click();
        const originRegion = page.getByRole("region", {
          name: "导入来源说明",
          exact: true,
        });
        await originRegion
          .getByText(
            originPublic ? "初始 2 章" : "此作品没有保留导入来源说明。",
            { exact: false },
          )
          .waitFor();
        if (originPublic) {
          await originRegion
            .getByText("导入时的章节与内容指纹（3）", { exact: true })
            .click();
          await originRegion
            .getByText(`${sourceLabel}手工分章原稿𠮷.txt`, { exact: false })
            .waitFor();
          await originRegion
            .getByText("旧版手工后半章", { exact: false })
            .waitFor();
        }
        await page.screenshot({
          path: join(
            out,
            originPublic
              ? "new-public38-origin-preserved.png"
              : "new-public37-legacy-origin-not-fabricated.png",
          ),
        });
        await page
          .getByRole("button", { name: "关闭作品管理", exact: true })
          .click();
        await page.getByTitle("返回书库", { exact: true }).click();
        await page
          .locator(".book-card")
          .filter({
            has: page.getByRole("heading", { name: book.title, exact: true }),
          })
          .click();
        await page.getByLabel("正文编辑器").waitFor();
      }
      report.legacyImportReadbacks = (report.legacyImportReadbacks || 0) + 1;
    }
  };
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
  await verifyPriorInHost();
  assert.deepEqual(await readFile(taskPath), beforeTask);
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(calls, { text: 0, image: beforeRequests });
  await openImages();
  const reviewed = await reviewTarget(oldTask, currentCharacter);
  assert.deepEqual(calls, { text: 0, image: beforeRequests });
  report.reviewedOldCandidateWithoutRequest = true;
  await page.screenshot({ path: join(out, "after-review.png") });
  await generate(`当前安装版明确发起的新候选，用原${sourceLabel}图像Key。`);
  assert.deepEqual(calls, { text: 0, image: finalRequests });
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  report.credentialsPreserved = true;
  report.profileBytesPreserved = true;
  const taskAfter = await readFile(taskPath);
  await close();
  await launch(pkg.version);
  await verifyPriorInHost();
  assert.deepEqual(await readFile(taskPath), taskAfter);
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(calls, { text: 0, image: finalRequests });
  if (appearancePublic) {
    if (!(await page.locator(".chapters").isVisible()))
      await page
        .getByRole("button", { name: "关闭创作参考", exact: true })
        .click();
    await page
      .getByRole("button", { name: "新建场景资料", exact: true })
      .click();
    const form = page.getByRole("region", { name: "创作资料", exact: true });
    await form.getByLabel("资料标题", { exact: true }).waitFor();
    assert.equal(
      await form.getByLabel("资料标题", { exact: true }).inputValue(),
      `${sourceLabel}未保存场景𠮷🌊`,
    );
    assert.equal(
      cacheHash(
        await page.evaluate((key) => localStorage.getItem(key), materialKey),
      ),
      cacheHash(oldMaterialDraft),
    );
    await form
      .getByLabel("资料笔记", { exact: true })
      .fill("升级后作者明确修改并保存𠮷🌊。");
    assert.equal(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).schemaVersion,
        materialKey,
      ),
      1,
    );
    await form.getByRole("button", { name: "保存资料", exact: true }).click();
    await form.getByRole("status").filter({ hasText: "已保存资料" }).waitFor();
    const result = await request("materials.list", {
      bookId: book.id,
      options: { kind: "scene", query: `${sourceLabel}未保存场景𠮷🌊` },
    });
    assert.equal(result.items.length, 1);
    newScene = await request("materials.read", {
      bookId: book.id,
      id: result.items[0].id,
    });
    assert.equal(newScene.fields.goal, "找到旧桥的送信人");
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), materialKey),
      null,
    );
    if (scenePublic) report.schema1DraftPreservedUntilExplicitSave = true;
    else report.legacyDraftPreservedUntilExplicitSave = true;
    report.explicitSchema1DraftCreated = true;
    await page.screenshot({
      path: join(
        out,
        scenePublic
          ? "new-author-saved-schema1-scene.png"
          : "new-author-saved-legacy-scene.png",
      ),
    });
  }
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
  if (appearancePublic) {
    await launch(
      pkg.version,
      join(root, "release/win-unpacked/ZiNovel Studio.exe"),
    );
    await verifyPriorInHost();
    await close();
    assert.equal(await registrationExists(), false);
    await assert.rejects(access(executable), { code: "ENOENT" });
    report.postUninstallDataReadable = true;
  }
  assert.deepEqual(await readFile(taskPath), taskAfter);
  assert.deepEqual(await readFile(manuscript), beforeBody);
  assert.deepEqual(
    await readFile(join(data, "model-profiles.json")),
    beforeProfiles,
  );
  assert.deepEqual(report.errors, []);
  await verifyPrior();
  if (currentPublic) {
    report.previousV2ReceiptPreserved = true;
    report.previousV2Readable = true;
    report.previousAdoptedAssetPreserved = true;
    report.previousV2Files = priorRecords.map((r) => ({
      name: r.path.split(/[\\/]/).slice(-1)[0],
      sha256: createHash("sha256").update(r.bytes).digest("hex"),
      bytes: r.bytes.length,
    }));
  }
  if (appearancePublic) {
    report.appearanceFiles = appearanceRecords.map((r) => ({
      name: r.path.split(/[\\/]/).slice(-1)[0],
      sha256: createHash("sha256").update(r.bytes).digest("hex"),
      bytes: r.bytes.length,
    }));
    report.fixedAppearancePreserved = true;
    report.fixedAppearancePreviewReadable = true;
    report.lookDraftPreserved = true;
    report.lookDraftSha256 = cacheHash(oldLookDraft);
    report.oldMaterialDraftSha256 = cacheHash(oldMaterialDraft);
    report.newScene = {
      id: newScene.id,
      revision: newScene.revision,
      diskHash: newScene.diskHash,
    };
    if (scenePublic) {
      assert.ok(report.sceneTreeReadbacks >= 3);
      report.plannedScenePreserved = true;
      report.originalMaterialDraftSchema = 1;
      report.plannedScene = {
        id: oldArrangedScene.id,
        diskHash: oldArrangedScene.diskHash,
        chapterId: book.chapters[0].id,
        planningHash: oldPlanning.diskHash,
        planningRevision: oldPlanning.revision,
      };
      report.sceneFiles = sceneRecords.map((item) => ({
        name: item.path.split(/[\\/]/).slice(-1)[0],
        sha256: createHash("sha256").update(item.bytes).digest("hex"),
        bytes: item.bytes.length,
      }));
    }
  }
  report.requests = calls;
  report.uninstallPreserved = true;
  report.checks.push(
    `Exact public ${sourceVersion} installed in an isolated Chinese/space path; old UI saves Unicode manuscript and old host encrypts independent image profile and generates a v1 pending candidate${currentPublic ? "; actual old UI also reviews a separate candidate into v2, preserving its receipt and adopted asset through upgrade" : ""}`,
    "Current NSIS upgrade preserves exact manuscript/profile/v1-task bytes; actual UI explicitly reviews the old candidate into v2 without a new request; original Key makes only a separately confirmed later request",
    "Full restart retains both target facts without replay; real uninstall removes executable/registration while preserving manuscript, encrypted profiles and v2 receipt",
  );
  if (appearancePublic)
    report.checks.push(
      `Actual public ${sourceVersion} author UI creates a fixed chosen historical portrait, edits the current appearance without changing the chosen version, and retains a separate unsaved appearance plus ${scenePublic ? "schema1" : "legacy unversioned"} scene draft; exact collection/history/image/v2 bytes survive upgrade`,
      "New installed host and post-uninstall exact portable runtime read the old chosen version/real preview and unchanged cached appearance with acknowledgement reset; scene draft remains unchanged across upgrade/restart until explicit author edit saves schema1 and one stable formal scene; uninstall preserves all data without model replay",
    );
  if (scenePublic)
    report.checks.push(
      `Actual public ${sourceVersion} host creates an arranged scene and planning snapshot; old tree, upgraded tree, full restart and post-uninstall portable runtime show the same scene ID/chapter position, exact material/planning bytes and unchanged schema1 draft until author save`,
    );
  if (importPublic) {
    assert.ok(report.legacyImportReadbacks >= 3);
    report.legacyImportPreserved = true;
    report.legacyOriginNotFabricated = !originPublic;
    report.legacyImportedBook = {
      id: legacyImportedBook.id,
      title: legacyImportedBook.title,
      chapterIds: legacyImportedBook.chapters.map((chapter) => chapter.id),
      chapterHashes: legacyImportedBook.chapters.map((chapter) => chapter.hash),
    };
    report.legacyImportFiles = legacyImportRecords.map((item) => ({
      name: item.path.split(/[\\/]/).slice(-1)[0],
      sha256: createHash("sha256").update(item.bytes).digest("hex"),
      bytes: item.bytes.length,
    }));
    report.checks.push(
      `Actual ${sourceVersion} author UI renames/splits a frozen source into three formal chapters; exact book/manuscript bytes, IDs and hashes survive current install, full restart and post-uninstall runtime; ${originPublic ? "original import-origin is preserved" : "new UI honestly reports absent legacy origin instead of inventing metadata"}`,
    );
    if (originPublic) {
      report.importOriginPreserved = true;
      report.originReadbacks = report.legacyImportReadbacks;
      report.originalImportOrigin = importedOrigin.origin;
      report.originFiles = originRecords.map((item) => ({
        name: "import-origin.json",
        bytes: item.bytes.length,
        sha256: createHash("sha256").update(item.bytes).digest("hex"),
      }));
      report.checks.push(
        "Actual public38 import-origin schema1, original producer version, source fingerprint and three chapter fingerprints remain byte-for-byte identical through new host, restart and post-uninstall runtime; no invented migration or receipt replacement",
      );
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) await terminateOwnedProcesses(owned);
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    process.exitCode = 1;
  }
  if (report.status === "failed") {
    try {
      await removeFailedOwnedInstall();
    } catch (error) {
      report.cleanupFailure = String(error);
      process.exitCode = 1;
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(out, "recent-upgrade-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
