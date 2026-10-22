import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "candidate-review-qa-"));
const store = new NovelStore(join(data, "library")),
  journal = new TaskJournal(join(data, "tasks"));
const selected = "他望着灯塔。\n\n雨还没停。\n\n船驶进港口。𠮷🌊\n";
const candidate = "他凝望灯塔。\n\n雨还没停。\n\n帆船缓缓驶进港口。𠮷🌊\n";
const mixed = "他望着灯塔。\n\n雨还没停。\n\n帆船缓缓驶进港口。𠮷🌊\n";
const prefix = "选区之前的正文不改。\n",
  suffix = "选区之后的正文不改。";
const body = prefix + selected + suffix;
const book = await store.importBook("差异审阅合成小说", [
  { title: "港口", body },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id),
  id = randomUUID();
const file = join(data, "library", book.id, "manuscript", `${chapter.id}.md`);
await journal.create(
  {
    id,
    status: "preparing",
    bookId: book.id,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    skillId: "novel-polish",
    model: "synthetic-no-model",
    startedAt: new Date().toISOString(),
  },
  {
    context: body,
    selectedText: selected,
    instruction: "合成差异审阅验证",
    target: {
      bookId: book.id,
      chapterId: chapter.id,
      body,
      start: prefix.length,
      end: prefix.length + selected.length,
      baseHash: chapter.diskHash,
    },
  },
);
await journal.transition(id, "running");
await journal.transition(id, "awaiting-review", { candidate });
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "candidate-review",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const report = { status: "running", checks: [], errors: [] };
let application, page;
async function review() {
  const trigger = page.getByRole("button", {
    name: "写作任务记录",
    exact: true,
  });
  if (!(await trigger.isVisible()))
    await page.getByTitle("打开创作参考").click();
  await trigger.click();
  await page.locator(".task-row").first().click();
  await page.getByRole("button", { name: "继续审阅", exact: true }).click();
  await page.getByRole("dialog", { name: "审阅 AI 候选" }).waitFor();
}
async function saved(expected) {
  await page.waitForFunction(
    (text) =>
      Array.from(document.querySelectorAll(".cm-content .cm-line"))
        .map((line) => line.textContent)
        .join("\n") === text,
    expected,
  );
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), expected);
}
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
try {
  await launch();
  report.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  await review();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    candidate,
  );
  await page.locator(".candidate-diff summary").click();
  assert.equal(await page.locator(".diff-block").count(), 2);
  assert.ok(
    await page
      .locator(".diff-choice")
      .first()
      .evaluate((element) => getComputedStyle(element).flexDirection === "row"),
  );
  await page.getByRole("checkbox", { name: /采用修改 1/ }).uncheck();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    mixed,
  );
  assert.equal(await readFile(file, "utf8"), body);
  await page
    .getByLabel("候选文本", { exact: true })
    .fill(mixed + "作者另加一句。\n");
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    mixed + "作者另加一句。\n",
  );
  await page.getByRole("button", { name: "恢复本次候选", exact: true }).click();
  await page.getByRole("button", { name: "全部保留原文", exact: true }).click();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    selected,
  );
  await page.getByRole("button", { name: "全部采用修改", exact: true }).click();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    candidate,
  );
  await page.getByRole("checkbox", { name: /采用修改 1/ }).uncheck();
  await page.locator(".candidate-diff").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "review-light.png") });
  await page.getByLabel("关闭候选").click();
  assert.equal(await readFile(file, "utf8"), body);
  await page.getByTitle("深色主题", { exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 700),
  );
  await review();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    candidate,
    "unsaved drafts are explicitly not persisted",
  );
  await page.locator(".candidate-diff summary").click();
  await page.getByRole("checkbox", { name: /采用修改 1/ }).uncheck();
  await page.locator(".diff-block").first().scrollIntoViewIfNeeded();
  await page.getByRole("checkbox", { name: /采用修改 1/ }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    candidate,
  );
  await page.keyboard.press("Space");
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    mixed,
  );
  await page.screenshot({ path: join(screenshots, "review-dark-narrow.png") });
  assert.ok(
    await page
      .locator(".proposal-modal")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  await page.getByRole("button", { name: "保存审阅草稿", exact: true }).click();
  await page
    .getByLabel("审阅草稿状态")
    .filter({ hasText: "审阅草稿已保存" })
    .waitFor();
  assert.equal((await journal.read(id)).reviewDraft.text, mixed);
  assert.equal(await readFile(file, "utf8"), body);
  await application.close();
  await launch();
  await review();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    mixed,
  );
  await page
    .getByLabel("审阅草稿状态")
    .filter({ hasText: "审阅草稿已保存" })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "saved-draft-restarted.png"),
  });
  // Simulate a competing writer after this editor loaded revision 1.
  await journal.saveReviewDraft(id, "外部审阅草稿", 1);
  await page
    .getByLabel("候选文本", { exact: true })
    .fill(mixed + "本窗口调整。");
  await page.getByRole("button", { name: "保存审阅草稿", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "草稿已改变" }).waitFor();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    mixed + "本窗口调整。",
  );
  assert.equal((await journal.read(id)).reviewDraft.text, "外部审阅草稿");
  await page.screenshot({
    path: join(screenshots, "stale-draft-retained.png"),
  });
  await page.getByLabel("关闭候选").click();
  await review();
  assert.equal(
    await page.getByLabel("候选文本", { exact: true }).inputValue(),
    "外部审阅草稿",
  );
  await page.locator(".candidate-diff summary").click();
  await page.getByRole("button", { name: "恢复本次候选", exact: true }).click();
  await page.getByRole("checkbox", { name: /采用修改 1/ }).uncheck();
  await page.getByRole("button", { name: "保存审阅草稿", exact: true }).click();
  await page
    .getByLabel("审阅草稿状态")
    .filter({ hasText: "审阅草稿已保存" })
    .waitFor();
  assert.equal((await journal.read(id)).reviewDraft.revision, 3);
  await page.getByRole("button", { name: "接受候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ state: "hidden" });
  const accepted = prefix + mixed + suffix;
  await saved(accepted);
  const result = await journal.read(id);
  assert.equal(result.record.status, "applied");
  assert.equal(result.record.candidate, candidate);
  assert.equal(result.record.acceptedText, mixed);
  if (await page.getByTitle("关闭创作参考").isVisible())
    await page.getByTitle("关闭创作参考").click();
  await page.getByLabel("正文编辑器").press("Control+z");
  await saved(body);
  await page.getByLabel("正文编辑器").press("Control+y");
  await saved(accepted);
  report.checks.push(
    "real desktop reviews two independent blocks, preserves rejected original and exact Unicode outside selection, manual edits compose without reviving rejected changes",
    "close preserves formal manuscript and original task candidate; unsaved choices reset while explicitly saved review drafts survive real desktop restart",
    "stale review draft saves reject competing revision changes without losing the on-screen edit or overwriting the saved external draft; reloading and saving a new revision succeeds",
    "partial acceptance persists through existing task receipt with original candidate retained; single undo and redo restore exact manuscript bytes",
    "light desktop and dark narrow review remain readable, scrollable and without horizontal overflow",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await application?.close().catch(() => {});
  await writeFile(
    join(screenshots, "candidate-review-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
