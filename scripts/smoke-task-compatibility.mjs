import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "task-compatibility-"));
const legacy = [];
for (let index = 0; index < 101; index++) {
  const id = randomUUID(),
    directory = join(data, "tasks", id);
  await mkdir(directory, { recursive: true });
  const raw = JSON.stringify({
    id,
    status: "awaiting-review",
    skillId: "novel-polish",
    model: "legacy-synthetic",
    startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    candidate: `旧版合成候选 ${index}。`,
  });
  await writeFile(join(directory, "task.json"), raw);
  await writeFile(
    join(directory, "snapshot.json"),
    JSON.stringify({ context: "旧版合成原稿", selectedText: "原稿" }),
  );
  legacy.push({ id, directory, raw });
}
const store = new NovelStore(join(data, "library")),
  journal = new TaskJournal(join(data, "tasks"));
const original = "原来授权的正文。",
  fresh = "作者在取消后补充了新的事实。𠮷🌊";
const book = await store.importBook("重试范围合成小说", [
  { title: "新章", body: original },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id),
  cancelledId = randomUUID();
await journal.create(
  {
    id: cancelledId,
    status: "preparing",
    bookId: book.id,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    skillId: "novel-polish",
    model: "synthetic",
    startedAt: new Date().toISOString(),
  },
  {
    context: original,
    selectedText: original,
    instruction: "保留作者最新事实，改进表达。",
    target: {
      bookId: book.id,
      chapterId: chapter.id,
      body: original,
      start: 0,
      end: original.length,
      baseHash: chapter.diskHash,
    },
  },
);
await journal.transition(cancelledId, "running");
await writeFile(
  join(data, "tasks", cancelledId, "proposal.json"),
  JSON.stringify({ replacement: "取消之前已保存的合成部分结果。" }),
);
await journal.transition(cancelledId, "cancelled");
const model = await modelFixture({ delayMs: 250 });
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "compatibility",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page;
const report = { status: "running", checks: [], errors: [] };
try {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.getByRole("heading", { name: "把故事写下来" }).waitFor();
  await page.getByTitle("写作任务", { exact: true }).click();
  await page.getByLabel("任务范围", { exact: true }).selectOption("unbound");
  await page.waitForFunction(
    () => document.querySelectorAll(".task-row").length === 100,
  );
  await page.getByRole("button", { name: "下一页任务", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".task-row").length === 1,
  );
  await page.locator(".task-row").click();
  assert.equal(
    await page.getByLabel("历史候选文本").inputValue(),
    "旧版合成候选 0。",
  );
  await page
    .getByText("这是没有章节绑定的旧版任务", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "继续审阅", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "打开对应章节", exact: true })
      .count(),
    0,
  );
  await page.screenshot({ path: join(screenshots, "unbound-legacy-task.png") });
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.getByLabel("任务范围", { exact: true }).selectOption("all");
  await page.locator(".task-row").filter({ hasText: book.title }).click();
  await page.getByRole("button", { name: "打开对应章节", exact: true }).click();
  await page.getByLabel("正文编辑器").waitFor();
  for (const old of legacy)
    assert.equal(
      await readFile(join(old.directory, "task.json"), "utf8"),
      old.raw,
    );
  report.checks.push(
    "library-level task history pages through 101 legacy records; unbound candidates remain readable but cannot be applied or guessed into a book; original files stay byte-identical",
    "all-book task list opens the exact linked book and chapter",
  );
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-compatibility-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  const editor = page.getByLabel("正文编辑器");
  await editor.fill(fresh);
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  await editor.press("Control+a");
  if (
    !(await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  assert.equal(
    await page.getByLabel("历史候选文本").inputValue(),
    "取消之前已保存的合成部分结果。",
  );
  assert.equal(
    await page.getByRole("button", { name: "继续审阅", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "用当前选区重试", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  const tasks = await journal.list(book.id),
    retry = tasks.find((task) => task.retryOf === cancelledId);
  assert.ok(retry);
  assert.notEqual(retry.id, cancelledId);
  const saved = await journal.read(retry.id);
  assert.equal(saved.snapshot.context, fresh);
  assert.equal(saved.snapshot.selectedText, fresh);
  assert.equal(saved.record.status, "awaiting-review");
  assert.equal((await journal.read(cancelledId)).record.status, "cancelled");
  assert.equal((await store.readChapter(book.id, chapter.id)).body, fresh);
  assert.equal(model.requests.length, 3);
  await page.screenshot({ path: join(screenshots, "retried-fresh-range.png") });
  await page.getByLabel("关闭候选").click();
  report.checks.push(
    "cancelled partial proposal is view-only; explicit retry calls real official Harness with the latest chapter and selection in a new linked task, retains the old task and never edits manuscript automatically",
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
  await model.close();
  await writeFile(
    join(screenshots, "compatibility-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
