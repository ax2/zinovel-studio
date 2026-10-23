import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "reader-ui-")),
  store = new NovelStore(join(data, "library"));
let book = await store.importBook("无剧透阅读合成稿", [
  {
    title: "第一章 旧信",
    volume: "卷一 港口",
    body: Array.from(
      { length: 120 },
      (_, n) => `第${n + 1}段：林舟在港口等候来信。🌊`,
    ).join("\n"),
  },
  {
    title: "第二章 渡口",
    volume: "卷一 港口",
    body: "船离开了渡口。\n<script>window.READER_SCRIPT_RAN=true</script>",
  },
  { title: "第三章 远海", volume: "卷二 远海", body: "新的地址。" },
]);
book = await store.updateStructure(book.id, book.revision, {
  type: "chapter-status",
  chapterId: book.chapters[1].id,
  status: "final",
});
await store.materials.save(book.id, {
  kind: "proposition",
  title: "AUTHOR_PRIVATE_SENTINEL",
  notes: "FUTURE_WORLD_SECRET",
  status: "planned",
  fields: { claim: "船主是父亲", truthIntent: "作者设定为真" },
  chapterIds: [],
});
const empty = await store.createBook("零章阅读合成稿"),
  key = `zinovel.reading.${book.id}`,
  shots = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-005",
    "reader",
  );
await mkdir(shots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const name of Object.keys(env))
    if (name.toLowerCase() === "path") delete env[name];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page, owned;
const report = { status: "running", checks: [], errors: [], viewports: [] };
const reader = () =>
  page.getByRole("dialog", { name: "独立阅读预览", exact: true });
