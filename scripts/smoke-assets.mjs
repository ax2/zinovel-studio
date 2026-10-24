import { _electron as electron } from "playwright";
import electronPath from "electron";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "assets-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("图像资源合成作品", [
  { title: "第一章 旧信", body: "原稿保持独立。𠮷🌊" },
]);
const material = await store.materials.save(book.id, {
  kind: "character",
  title: "合成人物 林渡",
  notes: "合成",
  status: "planned",
  fields: {},
  chapterIds: [],
});
const source = join(data, "中文 空格 原图.png"),
  replacement = join(data, "方向 定妆.jpg"),
  badPath = join(data, "损坏 像素.png");
const pixels = Buffer.alloc(640 * 400 * 3);
for (let y = 0; y < 400; y++)
  for (let x = 0; x < 640; x++) {
    const p = (y * 640 + x) * 3;
    pixels[p] = Math.round((x / 640) * 200);
    pixels[p + 1] = Math.round((y / 400) * 200);
    pixels[p + 2] = Math.round(
      (Math.floor(x / 80) + Math.floor(y / 80)) % 2 ? 180 : 100,
    );
  }
const original = await sharp(pixels, {
    raw: { width: 640, height: 400, channels: 3 },
  })
    .png()
    .toBuffer(),
  jpg = await sharp(original)
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
const bad = Buffer.from(original);
bad[bad.indexOf(Buffer.from("IDAT")) + 5] ^= 255;
await writeFile(source, original);
await writeFile(replacement, jpg);
await writeFile(badPath, bad);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-006",
  "assets",
);
await mkdir(shots, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  nativeDialog:
    "Native file selection instrumented; actual host reads, decodes, stores and previews synthetic originals; no native picker interaction claim",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const panel = () =>
  page.getByRole("dialog", { name: "小说图像资源", exact: true });
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
    if (/^https?:/.test(r.url()))
      report.errors.push("Unexpected page HTTP request");
  });
  assert.equal(await page.title(), "ZiNovel Studio");
  assert.ok(page.url().endsWith("/index.html"));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function choose(path) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
}
async function open() {
  await page.getByRole("button", { name: "图像资源", exact: true }).click();
  await panel().waitFor();
}
async function imageReady() {
  await panel().getByRole("img").waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector(".asset-image img");
    return image && image.complete && image.naturalWidth > 0;
  });
}
async function shot(name) {
  await page.screenshot({ path: join(shots, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))),
  });
}
const fields = (record) =>
  Object.fromEntries(
    ["title", "purpose", "source", "rights", "notes", "linkedIds"].map(
      (key) => [key, record[key]],
    ),
  );
