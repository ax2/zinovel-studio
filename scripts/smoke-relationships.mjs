import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "relationships-ui-"));
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("关系变化合成验证", [
  { title: "旧港交换", body: "林舟把信交给顾远。\n苏禾记得他们此前的约定。🌊" },
  { title: "往事", body: "一年前，船还没有离港。" },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id);
const source = {
  chapterId: chapter.id,
  body: chapter.body,
  hash: chapter.diskHash,
  start: 0,
  end: 9,
};
async function create(title) {
  return store.materials.save(book.id, {
    kind: "character",
    title,
    status: "accepted",
    notes: "合成角色",
    fields: {},
    chapterIds: [],
  });
}
let a = await create("林舟"),
  b = await create("顾远"),
  c = await create("苏禾"),
  d = await create("旧船主"),
  e = await create("失联人物");
async function add(owner, statement, relatedIds) {
  return store.materials.mutateEvidence(book.id, owner, {
    action: "add",
    kind: "relation",
    scope: "world",
    statement,
    storyTime: "离港前（回忆）",
    relatedIds,
    source,
  });
}
a = await add(a, "林舟最初信任顾远", [b.id]);
a = await add(a, "林舟后来怀疑顾远", [b.id]);
a = await add(a, "林舟与顾远、苏禾交换信物", [b.id, c.id]);
a = await add(a, "林舟记得旧船主的约定", [d.id]);
b = await add(b, "顾远怀疑林舟", [a.id]);
b = await add(b, "顾远向失联人物求助", [e.id]);
c = await add(c, "苏禾曾救过林舟", [a.id]);
c = await store.materials.mutateEvidence(book.id, c, {
  action: "retire",
  eventId: c.evidence[0].id,
});
d = await store.materials.setDeleted(book.id, d, true);
const missingFile = join(data, "library", book.id, "materials", `${e.id}.json`);
await writeFile(missingFile, "{corrupt-synthetic-card");
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${chapter.id}.md`,
  ),
  original = await readFile(manuscript);
const ownerFile = join(data, "library", book.id, "materials", `${a.id}.json`),
  originalOwner = await readFile(ownerFile);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "relationships",
);
await mkdir(screenshots, { recursive: true });
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
  page.getByRole("dialog", { name: "全书证据", exact: true });
const graph = () =>
  dialog().getByRole("region", { name: "关系图与事件", exact: true });
const detail = () =>
  graph().getByRole("article", { name: "关系事件详情", exact: true });
async function count(n) {
  await dialog()
    .getByRole("status")
    .filter({ hasText: `共 ${n} 条符合筛选的证据` })
    .waitFor();
}
async function open() {
  await page.getByRole("button", { name: "全书证据", exact: true }).click();
  await count(7);
  await dialog().getByRole("button", { name: "关系图", exact: true }).click();
  await graph()
    .getByText("图中显示 7 / 7 条关系事件。", { exact: false })
    .waitFor();
}
async function select(statement) {
  await graph()
    .getByRole("group", { name: "选择关系事件", exact: true })
    .getByRole("button")
    .filter({ hasText: statement })
    .click();
  await detail().getByText(statement, { exact: true }).waitFor();
}
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_APP_EXE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  await open();
}
async function shot(name) {
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
  assert.equal(
    await graph()
      .getByRole("group", { name: "选择关系事件", exact: true })
      .getByRole("button")
      .count(),
    7,
  );
  await select("林舟最初信任顾远");
  await select("林舟后来怀疑顾远");
  assert.equal(await graph().locator('path[data-selected="true"]').count(), 1);
  await select("林舟与顾远、苏禾交换信物");
  assert.equal(await graph().locator('path[data-selected="true"]').count(), 2);
  await graph().getByRole("button", { name: "适合视图", exact: true }).click();
  await graph()
    .getByLabel("关系连接图，可滚动查看", { exact: true })
    .scrollIntoViewIfNeeded();
  await shot("relations-light.png");
  await graph()
    .getByRole("button", { name: "聚焦关系：林舟", exact: true })
    .click();
  await count(6);
  await graph()
    .getByRole("group", { name: "选择关系事件", exact: true })
    .getByRole("button")
    .filter({ hasText: "顾远怀疑林舟" })
    .waitFor();
  await dialog()
    .getByRole("button", { name: "取消对象聚焦", exact: true })
    .click();
  await count(7);
  await select("林舟后来怀疑顾远");
  await detail()
    .getByRole("button", { name: "在表格核对此事件", exact: true })
    .click();
  await count(1);
  assert.equal(await dialog().locator("tbody tr").count(), 1);
  await dialog()
    .locator("tbody tr")
    .getByText("林舟后来怀疑顾远", { exact: true })
    .waitFor();
  await dialog()
    .locator("tbody tr")
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.slice(0, 9),
  );
  assert.deepEqual(await readFile(manuscript), original);
  report.checks.push(
    "distinct and opposite relation events retain all source text; selecting multi-target event highlights both edges; participant focus includes incoming and outgoing records; graph-to-table opens the exact event and its original manuscript range",
  );
  await open();
  await select("苏禾曾救过林舟");
  await detail()
    .getByRole("heading", { name: /已停用/ })
    .waitFor();
  assert.equal(
    await graph()
      .locator('path[data-selected="true"][data-condition="retired"]')
      .count(),
    1,
  );
  await graph()
    .getByRole("button", { name: "聚焦关系：旧船主", exact: true })
    .getByText("人物 · 已删除", { exact: true })
    .waitFor();
  await graph()
    .getByRole("button", { name: "聚焦关系：资料不可读取", exact: true })
    .getByText("类型未知 · 失联", { exact: true })
    .waitFor();
  await dialog()
    .getByRole("button", { name: "关闭全书证据", exact: true })
    .click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await writeFile(manuscript, "后来：" + chapter.body);
  await open();
  await select("林舟后来怀疑顾远");
  await detail()
    .getByRole("heading", { name: /待复核/ })
    .waitFor();
  await detail().scrollIntoViewIfNeeded();
  await shot("relation-evidence-dark-narrow.png");
  const bounds = await dialog().evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  assert.ok(
    bounds.scroll <= bounds.width + 2,
    "graph viewport scroll does not overflow outer dialog",
  );
  await detail().getByText("查看关系事件原引文", { exact: true }).click();
  await detail()
    .getByRole("button", { name: "查看关系正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.slice(0, 9),
  );
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
  await application.close();
  application = null;
  await launch();
  await select("林舟后来怀疑顾远");
  await detail()
    .getByRole("heading", { name: /待复核/ })
    .waitFor();
  assert.deepEqual(await readFile(ownerFile), originalOwner);
  assert.equal(await readFile(missingFile, "utf8"), "{corrupt-synthetic-card");
  const expanded = JSON.parse(originalOwner.toString("utf8"));
  expanded.evidence.push(
    ...Array.from({ length: 54 }, (_, index) => ({
      ...expanded.evidence[0],
      id: randomUUID(),
      statement: `分页关系事件 ${index + 1}`,
    })),
  );
  expanded.revision++;
  await writeFile(ownerFile, JSON.stringify(expanded));
  await dialog().getByRole("button", { name: "刷新证据", exact: true }).click();
  await count(61);
  await graph()
    .getByText("图中显示 60 / 61 条关系事件。", { exact: false })
    .waitFor();
  await graph()
    .getByRole("status")
    .filter({ hasText: "另有 1 条未绘制" })
    .waitFor();
  const unreadable = dialog()
    .locator("details")
    .filter({ hasText: "1 份资料未能读取，结果可能不完整" })
    .first();
  await unreadable.locator("summary").click();
  assert.equal(await unreadable.evaluate((element) => element.open), true);
  assert.equal(
    await unreadable.evaluate((element) => getComputedStyle(element).position),
    "static",
  );
  await dialog().getByRole("button", { name: "证据表格", exact: true }).click();
  await count(61);
  assert.equal(await dialog().locator("tbody tr").count(), 40);
  const firstPage = await dialog().locator("tbody tr").allTextContents();
  await dialog()
    .getByRole("button", { name: "下一页证据", exact: true })
    .click();
  await dialog().getByText("41–61 / 61", { exact: true }).waitFor();
  const secondPage = await dialog().locator("tbody tr").allTextContents();
  assert.equal(secondPage.length, 21);
  assert.equal(new Set([...firstPage, ...secondPage]).size, 61);
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
  report.checks.push(
    "61 actual relationship records show an explicit 60-event graph limit; all 61 remain reachable across 40/21 table pages; unreadable-source details stay in normal layout and open by a real click",
  );
  report.checks.push(
    "deleted/missing nodes and retired edges stay visible; external manuscript change makes graph evidence stale; narrow dark graph detail relocates the exact original quote; real restart and read-only graph preserve all source card bytes",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await writeFile(
    join(screenshots, "relationships-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
