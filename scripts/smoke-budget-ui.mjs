import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "budget-ui-qa-"));
const store = new NovelStore(join(data, "library"));
const original = "旧信是从雨中的灯塔寄来的。";
const book = await store.importBook("预算验证合成小说", [
  { title: "灯塔", body: original },
]);
const model = await modelFixture();
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-003",
  "budget",
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
async function settings(steps, first = false) {
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  if (first) {
    await page.getByLabel("服务地址").fill(model.url);
    await page.getByLabel("API Key").fill("synthetic-budget-ui-key");
  }
  await page.getByText("每次写作任务的预算", { exact: true }).click();
  await page.getByLabel("模型步骤上限", { exact: true }).fill(String(steps));
  await page.getByLabel("章节上下文字符上限", { exact: true }).fill("100");
  await page.getByLabel("每步输出 Token 上限", { exact: true }).fill("128");
  const bounds = await page
    .getByRole("dialog", { name: "模型设置" })
    .boundingBox();
  const height = await page.evaluate(() => innerHeight);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height);
  await page.getByRole("dialog", { name: "模型设置" }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: join(screenshots, "budget-settings.png") });
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
}
try {
  await launch();
  await settings(1, true);
  await page.getByLabel("正文编辑器").press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "预算停止" })
    .waitFor({ timeout: 45000 });
  assert.equal(model.requests.length, 1);
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page
    .getByText("供应商已回报合计：48 Token。", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "继续审阅", exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(screenshots, "budget-stopped.png") });
  await page.getByLabel("关闭任务记录").click();
  const oldTask = (
    await page.evaluate(
      (bookId) => window.novel.request("ai.tasks", { bookId }),
      book.id,
    )
  )[0];
  await settings(3);
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page
    .getByRole("button", { name: "用当前选区重试", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  assert.equal(
    await page.getByLabel("候选文本").inputValue(),
    model.replacement,
  );
  await page.getByLabel("关闭候选").click();
  assert.equal(model.requests.length, 4);
  const tasks = await page.evaluate(
    (bookId) => window.novel.request("ai.tasks", { bookId }),
    book.id,
  );
  const retried = tasks.find((task) => task.retryOf === oldTask.id);
  assert.ok(retried);
  assert.equal(retried.status, "awaiting-review");
  assert.equal(retried.budget.maxSteps, 3);
  const previous = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    oldTask.id,
  );
  assert.equal(previous.record.budget.maxSteps, 1);
  assert.equal(previous.record.errorCode, "budget-limit");
  await application.close();
  application = undefined;
  await launch();
  const config = await page.evaluate(() =>
    window.novel.request("settings.get"),
  );
  assert.equal(config.budget.maxSteps, 3);
  const completed = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    retried.id,
  );
  assert.equal(completed.record.usage.observedTokens, 144);
  assert.equal(completed.record.usage.cost, null);
  assert.equal(model.requests.length, 4);
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    original,
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 720),
  );
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByText("每次写作任务的预算", { exact: true }).click();
  const narrowBounds = await page
    .getByRole("dialog", { name: "模型设置" })
    .boundingBox();
  assert.ok(
    narrowBounds.y >= 0 &&
      narrowBounds.y + narrowBounds.height <=
        (await page.evaluate(() => innerHeight)),
  );
  await page
    .getByRole("button", { name: "保存设置", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(screenshots, "budget-settings-narrow.png"),
  });
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 960),
  );
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByText("每次写作任务的预算", { exact: true }).click();
  await page.getByLabel("为当前模型配置价格", { exact: true }).check();
  for (const label of [
    "非缓存输入单价 / 百万 Token",
    "输出单价 / 百万 Token",
    "缓存读取单价 / 百万 Token",
    "缓存写入单价 / 百万 Token",
  ])
    await page.getByLabel(label, { exact: true }).fill("1");
  await page
    .getByLabel("每任务费用阈值（0 为不启用）", { exact: true })
    .fill("0.0000001");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByLabel("生成前预算预览").filter({ hasText: "CNY" }).waitFor();
  assert.equal(model.requests.length, 4, "preview must be local-only");
  await page.screenshot({ path: join(screenshots, "price-preview.png") });
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "预算停止" })
    .waitFor({ timeout: 45000 });
  assert.equal(
    model.requests.length,
    4,
    "fee limit must reject before network dispatch",
  );
  const blockedId = (
    await page.evaluate(
      (bookId) => window.novel.request("ai.tasks", { bookId }),
      book.id,
    )
  )[0].id;
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.getByText("完整请求预估明细", { exact: true }).click();
  await page.getByText("预算拦截，未发送", { exact: false }).waitFor();
  await page.screenshot({
    path: join(screenshots, "cost-before-dispatch.png"),
  });
  await page.getByLabel("关闭任务记录").click();
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByText("每次写作任务的预算", { exact: true }).click();
  await page
    .getByLabel("每任务费用阈值（0 为不启用）", { exact: true })
    .fill("1");
  await page
    .getByLabel("非缓存输入单价 / 百万 Token", { exact: true })
    .fill("2");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  await page.getByLabel("关闭候选").click();
  assert.equal(model.requests.length, 7);
  const pricedId = (
    await page.evaluate(
      (bookId) => window.novel.request("ai.tasks", { bookId }),
      book.id,
    )
  )[0].id;
  const priced = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    pricedId,
  );
  assert.ok(Math.abs(priced.record.usage.cost - 0.000234) < 1e-12);
  assert.equal(priced.record.usage.estimates.length, 3);
  const blocked = await page.evaluate(
    (id) => window.novel.request("ai.task", { id }),
    blockedId,
  );
  assert.equal(blocked.record.usage.policy.pricing.inputPerMillion, 1);
  assert.equal(blocked.record.usage.policy.maxCost, 0.0000001);
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.getByText("本次用量与预算", { exact: true }).click();
  await page
    .getByText("按本任务冻结单价换算：0.000234 CNY。", { exact: false })
    .waitFor();
  await page.screenshot({ path: join(screenshots, "reported-cost.png") });
  await page.getByLabel("关闭任务记录").click();
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("模型名称", { exact: true }).fill("different-model");
  await page.getByText("每次写作任务的预算", { exact: true }).click();
  assert.equal(
    await page.getByLabel("为当前模型配置价格", { exact: true }).isChecked(),
    false,
  );
  await page.getByLabel("关闭模型设置").click();
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    original,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "UI saves step/context/output budgets; real official Harness is stopped before the second request and usage is displayed without invented costs",
    "changing settings and explicitly retrying creates a new task with the new frozen budget; old budget/result stay intact",
    "settings and exact reported usage survive restart without model replay or manuscript modification",
    "expanded budget settings stay inside the viewport and can be saved in a narrow window",
    "local preflight shows scoped heuristic and currency without network use; complete-request fee gate blocks dispatch; frozen custom rates price actual usage separately and survive settings changes",
  );
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
    join(screenshots, "budget-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