try {
  await launch();
  await page.getByLabel("正文编辑器").press("Control+End");
  await page.keyboard.insertText("\n导入前尚未自动保存的手工段落。");
  await open();
  const manuscript = join(
      data,
      "library",
      book.id,
      "manuscript",
      book.chapters[0].id + ".md",
    ),
    formal = await readFile(manuscript);
  assert.ok(formal.toString("utf8").includes("导入前尚未自动保存"));
  await choose(source);
  await panel().getByRole("button", { name: "导入原图", exact: true }).click();
  await imageReady();
  assert.equal(
    await panel().getByLabel("图像标题", { exact: true }).inputValue(),
    "中文 空格 原图",
  );
  await panel()
    .getByLabel("图像标题", { exact: true })
    .fill("雾港 · 人物定妆𠮷🌊");
  await panel()
    .getByLabel("图像用途", { exact: true })
    .selectOption("portrait");
  await panel()
    .getByLabel("来源说明", { exact: true })
    .fill("程序合成图；无真人素材。");
  await panel()
    .getByLabel("权利与使用范围", { exact: true })
    .fill("合成验收专用");
  await panel()
    .getByLabel("图像笔记", { exact: true })
    .fill("角色声音和图像分开核对。");
  await panel()
    .getByText(/关联人物、地点或其他创作资料/)
    .click();
  await panel()
    .getByRole("checkbox", { name: material.title, exact: true })
    .check();
  await panel()
    .getByRole("button", { name: "保存图像说明", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像说明已保存" })
    .waitFor();
  let saved = (await store.assets.list(book.id)).items[0];
  assert.equal(saved.blob.sha256, binaryHash(original));
  assert.deepEqual(saved.linkedIds, [material.id]);
  const firstId = saved.id;
  await shot("asset-desktop.png");
  await panel()
    .getByLabel("图像笔记", { exact: true })
    .fill("本机草稿𠮷🌊，关闭后继续编辑。");
  await panel()
    .getByRole("button", { name: "关闭图像资源", exact: true })
    .click();
  await open();
  await panel()
    .locator(".asset-list button")
    .filter({ hasText: saved.title })
    .click();
  assert.equal(
    await panel().getByLabel("图像笔记", { exact: true }).inputValue(),
    "本机草稿𠮷🌊，关闭后继续编辑。",
  );
  await panel().getByLabel("图像笔记", { exact: true }).press("Control+s");
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像说明已保存" })
    .waitFor();
  saved = await store.assets.read(book.id, firstId);
  await panel().getByLabel("图像标题", { exact: true }).fill("");
  await panel()
    .getByLabel("图像笔记", { exact: true })
    .fill("标题暂空时仍须恢复的说明𠮷。");
  await panel()
    .getByRole("button", { name: "关闭图像资源", exact: true })
    .click();
  await open();
  await panel()
    .locator(".asset-list button")
    .filter({ hasText: saved.title })
    .click();
  assert.equal(
    await panel().getByLabel("图像标题", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await panel().getByLabel("图像标题", { exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await panel().getByLabel("图像笔记", { exact: true }).inputValue(),
    "标题暂空时仍须恢复的说明𠮷。",
  );
  await panel().getByLabel("图像标题", { exact: true }).fill(saved.title);
  await panel()
    .getByRole("button", { name: "保存图像说明", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像说明已保存" })
    .waitFor();
  saved = await store.assets.read(book.id, firstId);
  const priorRevision = saved.revision;
  await store.assets.save(
    book.id,
    { ...fields(saved), notes: "外部编辑器改写的说明。" },
    saved,
  );
  await panel()
    .getByLabel("图像标题", { exact: true })
    .fill("作者窗口仍在编辑");
  assert.equal(
    await panel()
      .getByRole("button", { name: "替换原图并保留历史", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("button", { name: "保存图像说明", exact: true })
    .click();
  await panel()
    .locator(".assets-notices")
    .getByRole("alert")
    .filter({ hasText: /图像资源已被其他操作修改/ })
    .waitFor();
  assert.equal(
    await panel().getByLabel("图像标题", { exact: true }).inputValue(),
    "作者窗口仍在编辑",
  );
  await panel()
    .getByRole("button", { name: "读取磁盘版本供对照", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "保留调整并采用当前磁盘基线", exact: true })
    .waitFor();
  await panel()
    .locator("summary")
    .filter({ hasText: /^磁盘说明供对照/ })
    .click();
  await panel()
    .locator("pre")
    .filter({ hasText: "外部编辑器改写的说明。" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "保留调整并采用当前磁盘基线", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "保存图像说明", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像说明已保存" })
    .waitFor();
  saved = await store.assets.read(book.id, firstId);
  assert.equal(saved.revision, priorRevision + 2);
  assert.equal(saved.title, "作者窗口仍在编辑");
  await choose(replacement);
  await panel()
    .getByRole("button", { name: "替换原图并保留历史", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已替换为新图" })
    .waitFor();
  await imageReady();
  saved = await store.assets.read(book.id, firstId);
  assert.equal(saved.blob.displayWidth, 400);
  assert.equal(saved.blob.displayHeight, 640);
  assert.equal(saved.blob.sha256, binaryHash(jpg));
  await panel()
    .getByRole("button", { name: /^查看第1版图像 ·/ })
    .click();
  await panel()
    .getByRole("heading", { name: "历史图像 · 第1版", exact: true })
    .waitFor();
  await imageReady();
  assert.equal(
    (await store.assets.read(book.id, firstId)).blob.sha256,
    binaryHash(jpg),
  );
  await panel()
    .getByRole("button", { name: "查看当前版本图像", exact: true })
    .click();
  await imageReady();
  await panel()
    .getByRole("button", { name: /^查看第1版图像 ·/ })
    .click();
  await panel()
    .getByRole("button", { name: "采用此历史图像与说明为新版本", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已将历史图像及当时说明保存为新版本" })
    .waitFor();
  saved = await store.assets.read(book.id, firstId);
  assert.equal(saved.blob.sha256, binaryHash(original));
  assert.equal(saved.title, "中文 空格 原图");
  await choose(replacement);
  await panel()
    .getByRole("button", { name: "替换原图并保留历史", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已替换为新图" })
    .waitFor();
  await imageReady();
  saved = await store.assets.read(book.id, firstId);
  await panel()
    .getByRole("button", { name: "移入图像回收站", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已移入回收站" })
    .waitFor();
  await panel()
    .getByRole("checkbox", { name: "查看回收站", exact: true })
    .check();
  await panel()
    .getByRole("button", { name: "恢复图像资源", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像资源已恢复" })
    .waitFor();
  await panel()
    .getByRole("checkbox", { name: "查看回收站", exact: true })
    .uncheck();
  await page.setViewportSize({ width: 806, height: 803 });
  await panel().getByRole("img").scrollIntoViewIfNeeded();
  await shot("asset-narrow.png");
  assert.equal(
    await panel().evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await panel()
    .getByRole("button", { name: "关闭图像资源", exact: true })
    .click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await open();
  await panel()
    .locator(".asset-list button")
    .filter({ hasText: saved.title })
    .click();
  await imageReady();
  await panel().getByRole("img").scrollIntoViewIfNeeded();
  await shot("asset-dark-narrow.png");
  await page.evaluate(() => {
    globalThis.assetOriginalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("zinovel.asset-draft."))
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return globalThis.assetOriginalSet.call(this, key, value);
    };
  });
  await panel()
    .getByLabel("图像笔记", { exact: true })
    .fill("配额失败不能丢失的输入。𠮷");
  await panel()
    .getByRole("button", { name: "关闭图像资源", exact: true })
    .click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "本机图像草稿暂不能保存" })
    .waitFor();
  assert.equal(
    await panel().getByLabel("图像笔记", { exact: true }).inputValue(),
    "配额失败不能丢失的输入。𠮷",
  );
  await shot("asset-quota-protected.png");
  await page.evaluate(() => {
    Storage.prototype.setItem = globalThis.assetOriginalSet;
  });
  await panel()
    .getByRole("button", { name: "保存图像说明", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "图像说明已保存" })
    .waitFor();
  await choose(badPath);
  await panel().getByRole("button", { name: "导入原图", exact: true }).click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "图像无法完整解码" })
    .waitFor();
  assert.equal((await store.assets.list(book.id)).total, 1);
  await panel()
    .getByRole("button", { name: "检查这次导入", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "尚未找到该次导入" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "放弃这次待确认导入", exact: true })
    .click();
  saved = await store.assets.read(book.id, firstId);
  const blobPath = join(
      data,
      "library",
      book.id,
      "assets/blobs",
      saved.blob.sha256 + "." + saved.blob.format,
    ),
    corrupt = Buffer.from(jpg);
  corrupt[corrupt.length - 1] ^= 255;
  await writeFile(blobPath, corrupt);
  await panel().getByRole("button", { name: "刷新资源", exact: true }).click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "原图字节校验失败" })
    .waitFor();
  assert.deepEqual(await readFile(blobPath), corrupt);
  await shot("asset-corrupt-original.png");
  await writeFile(blobPath, jpg);
  await panel().getByRole("button", { name: "刷新资源", exact: true }).click();
  await imageReady();
  const draftKey = `zinovel.asset-draft.${book.id}.${firstId}`,
    future = JSON.stringify({
      schemaVersion: 99,
      keep: "PRESERVE_FUTURE_ASSET_FORM",
    });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: draftKey,
    value: future,
  });
  await panel()
    .getByRole("button", { name: "关闭图像资源", exact: true })
    .click();
  await close();
  await launch();
  await open();
  await panel()
    .locator(".asset-list button")
    .filter({ hasText: saved.title })
    .click();
  await panel()
    .getByText("未知本机草稿已保留，明确放弃后才能编辑。", { exact: true })
    .waitFor();
  assert.equal(
    await panel().getByLabel("图像标题", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await panel()
    .getByRole("button", { name: "放弃本机调整并重新读取", exact: true })
    .click();
  await imageReady();
  await choose(source);
  await page.evaluate(
    async ({ bookId }) => {
      const id = crypto.randomUUID();
      localStorage.setItem(
        "zinovel.asset-import." + bookId,
        JSON.stringify({ schemaVersion: 1, bookId, id }),
      );
      // Synthetic checkpoint: commit through the real host, leave the operation result unconsumed by the panel.
      await window.novel.request("assets.import", { bookId, creationId: id });
    },
    { bookId: book.id },
  );
  assert.equal((await store.assets.list(book.id)).total, 2);
  await close();
  await launch();
  await open();
  await panel()
    .getByRole("button", { name: "检查这次导入", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已找到该次导入的保存记录" })
    .waitFor();
  assert.equal((await store.assets.list(book.id)).total, 2);
  await imageReady();
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(replacement), jpg);
  assert.deepEqual(await readFile(badPath), bad);
  assert.deepEqual(await readFile(manuscript), formal);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual editor flush, native-choice-instrumented import, exact originals, current PNG preview, purpose/source/rights/linked character metadata and Ctrl+S saved once; local draft including temporarily empty title survives modal close",
    "external metadata conflict preserves author input; explicit disk comparison/rebase saves new version; JPEG EXIF preview and old-image history remain independent; explicit history adoption creates a new version retaining later originals; recycle/restore preserve originals",
    "corrupt image import creates no visible record; external original corruption refuses preview and preserves damaged bytes; explicit synthetic repair re-enables preview",
    "quota error protects modal input; unknown future draft survives full restart until explicit discard; synthetic durable host commit without panel receipt recovers by creation identity after restart without duplicate records",
    "desktop/806px narrow/dark screenshots, zero horizontal overflow, zero renderer errors or external page requests; all source files and formal manuscript remain byte-identical",
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
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(shots, "assets-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report);
  }
}