async function launch(title = book.title) {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(application.process().pid);
  page = await application.firstWindow({ timeout: 45000 });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("unexpected network request");
  });
  await page.locator(".book-card").filter({ hasText: title }).click();
  await page.getByRole("button", { name: "阅读预览", exact: true }).waitFor();
}
async function open() {
  await page.getByRole("button", { name: "阅读预览", exact: true }).click();
  await reader().waitFor();
}
async function closeApp() {
  await application.close();
  await confirmOwnedProcessesExited(owned);
  application = null;
  owned = null;
}
async function chapter(title) {
  await reader()
    .getByRole("article", { name: `阅读章节：${title}`, exact: true })
    .waitFor();
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
async function progress() {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
}
async function waitProgress(predicate) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const result = await progress();
    if (predicate(result)) return result;
    await page.waitForTimeout(50);
  }
  throw new Error("Reading progress did not settle");
}
try {
  await launch();
  // Author a not-yet-autosaved change, then immediately enter reading through the real button.
  const editor = page.getByLabel("正文编辑器", { exact: true });
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n未自动保存前打开阅读。");
  await open();
  await chapter("第一章 旧信");
  if (process.env.ZINOVEL_READER_CLEANUP_FAULT === "1")
    throw new Error("synthetic-reader-cleanup-checkpoint");
  const saved = await store.readChapter(book.id, book.chapters[0].id);
  assert.ok(saved.body.endsWith("未自动保存前打开阅读。"));
  const manuscript = join(
      data,
      "library",
      book.id,
      "manuscript",
      `${saved.id}.md`,
    ),
    beforeReading = await readFile(manuscript);
  assert.doesNotMatch(
    await reader().innerText(),
    /AUTHOR_PRIVATE_SENTINEL|FUTURE_WORLD_SECRET/,
  );
  assert.equal(
    await reader()
      .getByRole("button", { name: "生成候选", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "生成候选", exact: true })
      .evaluate((element) => {
        const before = document.activeElement;
        element.focus();
        return (
          !!element.closest("[inert]") && document.activeElement === before
        );
      }),
    true,
  );
  assert.equal(await reader().getByRole("textbox").count(), 0);
  await reader().getByLabel("阅读字体大小", { exact: true }).selectOption("24");
  await reader().getByLabel("阅读行距", { exact: true }).selectOption("2.1");
  await reader().getByLabel("阅读背景", { exact: true }).selectOption("dark");
  await reader().getByLabel("阅读版面", { exact: true }).selectOption("phone");
  const paper = reader().getByRole("article", {
    name: "阅读章节：第一章 旧信",
    exact: true,
  });
  assert.equal(Math.round((await paper.boundingBox()).width), 390);
  await reader().getByLabel("小说阅读正文", { exact: true }).hover();
  await page.mouse.wheel(0, 2400);
  const bookmark = await waitProgress(
    (value) => value?.progress?.paragraph > 5,
  );
  await shot("phone-dark-progress.png");
  await closeApp();
  await launch();
  await open();
  await chapter("第一章 旧信");
  assert.equal(
    await reader().getByLabel("阅读字体大小", { exact: true }).inputValue(),
    "24",
  );
  assert.equal(
    await reader().getByLabel("阅读背景", { exact: true }).inputValue(),
    "dark",
  );
  await reader()
    .getByLabel("阅读进度", { exact: true })
    .filter({ hasText: `第 ${bookmark.progress.paragraph + 1}/` })
    .waitFor();
  assert.equal(
    (await progress()).progress.paragraph,
    bookmark.progress.paragraph,
  );
  await reader().getByRole("button", { name: "下一章", exact: true }).click();
  await chapter("第二章 渡口");
  assert.equal(await page.evaluate(() => window.READER_SCRIPT_RAN), undefined);
  await reader()
    .getByText("<script>window.READER_SCRIPT_RAN=true</script>", {
      exact: true,
    })
    .waitFor();
  await reader()
    .getByLabel("阅读章节范围", { exact: true })
    .selectOption("final");
  await chapter("第二章 渡口");
  assert.equal(
    await reader()
      .getByLabel("阅读章节目录", { exact: true })
      .getByRole("button")
      .count(),
    1,
  );
  await reader()
    .getByLabel("阅读章节范围", { exact: true })
    .selectOption("all");
  await chapter("第二章 渡口");
  await reader()
    .getByLabel("阅读分卷", { exact: true })
    .selectOption(book.volumes[1].id);
  await chapter("第三章 远海");
  await reader().getByLabel("阅读分卷", { exact: true }).selectOption("");
  await reader()
    .getByLabel("阅读章节目录", { exact: true })
    .getByRole("button", { name: "第一章 旧信", exact: true })
    .click();
  await chapter("第一章 旧信");
  await reader()
    .getByRole("button", { name: "记录本章当前位置", exact: true })
    .click();
  const oldProgress = (await progress()).progress;
  await writeFile(manuscript, "外部新增前缀。\n" + saved.body);
  await reader()
    .getByRole("button", { name: "刷新阅读目录", exact: true })
    .click();
  await chapter("第一章 旧信");
  await reader()
    .getByText(/正文已改变，已定位到本章开头/)
    .waitFor();
  assert.deepEqual((await progress()).progress, oldProgress);
  await reader()
    .getByRole("button", { name: "按当前正文重新记录", exact: true })
    .click();
  await waitProgress(
    (value) => value.progress.bodyHash !== oldProgress.bodyHash,
  );
  book = await store.updateStructure(
    book.id,
    (await store.listBooks()).books.find((item) => item.id === book.id)
      .revision,
    { type: "chapter-trash", chapterId: book.chapters[1].id },
  );
  await reader().getByRole("button", { name: "下一章", exact: true }).click();
  await reader()
    .getByRole("alert")
    .filter({ hasText: "目录或章节版本已改变" })
    .waitFor();
  await reader()
    .getByRole("button", { name: "刷新阅读目录", exact: true })
    .click();
  await chapter("第一章 旧信");
  assert.equal(
    await reader()
      .getByLabel("阅读章节目录", { exact: true })
      .getByRole("button", { name: "第二章 渡口", exact: true })
      .count(),
    0,
  );
  await reader().getByLabel("阅读背景", { exact: true }).selectOption("light");
  await reader()
    .getByLabel("阅读版面", { exact: true })
    .selectOption("desktop");
  await shot("directory-refresh-light.png");
  await reader()
    .getByRole("button", { name: "关闭独立阅读", exact: true })
    .click();
  const corrupt = '{"schemaVersion":999,"keep":"RETAIN_READING_RECORD"}';
  await page.evaluate(
    ({ key, corrupt }) => localStorage.setItem(key, corrupt),
    { key, corrupt },
  );
  await open();
  await chapter("第一章 旧信");
  await reader()
    .getByRole("alert")
    .filter({ hasText: "本机阅读记录无法读取" })
    .waitFor();
  await reader().getByLabel("阅读字体大小", { exact: true }).selectOption("28");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    corrupt,
  );
  await reader()
    .getByRole("button", { name: "重置本机阅读记录", exact: true })
    .click();
  await waitProgress((value) => value?.schemaVersion === 1);
  await page.evaluate(() => {
    window.readerOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.reading."))
        throw new DOMException("Synthetic reading quota", "QuotaExceededError");
      return window.readerOriginalSetItem.call(this, key, value);
    };
  });
  const preserved = await page.evaluate(
    (key) => localStorage.getItem(key),
    key,
  );
  await reader().getByLabel("阅读行距", { exact: true }).selectOption("2.4");
  await reader()
    .getByRole("alert")
    .filter({ hasText: "本机阅读进度暂未保存" })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    preserved,
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = window.readerOriginalSetItem;
    delete window.readerOriginalSetItem;
  });
  await reader()
    .getByRole("button", { name: "重试保存阅读进度", exact: true })
    .click();
  await waitProgress((value) => value.preferences.lineHeight === 2.4);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await reader()
    .getByRole("button", { name: "跳到阅读正文", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "小说阅读正文",
  );
  await shot("narrow-reader.png");
  await page.keyboard.press("Escape");
  await reader().waitFor({ state: "hidden" });
  const missingBookmark = (await progress()).progress;
  await store.updateStructure(book.id, book.revision, {
    type: "chapter-trash",
    chapterId: saved.id,
  });
  await open();
  await chapter("第三章 远海");
  await reader()
    .getByText(/原阅读章节已删除或不在当前范围/)
    .waitFor();
  assert.deepEqual((await progress()).progress, missingBookmark);
  await reader()
    .getByRole("button", { name: "记录本章当前位置", exact: true })
    .click();
  await waitProgress(
    (value) => value.progress.chapterId === book.chapters[2].id,
  );
  await page.keyboard.press("Escape");
  await reader().waitFor({ state: "hidden" });
  assert.equal(
    await readFile(manuscript, "utf8"),
    "外部新增前缀。\n" + beforeReading.toString("utf8"),
  );
  assert.deepEqual(report.errors, []);
  await closeApp();
  await launch(empty.title);
  await open();
  await reader()
    .getByText(/零章节作品可先试写/)
    .waitFor();
  assert.equal(
    await reader().getByLabel("阅读字体大小", { exact: true }).inputValue(),
    "20",
  );
  report.checks.push(
    "unsaved editor text is saved before actual reader entry; opaque isolated reader has no author secrets, editing fields, model requests or script execution",
    "actual wheel scroll, chapter/volume/final-only navigation and full app restart restore exact-hash paragraph plus font/line-height/theme/390px desktop simulation",
    "external source change preserves old bookmark until explicit record; directory deletion blocks stale navigation, removes deleted chapter on refresh and retains a missing current bookmark until explicit new recording; future local record and quota failures preserve bytes until explicit reset/retry",
    "Escape closes reader, empty book has a clear state, and reading never mutates manuscript bytes outside the deliberately authored/external test changes",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(shots, "reader-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") {
        await terminateOwnedProcesses(owned);
        report.failedCleanupConfirmed = true;
        report.ownedProcessesConfirmedExited = owned.size;
      } else await closeApp();
    }
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error.stack || error);
    throw error;
  } finally {
    await writeFile(
      join(shots, "reader-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
