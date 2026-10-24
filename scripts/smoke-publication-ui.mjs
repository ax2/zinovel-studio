import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "publication-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("雾港发布合成稿", [
  {
    title: "第一章 旧信",
    body: "第一章原稿𠮷🌊\n<script>window.PUBLICATION_SCRIPT_RAN=true</script>",
  },
  { title: "第二章 渡口", body: "第二章结尾。" },
  { title: "第三章 未来", body: "EXCLUDED_FUTURE_SENTINEL" },
]);
await store.materials.save(book.id, {
  kind: "proposition",
  title: "AUTHOR_PRIVATE_SENTINEL",
  notes: "作者未来秘密",
  status: "planned",
  fields: { claim: "作者秘密", truthIntent: "作者设定为真" },
  chapterIds: [],
});
const exports = join(data, "中文 空格 导出目录");
await mkdir(exports);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "publication-ui",
);
await mkdir(shots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const name of Object.keys(env))
    if (name.toLowerCase() === "path") delete env[name];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  nativeDialog:
    "Folder choice instrumented; real host writes and real files verified; native picker interaction not covered",
};
let app, page, owned;
const panel = () =>
  page.getByRole("dialog", { name: "导出发布副本", exact: true });
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
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      report.errors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("unexpected page network request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
async function open() {
  await page.getByRole("button", { name: "导出与发布", exact: true }).click();
  await panel().waitFor();
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
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
async function finishedCount(count) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const entries = (await readdir(exports)).filter(
      (name) => !name.startsWith("."),
    );
    if (entries.length === count) return entries;
    await page.waitForTimeout(30);
  }
  throw new Error("Export files did not settle");
}
try {
  await launch();
  assert.equal(await page.title(), "ZiNovel Studio");
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n尚未自动保存就打开发布。");
  await open();
  const chapter = await store.readChapter(book.id, book.chapters[0].id);
  assert.ok(chapter.body.endsWith("尚未自动保存就打开发布。"));
  const manuscript = join(
      data,
      "library",
      book.id,
      "manuscript",
      chapter.id + ".md",
    ),
    before = await readFile(manuscript);
  await panel().getByLabel("公开书名", { exact: true }).fill("雾港选章");
  await panel().getByLabel("署名", { exact: true }).fill("合成作者");
  await panel()
    .locator("summary")
    .filter({ hasText: "简介、版权与 AI 说明" })
    .click();
  await panel()
    .getByLabel("公开简介", { exact: true })
    .fill("公开简介与罕字𠮷。");
  await panel().getByLabel("版权说明", { exact: true }).fill("合成测试文本");
  await panel().getByLabel("AI 辅助说明", { exact: true }).fill("仅测试");
  await panel()
    .getByRole("checkbox", { name: /第一章 旧信/ })
    .check();
  await panel()
    .getByRole("checkbox", { name: /第二章 渡口/ })
    .check();
  await panel()
    .getByRole("button", { name: "上移第2个选章", exact: true })
    .click();
  assert.deepEqual(
    await panel().locator(".publication-order li > span").allTextContents(),
    ["第二章 渡口", "第一章 旧信"],
  );
  await page.keyboard.press("Control+s");
  assert.equal((await store.publication.list(book.id)).snapshots.length, 0);
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await panel().waitFor({ state: "hidden" });
  await open();
  assert.equal(
    await panel().getByLabel("公开书名", { exact: true }).inputValue(),
    "雾港选章",
  );
  assert.deepEqual(
    await panel().locator(".publication-order li > span").allTextContents(),
    ["第二章 渡口", "第一章 旧信"],
  );
  await panel()
    .getByRole("button", { name: "创建发布副本", exact: true })
    .click();
  await panel()
    .getByRole("article", { name: "发布副本章节：第二章 渡口", exact: true })
    .waitFor();
  const saved = (await store.publication.list(book.id)).snapshots[0];
  assert.equal(saved.chapterCount, 2);
  assert.equal(await panel().locator(".publication-history button").count(), 1);
  assert.doesNotMatch(
    await panel().locator(".publication-preview").innerText(),
    /EXCLUDED_FUTURE_SENTINEL|AUTHOR_PRIVATE_SENTINEL/,
  );
  await panel()
    .getByLabel("副本章节", { exact: true })
    .selectOption(chapter.id);
  await panel()
    .getByRole("article", { name: "发布副本章节：第一章 旧信", exact: true })
    .getByText(/尚未自动保存就打开发布/)
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.PUBLICATION_SCRIPT_RAN),
    undefined,
  );
  await shot("desktop-frozen-preview.png");
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  await panel()
    .getByText("已取消导出，未创建文件。", { exact: true })
    .waitFor();
  assert.deepEqual(await readdir(exports), []);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, exports);
  for (const [index, format] of ["txt", "md", "html"].entries()) {
    await panel()
      .getByLabel("发布副本导出格式", { exact: true })
      .selectOption(format);
    await panel()
      .getByRole("button", { name: "导出此副本", exact: true })
      .click();
    const entries = await finishedCount(index + 1),
      name = entries.find((name) => name.includes(`-${format}-`));
    assert.ok(name);
    const output = join(exports, name),
      manifest = JSON.parse(
        await readFile(join(output, "publication-manifest.json"), "utf8"),
      );
    assert.equal(manifest.state, "exported");
    assert.equal(manifest.snapshotHash, saved.hash);
    for (const file of manifest.files) {
      const bytes = await readFile(join(output, file.path));
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
      );
      assert.doesNotMatch(
        bytes.toString("utf8"),
        /EXCLUDED_FUTURE_SENTINEL|AUTHOR_PRIVATE_SENTINEL/,
      );
    }
    if (format === "html") report.htmlDirectory = output;
  }
  assert.deepEqual(await readFile(manuscript), before);
  await page.setViewportSize({ width: 806, height: 803 });
  await panel()
    .getByRole("heading", { name: "雾港选章", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("narrow-frozen-preview.png");
  await panel()
    .getByRole("article", { name: "发布副本章节：第一章 旧信", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("narrow-reading-body.png");
  assert.equal(
    await panel().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  );
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await close();
  await launch();
  await open();
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "雾港选章" })
    .click();
  await panel()
    .getByRole("article", { name: "发布副本章节：第二章 渡口", exact: true })
    .waitFor();
  assert.deepEqual(await readFile(manuscript), before);
  const draftKey = `zinovel.publication-form.${book.id}`;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__restorePublicationStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.publication-form."))
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await panel()
    .getByLabel("公开书名", { exact: true })
    .fill("不能丢失的发布表单");
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await panel()
    .getByText(/发布表单尚未保存到本机缓存/)
    .waitFor();
  assert.equal(
    await panel().getByLabel("公开书名", { exact: true }).inputValue(),
    "不能丢失的发布表单",
  );
  await page.evaluate(() => {
    window.__restorePublicationStorage();
    delete window.__restorePublicationStorage;
  });
  await panel()
    .getByRole("button", { name: "重试保存表单", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await open();
  assert.equal(
    await panel().getByLabel("公开书名", { exact: true }).inputValue(),
    "不能丢失的发布表单",
  );
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "雾港选章" })
    .click();
  await panel()
    .getByLabel("副本章节", { exact: true })
    .selectOption(chapter.id);
  await panel()
    .getByRole("article", { name: "发布副本章节：第一章 旧信", exact: true })
    .getByText(/尚未自动保存就打开发布/)
    .waitFor();
  await writeFile(manuscript, "作者捕获后明确外部改稿。𠮷", "utf8");
  const previousExports = new Set(await readdir(exports));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, exports);
  await panel()
    .getByLabel("发布副本导出格式", { exact: true })
    .selectOption("txt");
  await panel()
    .getByRole("button", { name: "导出此副本", exact: true })
    .click();
  const afterEditExports = await finishedCount(4),
    newExport = afterEditExports.find((name) => !previousExports.has(name));
  const oldText = await readFile(join(exports, newExport, "book.txt"), "utf8");
  assert.match(oldText, /雾港选章/);
  assert.doesNotMatch(oldText, /不能丢失的发布表单|作者捕获后明确外部改稿/);
  assert.ok(oldText.includes(before.toString("utf8")));
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  const unknown = JSON.stringify({
    schemaVersion: 99,
    bookId: book.id,
    ids: [],
    metadata: {},
    future: "KEEP_FUTURE_FORM",
  });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: draftKey,
    value: unknown,
  });
  await open();
  await panel()
    .getByText(/本机发布表单缓存无法识别/)
    .waitFor();
  assert.equal(
    await panel()
      .getByRole("button", { name: "创建发布副本", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await close();
  await launch();
  await open();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    unknown,
  );
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "雾港选章" })
    .click();
  await panel()
    .getByRole("article", { name: "发布副本章节：第二章 渡口", exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "明确重置发布表单", exact: true })
    .click();
  assert.equal(
    await panel().getByLabel("公开书名", { exact: true }).inputValue(),
    book.title,
  );
  assert.equal((await store.publication.list(book.id)).snapshots.length, 1);
  assert.equal(
    await readFile(manuscript, "utf8"),
    "作者捕获后明确外部改稿。𠮷",
  );
  await panel()
    .getByRole("button", { name: "关闭发布副本", exact: true })
    .click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await page.setViewportSize({ width: 806, height: 803 });
  await open();
  await panel()
    .locator(".publication-history button")
    .filter({ hasText: "雾港选章" })
    .click();
  await panel()
    .getByRole("article", { name: "发布副本章节：第二章 渡口", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("dark-narrow-frozen-preview.png");
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual unsaved editor entry flushes before publication; public metadata and explicitly reordered chapter selection survive modal close; Ctrl+S saves form without creating a snapshot",
    "actual create and chapter preview show the exact frozen selection, escape literal script and exclude unselected/private contents; full desktop restart reads the durable copy",
    "native-folder cancellation is instrumented and creates no files; real host TXT/MD/HTML writes to Chinese/space directory verify every file hash and preserve source bytes",
    "desktop and 806px narrow dialog render without horizontal overflow; no page errors or external page requests",
    "form quota failure blocks close and preserves input until retry; unknown future form survives modal close and full restart until explicit reset; later form/source edits cannot change the selected frozen export",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(shots, "publication-ui-smoke.json"),
    JSON.stringify(report, null, 2),
  );
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
      join(shots, "publication-ui-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
