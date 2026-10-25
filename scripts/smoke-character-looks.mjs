import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "character-looks-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("形象版本合成验收", [
  { title: "旧港来信", body: "原稿𠮷🌊\r\n定妆操作不改正文。" },
]);
const material = await store.materials.save(book.id, {
  kind: "character",
  title: "合成人物 林渡",
  status: "planned",
  fields: { appearance: "蓝衣短疤" },
  notes: "合成验收人物",
  chapterIds: [],
});
const pixels = await sharp({
  create: { width: 240, height: 320, channels: 3, background: "#147b82" },
})
  .png()
  .toBuffer();
const asset = await store.assets.import(book.id, pixels, {
  title: "合成蓝衣定妆图",
  purpose: "portrait",
  source: "程序合成",
  rights: "合成验收",
  notes: "无真实人物",
  linkedIds: [material.id],
});
const body = await store.readChapter(book.id, book.chapters[0].id),
  bodyPath = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  ),
  originalBody = await readFile(bodyPath);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-006",
  "character-looks",
);
await mkdir(shots, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Synthetic offline appearance versions and explicit portrait choice; no reference-image generation, real visual quality or native IME claim",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const panel = () =>
  page.getByRole("region", { name: "人物形象版本", exact: true });
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) report.errors.push(m.text());
  });
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) report.errors.push("Unexpected HTTP request");
  });
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = binaryHash(await readFile(runtime.path));
  else
    report.desktopBundleSha256 = binaryHash(
      await readFile(join(root, "dist/desktop/main.cjs")),
    );
  if (!runtime.packaged) {
    const files = {};
    for (const name of ["app.js", "app.css", "index.html"])
      files[name] = binaryHash(
        await readFile(join(root, "dist/workbench", name)),
      );
    if (report.workbenchFilesSha256)
      assert.deepEqual(files, report.workbenchFilesSha256);
    report.workbenchFilesSha256 = files;
  }
  await page.waitForURL(/\/workbench\/index\.html$/);
  assert.equal(await page.title(), "ZiNovel Studio");
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (await page.getByTitle("打开创作参考").isVisible())
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
  await page
    .getByRole("region", { name: "创作资料", exact: true })
    .getByRole("button", { name: new RegExp(material.title) })
    .click();
  await page.locator(".character-looks > summary").click();
  await panel()
    .getByRole("button", { name: "新建形象版本", exact: true })
    .waitFor();
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function screenshot(name) {
  await page.screenshot({ path: join(shots, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      theme: document.documentElement.dataset.theme,
    }))),
  });
}
try {
  await launch();
  await panel()
    .getByRole("button", { name: "新建形象版本", exact: true })
    .click();
  await panel().getByLabel("形象名称", { exact: true }).fill("少年蓝衣𠮷🌊");
  await panel().getByLabel("年龄描述", { exact: true }).fill("约十六岁");
  await panel().getByLabel("衣装", { exact: true }).fill("旧蓝外套");
  await panel().getByLabel("剧情时期", { exact: true }).fill("第一卷旧港");
  await panel()
    .getByLabel("此版本使用的固定图像", { exact: true })
    .selectOption(asset.id);
  await panel()
    .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "形象版本已保存" })
    .waitFor();
  let state = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  assert.equal(state.record.selected, null);
  assert.equal(state.record.entries.length, 1);
  const id = state.record.entries[0].id;
  await panel()
    .getByRole("button", { name: "预览此形象", exact: true })
    .click();
  await panel().getByAltText("形象候选固定版本预览", { exact: true }).waitFor();
  assert.equal(
    await panel()
      .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByLabel("我已核对人物与固定版本，确认本次定妆选择", { exact: true })
    .check();
  await panel()
    .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
    .click();
  await panel().getByRole("status").filter({ hasText: "已明确选定" }).waitFor();
  state = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  assert.equal(state.selectedEntry.input.outfit, "旧蓝外套");
  report.checks.push(
    "Actual Electron author controls save an offline fixed-resource appearance without selecting it, preview it, and require a separate explicit acknowledgement before choosing current portrait",
  );
  await panel()
    .getByRole("button", { name: "编辑形象版本", exact: true })
    .click();
  await panel().getByLabel("衣装", { exact: true }).fill("成年灰大衣");
  await panel().getByLabel("年龄描述", { exact: true }).fill("三十岁");
  await panel()
    .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "形象版本已保存" })
    .waitFor();
  state = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  assert.equal(state.record.entries[0].input.outfit, "成年灰大衣");
  assert.equal(state.selectedEntry.input.outfit, "旧蓝外套");
  await panel().getByLabel("筛选人物形象", { exact: true }).fill("成年灰大衣");
  assert.equal(
    await panel()
      .getByRole("button", { name: "编辑形象版本", exact: true })
      .count(),
    1,
  );
  await panel()
    .getByLabel("筛选人物形象", { exact: true })
    .fill("不存在的衣装");
  await panel()
    .getByText("此筛选下暂无形象；当前定妆仍单独保留在上方。", { exact: true })
    .waitFor();
  assert.equal(
    await panel()
      .getByRole("button", { name: "编辑形象版本", exact: true })
      .count(),
    0,
  );
  await panel().getByLabel("筛选人物形象", { exact: true }).fill("");
  await panel()
    .getByRole("button", { name: "预览当前定妆", exact: true })
    .click();
  await panel().getByAltText("当前定妆固定版本预览", { exact: true }).waitFor();
  await screenshot("fixed-portrait-light.png");
  report.checks.push(
    "Later age/outfit edits create a new appearance revision while the original chosen portrait and its historical image remain explicitly visible and unchanged",
  );
  await panel()
    .getByRole("button", { name: "编辑形象版本", exact: true })
    .click();
  await panel()
    .getByLabel("形象备注", { exact: true })
    .fill("未保存形象草稿𠮷🌊");
  await close();
  await launch();
  assert.equal(
    await panel().getByLabel("形象备注", { exact: true }).inputValue(),
    "未保存形象草稿𠮷🌊",
  );
  assert.equal(
    await panel()
      .getByLabel("我已核对人物与固定版本，确认本次定妆选择", { exact: true })
      .isChecked(),
    false,
  );
  await panel()
    .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "形象版本已保存" })
    .waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(806, 803);
  });
  await page.getByTitle("打开创作参考", { exact: true }).click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await panel()
    .getByRole("button", { name: "预览此形象", exact: true })
    .click();
  await panel().getByAltText("形象候选固定版本预览", { exact: true }).waitFor();
  await panel()
    .getByLabel("我已核对人物与固定版本，确认本次定妆选择", { exact: true })
    .check();
  await panel()
    .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
    .scrollIntoViewIfNeeded();
  await panel()
    .getByLabel("我已核对人物与固定版本，确认本次定妆选择", { exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("preview-confirm-dark-narrow.png");
  await panel()
    .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("choose-portrait-dark-narrow.png");
  await panel()
    .getByRole("button", { name: "明确选此版本为当前定妆", exact: true })
    .click();
  await panel().getByRole("status").filter({ hasText: "已明确选定" }).waitFor();
  state = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  assert.equal(state.selectedEntry.input.outfit, "成年灰大衣");
  assert.equal(state.selectedEntry.input.notes, "未保存形象草稿𠮷🌊");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await assert.rejects(
    request("looks.read", {
      bookId: book.id,
      characterId: material.id,
      path: "C:/must-not-read",
    }),
    /格式不支持/,
  );
  assert.deepEqual(await readFile(bodyPath), originalBody);
  assert.equal(body.body, originalBody.toString("utf8"));
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
  report.checks.push(
    "Full restart restores only the local appearance draft and clears choice confirmation; dark narrow author controls explicitly choose the newer version, reject arbitrary-path IPC, preserve manuscript bytes and emit no renderer errors or HTTP requests",
  );
  await panel()
    .getByRole("button", { name: "编辑形象版本", exact: true })
    .click();
  await page.evaluate(() => {
    globalThis.looksOriginalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("zinovel.character-look-draft."))
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return globalThis.looksOriginalSet.call(this, key, value);
    };
  });
  await panel()
    .getByLabel("形象备注", { exact: true })
    .fill("配额失败仍须保留𠮷🌊");
  await panel()
    .getByRole("alert")
    .filter({ hasText: "形象草稿暂存失败" })
    .waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.equal(
    await panel().getByLabel("形象备注", { exact: true }).inputValue(),
    "配额失败仍须保留𠮷🌊",
  );
  await screenshot("quota-close-protected.png");
  await page.evaluate(() => {
    Storage.prototype.setItem = globalThis.looksOriginalSet;
  });
  await panel()
    .getByRole("button", { name: "保存形象版本（不自动选定）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "形象版本已保存" })
    .waitFor();
  const beforeFuture = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  const draftKey = `zinovel.character-look-draft.${book.id}.${material.id}`,
    future = JSON.stringify({
      schemaVersion: 99,
      input: "未来形象草稿必须保留𠮷🌊",
    });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: draftKey,
    value: future,
  });
  await close();
  await launch();
  await panel().getByRole("alert").filter({ hasText: "格式不支持" }).waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  assert.equal(
    await panel()
      .getByRole("button", { name: "新建形象版本", exact: true })
      .isDisabled(),
    true,
  );
  const afterFuture = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  assert.deepEqual(afterFuture.record, beforeFuture.record);
  await panel()
    .getByRole("button", { name: "丢弃本机形象草稿", exact: true })
    .click();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  let seeded = await request("looks.read", {
    bookId: book.id,
    characterId: material.id,
  });
  for (let i = 0; i < 21; i++)
    seeded = await request("looks.save", {
      bookId: book.id,
      character: seeded.character,
      expected: {
        revision: seeded.record.revision,
        diskHash: seeded.record.diskHash,
      },
      entryId: crypto.randomUUID(),
      input: {
        ...seeded.record.entries[0].input,
        title: `批次 ${i}`,
        outfit: "分页合成衣装",
      },
      asset: {
        id: asset.id,
        revision: asset.revision,
        diskHash: asset.diskHash,
      },
    });
  await panel()
    .getByRole("button", { name: "重新读取形象（保留草稿）", exact: true })
    .click();
  await panel().getByText("22 个匹配形象 · 第 1 页", { exact: true }).waitFor();
  assert.equal(
    await panel()
      .getByRole("button", { name: "预览此形象", exact: true })
      .count(),
    20,
  );
  await panel()
    .getByRole("button", { name: "下一页形象", exact: true })
    .click();
  assert.equal(
    await panel()
      .getByRole("button", { name: "预览此形象", exact: true })
      .count(),
    2,
  );
  await panel().getByLabel("筛选人物形象", { exact: true }).fill("批次 20");
  assert.equal(
    await panel()
      .getByRole("button", { name: "预览此形象", exact: true })
      .count(),
    1,
  );
  await panel().getByLabel("筛选人物形象", { exact: true }).fill("");
  assert.deepEqual(await readFile(bodyPath), originalBody);
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
  report.checks.push(
    "Synthetic local quota failure retains typed appearance notes and cancels actual window close until formal save; an unknown future draft survives full restart byte-for-byte, blocks replacement, and is removed only by explicit discard without changing saved appearances or manuscript",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else await close();
    }
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error.stack || error);
    throw error;
  } finally {
    await writeFile(
      join(shots, "character-looks-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report);
  }
}
