import {
  taskReviewTimeoutMs,
  captureTaskDiagnostics,
} from "./qa-task-diagnostics.mjs";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import {
  captureOwnedProcesses,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "tasks-qa-"));
const store = new NovelStore(join(data, "library"));
const original = "雨停时，林舟收到了旧信。𠮷🌊";
const book = await store.importBook("任务恢复合成小说", [
  { title: "旧信", body: original },
  { title: "另一章", body: "另一章的正文不能被旧信候选覆盖。" },
]);
const otherBook = await store.importBook("无任务作品", [
  { title: "独立章节", body: "另一部书。" },
]);
const file = join(
  data,
  "library",
  book.id,
  "manuscript",
  `${book.chapters[0].id}.md`,
);
let releaseFinal;
const finalGate = new Promise((resolve) => {
  releaseFinal = resolve;
});
const model = await modelFixture({
  delayMs: 500,
  beforeReply: (index) => (index === 6 ? finalGate : undefined),
});
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "tasks",
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
const report = { status: "running", checks: [], errors: [], viewport: null };
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  if (process.env.ZINOVEL_QA_VIEWPORT === "ci")
    await page.setViewportSize({ width: 1008, height: 681 });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (
    !(await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
}
async function history() {
  if (
    !(await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考", { exact: true }).click();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().waitFor();
}
async function waitUntil(predicate, label) {
  const end = Date.now() + 60000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  await launch();
  report.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-task-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await page.getByLabel("正文编辑器").press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: taskReviewTimeoutMs });
  assert.equal(
    await page.getByLabel("候选文本").inputValue(),
    model.replacement,
  );
  await page.getByLabel("关闭候选").click();
  const tasks = await page.evaluate(
    (bookId) => window.novel.request("ai.tasks", { bookId }),
    book.id,
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "awaiting-review");
  assert.equal(tasks[0].chapterId, book.chapters[0].id);
  assert.deepEqual(
    await page.evaluate(
      (bookId) => window.novel.request("ai.tasks", { bookId }),
      otherBook.id,
    ),
    [],
  );
  assert.equal(await readFile(file, "utf8"), original);
  await application.close();
  application = undefined;
  await launch();
  assert.equal(model.requests.length, 3);
  if (!(await page.locator(".chapter-list").isVisible()))
    await page
      .getByRole("button", { name: "关闭创作参考", exact: true })
      .click();
  await page
    .locator(".chapter-list button")
    .filter({ hasText: "另一章" })
    .click();
  await history();
  await page.screenshot({ path: join(screenshots, "task-history-light.png") });
  await page.locator(".task-row").first().click();
  assert.equal(
    await page.getByLabel("历史候选文本").inputValue(),
    model.replacement,
  );
  await page.getByRole("button", { name: "继续审阅", exact: true }).click();
  await page.getByRole("button", { name: "接受候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "当前正文或保存状态" })
    .waitFor();
  assert.equal(await readFile(file, "utf8"), original);
  await page.getByLabel("关闭候选").click();
  await page.getByRole("button", { name: "关闭错误", exact: true }).click();
  await history();
  await page.locator(".task-row").first().click();
  await page.getByRole("button", { name: "打开对应章节", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".chapter-list .selected")
      ?.textContent.includes("旧信"),
  );
  await history();
  await page.locator(".task-row").first().click();
  await page.getByRole("button", { name: "继续审阅", exact: true }).click();
  const authored = model.replacement + "作者调整了最后一句。";
  await page.getByLabel("候选文本").fill(authored);
  await page.getByRole("button", { name: "接受候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ state: "hidden" });
  assert.equal(await readFile(file, "utf8"), authored);
  const accepted = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    tasks[0].id,
  );
  assert.equal(accepted.record.status, "applied");
  assert.equal(accepted.record.candidate, model.replacement);
  assert.equal(accepted.record.acceptedText, authored);
  assert.equal(
    accepted.record.appliedHash,
    (await store.readChapter(book.id, book.chapters[0].id)).diskHash,
  );
  await page.getByLabel("正文编辑器").press("Control+z");
  await page.getByLabel("正文编辑器").press("Control+s");
  await waitUntil(
    async () => (await readFile(file, "utf8")) === original,
    "single undo did not restore exact input",
  );
  report.checks.push(
    "bound task survives real desktop restart without replay; wrong chapter cannot accept; correct chapter receives author-edited candidate with durable receipt; one undo restores original bytes",
  );

  // Kill only the Playwright-owned desktop tree after its proposal tool has
  // persisted text but before the final model response completes.
  await page.getByLabel("正文编辑器").press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await waitUntil(
    () => model.requests.length === 6,
    "second task did not finish its proposal tool",
  );
  const running = (
    await page.evaluate(
      (bookId) => window.novel.request("ai.tasks", { bookId }),
      book.id,
    )
  ).find((task) => task.status === "running");
  assert.ok(running);
  assert.equal(
    JSON.parse(
      await readFile(join(data, "tasks", running.id, "proposal.json"), "utf8"),
    ).replacement,
    model.replacement,
  );
  const pid = application.process().pid;
  assert.ok(Number.isInteger(pid) && pid > 0);
  const owned = await captureOwnedProcesses(pid);
  assert.ok(
    owned.size > 2,
    "expected the owned desktop and Harness child tree",
  );
  await terminateOwnedProcesses(owned);
  report.termination = {
    method: "identity-verified termination of captured original processes",
    ownedProcessesConfirmedExited: owned.size,
    verification: "Windows Toolhelp + GetProcessTimes PID and creation time",
  };
  releaseFinal();
  await application.close().catch(() => {});
  application = undefined;
  await launch();
  await history();
  await page.locator(".task-row").filter({ hasText: "中断待处理" }).click();
  assert.equal(
    await page.getByLabel("历史候选文本").inputValue(),
    model.replacement,
  );
  assert.equal(
    await page.getByRole("button", { name: "继续审阅", exact: true }).count(),
    0,
  );
  await page
    .getByText("这是任务停止前已保存的部分结果", { exact: false })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "interrupted-proposal.png"),
  });
  await page.waitForTimeout(1200);
  assert.equal(model.requests.length, 6);
  assert.equal(await readFile(file, "utf8"), original);
  await page.getByRole("button", { name: "标记放弃", exact: true }).click();
  await page.locator(".task-row").filter({ hasText: "已放弃" }).waitFor();
  await page.getByLabel("关闭任务记录").click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 700),
  );
  if (
    !(await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await history();
  const box = await page
    .getByRole("dialog", { name: "写作任务记录" })
    .boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.ok(
    box.x >= 0 &&
      box.x + box.width <= viewport.width &&
      box.y >= 0 &&
      box.y + box.height <= viewport.height,
  );
  await page.screenshot({ path: join(screenshots, "task-history-narrow.png") });
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "写作任务记录" })
    .waitFor({ state: "hidden" });
  await page.getByTitle("深色主题", { exact: true }).click();
  await history();
  await page.getByLabel("关闭任务记录").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .locator(".task-row")
      .last()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByLabel("关闭任务记录")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.screenshot({
    path: join(screenshots, "task-history-dark-narrow.png"),
  });
  await page.keyboard.press("Escape");
  report.checks.push(
    "forced termination of the owned desktop and real Harness tree recovers interrupted status and partial proposal, never replays the model or edits manuscript; partial result is view-only and can be explicitly discarded",
    "task list filters by book and remains bounded, accessible and dismissible in narrow viewport",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.taskStates = await captureTaskDiagnostics(data);
  await writeFile(
    join(screenshots, "task-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  releaseFinal();
  await application?.close().catch(() => {});
  await model.close();
  await writeFile(
    join(screenshots, "task-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
