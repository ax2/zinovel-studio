import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "material-context-ui-")),
  store = new NovelStore(join(data, "library"));
const original = "林舟在港口拆信。";
const book = await store.importBook("上下文隔离合成验证", [
    { title: "旧信", body: original },
  ]),
  other = await store.createBook("不能混入的另一作品");
const input = (title, voice) => ({
  kind: "character",
  title,
  status: "planned",
  notes: "未写设定，不是正文事实",
  fields: { voice },
  chapterIds: [],
});
let card = await store.materials.save(
  book.id,
  input("林舟人物设定", "旧版限定口头禅：船不等人"),
);
await store.materials.save(
  book.id,
  input("未选择人物", "SAME_BOOK_UNSELECTED_SENTINEL"),
);
await store.materials.save(
  other.id,
  input("他书人物", "OTHER_BOOK_PRIVATE_SENTINEL"),
);
const model = await modelFixture({ readMaterials: true }),
  screenshots = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-004",
    "context",
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
const report = { status: "running", checks: [], errors: [], viewports: [] };
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
}
async function snapshot(name) {
  await page.screenshot({ path: join(screenshots, name) });
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
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-material-context-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await page.locator("summary").filter({ hasText: "本次参考资料" }).click();
  await page
    .getByRole("checkbox", { name: "林舟人物设定", exact: true })
    .check();
  const context = page.getByLabel("将发送的资料快照", { exact: true });
  await context.waitFor();
  await context.locator("summary").click();
  await context.getByText(/旧版限定口头禅/).waitFor();
  assert.equal(model.requests.length, 0);
  await snapshot("context-preview-light.png");
  card = await store.materials.save(
    book.id,
    {
      ...card,
      fields: { ...card.fields, voice: "新版限定口头禅：潮声不等人" },
    },
    card,
  );
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "资料或证据已改变" })
    .waitFor();
  assert.equal(model.requests.length, 0);
  await page.getByRole("button", { name: "刷新资料快照", exact: true }).click();
  await context.locator("summary").filter({ hasText: "版本 2" }).click();
  await context.getByText(/新版限定口头禅/).waitFor();
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  assert.equal(model.requests.length, 4);
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_change_propose",
      "novel_materials_read",
      "novel_selection_read",
    ]);
  const messages = JSON.stringify(model.requests);
  assert.match(messages, /新版限定口头禅/);
  assert.doesNotMatch(
    messages,
    /旧版限定口头禅|SAME_BOOK_UNSELECTED_SENTINEL|OTHER_BOOK_PRIVATE_SENTINEL/,
  );
  assert.ok(
    model.requests[2].messages.some((message) =>
      JSON.stringify(message).includes("新版限定口头禅"),
    ),
  );
  const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  );
  assert.equal(await readFile(manuscript, "utf8"), original);
  await page.getByLabel("关闭候选", { exact: true }).click();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.locator("summary").filter({ hasText: "当时的参考资料" }).click();
  await page
    .getByRole("dialog", { name: "写作任务记录" })
    .getByText(/新版限定口头禅/)
    .waitFor();
  await snapshot("frozen-task-context.png");
  report.checks.push(
    "local preview sends zero model requests; changed selected card blocks generation before dispatch; refresh uses current explicit same-book snapshot; real official Harness exposes exactly three scoped tools and performs selection-read, material-read, proposal round trip with no other-book or unselected content",
  );
  await application.close();
  application = null;
  card = await store.materials.save(
    book.id,
    { ...card, fields: { ...card.fields, voice: "任务之后又修改的人物声音" } },
    card,
  );
  await launch();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.locator("summary").filter({ hasText: "当时的参考资料" }).click();
  await page
    .getByRole("dialog", { name: "写作任务记录" })
    .getByText(/新版限定口头禅/)
    .waitFor();
  assert.equal(
    await page
      .getByRole("dialog", { name: "写作任务记录" })
      .getByText(/任务之后又修改/)
      .count(),
    0,
  );
  assert.equal(model.requests.length, 4);
  report.checks.push(
    "task's exact source versions survive later card edits and real desktop restart without replay or manuscript writes; scope and context are visible in task history",
  );
  await page.getByLabel("关闭任务记录").click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await page.locator("summary").filter({ hasText: "本次参考资料" }).click();
  await page
    .getByRole("checkbox", { name: "林舟人物设定", exact: true })
    .check();
  await page.getByLabel("将发送的资料快照", { exact: true }).waitFor();
  await page
    .getByLabel("将发送的资料快照", { exact: true })
    .scrollIntoViewIfNeeded();
  await snapshot("context-dark-narrow.png");
  assert.equal(await readFile(manuscript, "utf8"), original);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  if (page)
    await page
      .screenshot({ path: join(screenshots, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await model.close();
  await writeFile(
    join(screenshots, "context-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
