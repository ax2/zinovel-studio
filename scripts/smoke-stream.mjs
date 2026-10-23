import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import {
  captureOwnedProcesses,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
import { captureTaskDiagnostics } from "./qa-task-diagnostics.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "stream-qa-"));
const store = new NovelStore(join(data, "library"));
const original = "旧信中的地址早已不存在。𠀀🌊";
const book = await store.importBook("流式片段合成小说", [
  { title: "未完的信", body: original },
]);
const fragment = "雨把信纸打湿了。𠀀\n林舟刚读到第二行，";
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const model = await modelFixture({
  streamText: fragment,
  afterText: () => gate,
});
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "stream",
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
  if (
    !(await page
      .getByRole("button", { name: "写作任务记录", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
}
async function until(predicate, message) {
  const deadline = Date.now() + 45000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function start() {
  await page.getByLabel("正文编辑器").press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  let running;
  await until(async () => {
    running = (
      await page.evaluate(
        (bookId) => window.novel.request("ai.tasks", { bookId }),
        book.id,
      )
    ).find((item) => item.status === "running");
    if (!running) return false;
    try {
      const value = JSON.parse(
        await readFile(join(data, "tasks", running.id, "stream.json"), "utf8"),
      );
      return value.attempts.some(
        (attempt) => attempt.text === fragment && !attempt.ended,
      );
    } catch {
      return false;
    }
  }, "No persisted live text before completion");
  await assert.rejects(
    access(join(data, "tasks", running.id, "proposal.json")),
  );
  return running.id;
}
async function verify(id, status) {
  const task = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    id,
  );
  assert.equal(task.record.status, status);
  assert.equal(task.record.candidate, fragment);
  assert.equal(task.record.partialSource, "stream");
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    original,
  );
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  assert.equal(await page.getByLabel("历史候选文本").inputValue(), fragment);
  await page
    .getByText("以下为已保存的模型文字片段", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "继续审阅", exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(screenshots, `${status}-stream.png`) });
  await page.getByLabel("关闭任务记录").click();
}
try {
  await launch();
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-stream-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  const cancelled = await start();
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await until(
    async () =>
      (
        await page.evaluate(
          (id) => window.novel.request("ai.task", { id }),
          cancelled,
        )
      ).record.status === "cancelled",
    "Cancellation did not settle",
  );
  await verify(cancelled, "cancelled");
  assert.equal(model.requests.length, 1);
  await application.close();
  application = undefined;
  await launch();
  await verify(cancelled, "cancelled");
  assert.equal(model.requests.length, 1);
  const interrupted = await start();
  const pid = application.process().pid;
  const owned = await captureOwnedProcesses(pid);
  assert.ok(owned.size > 2);
  await terminateOwnedProcesses(owned);
  application = undefined;
  await launch();
  await verify(interrupted, "interrupted");
  assert.equal(model.requests.length, 2);
  report.checks.push(
    "official Harness text is atomically captured while the SSE response is still open and no proposal exists",
    "UI cancellation flushes visible text, survives restart and provides reference-only recovery without replay or manuscript writes",
    "forced termination of the owned desktop and Harness tree preserves the last durable stream; restart exposes an interrupted reference with no automatic replay",
  );
  report.ownedProcessesConfirmedExited = owned.size;
  report.terminationVerification =
    "Windows Toolhelp + GetProcessTimes PID and creation time";
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  report.taskStates = await captureTaskDiagnostics(data);
  await writeFile(
    join(screenshots, "stream-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  release();
  await application?.close().catch(() => {});
  await model.close();
  await writeFile(
    join(screenshots, "stream-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
