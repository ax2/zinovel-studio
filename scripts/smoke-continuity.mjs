import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "continuity-ui-"));
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("全书证据界面合成验证", [
  { title: "雨夜来信", body: "旧信有一道蓝印。\n林舟没有说出发信人的名字。🌊" },
  { title: "一年前的渡口", body: "他曾在这里见过同一枚印章。" },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id);
const source = {
  chapterId: chapter.id,
  body: chapter.body,
  hash: chapter.diskHash,
  start: 0,
  end: 8,
};
const create = (title, kind) =>
  store.materials.save(book.id, {
    title,
    kind,
    fields: {},
    notes: "合成计划",
    status: "accepted",
    chapterIds: [],
  });
let person = await create("林舟", "character"),
  secret = await create("发信人身份", "rule"),
  clue = await create("信封蓝印", "foreshadow");
const add = (owner, kind, scope, statement, relatedIds = []) =>
  store.materials.mutateEvidence(book.id, owner, {
    action: "add",
    kind,
    scope,
    statement,
    relatedIds,
    storyTime: "一年前（倒叙）",
    source,
  });
for (const scope of ["world", "reader", "character"])
  person = await add(person, "knowledge", scope, "蓝印来自旧船", [secret.id]);
person = await add(person, "relation", "character", "林舟向船主隐瞒身份", [
  secret.id,
]);
person = await add(person, "state", "world", "林舟在旧港使用化名");
clue = await add(clue, "plant", "reader", "蓝印第一次出现");
clue = await add(clue, "payoff", "reader", "已废弃的回收解释");
clue = await store.materials.mutateEvidence(book.id, clue, {
  action: "retire",
  eventId: clue.evidence.at(-1).id,
});
const manuscript = join(
  data,
  "library",
  book.id,
  "manuscript",
  `${chapter.id}.md`,
);
const original = await readFile(manuscript);
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
  "continuity",
);
await mkdir(screenshots, { recursive: true });
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
  page.getByRole("dialog", { name: "全书证据", exact: true });
const rows = () => dialog().locator("tbody tr");
async function count(n) {
  await dialog()
    .getByRole("status")
    .filter({ hasText: `共 ${n} 条符合筛选的证据` })
    .waitFor();
}
async function open() {
  await page.getByRole("button", { name: "全书证据", exact: true }).click();
  await count(7);
}
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_APP_EXE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
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
  assert.equal(await rows().count(), 7);
  await dialog()
    .getByLabel("事件类型", { exact: true })
    .selectOption("knowledge");
  await count(3);
  await dialog()
    .getByLabel("知情范围", { exact: true })
    .selectOption("character");
  await count(1);
  await rows().first().getByText("所属人物已知", { exact: true }).waitFor();
  await rows().first().getByText("原始正文引文", { exact: true }).click();
  await rows()
    .first()
    .getByText(chapter.body.slice(0, 8), { exact: true })
    .waitFor();
  await shot("knowledge-light.png");
  await rows()
    .first()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.slice(0, 8),
  );
  assert.deepEqual(await readFile(manuscript), original);
  await open();
  await dialog()
    .getByLabel("事件类型", { exact: true })
    .selectOption("relation");
  await count(1);
  await rows()
    .first()
    .getByRole("button", { name: "打开资料", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "创作资料", exact: true });
  await panel.getByRole("textbox", { name: "资料标题", exact: true }).waitFor();
  assert.equal(
    await panel
      .getByRole("textbox", { name: "资料标题", exact: true })
      .inputValue(),
    person.title,
  );
  report.checks.push(
    "actual filters distinguish world/reader/character knowledge; relation evidence opens exact source card; quoted manuscript navigation selects original saved range without writing manuscript",
  );
  await open();
  await dialog()
    .getByLabel("有效状态", { exact: true })
    .selectOption("retired");
  await count(1);
  await rows().first().getByText("已废弃的回收解释", { exact: true }).waitFor();
  await dialog().getByLabel("有效状态", { exact: true }).selectOption("");
  await count(7);
  await dialog()
    .getByRole("button", { name: "关闭全书证据", exact: true })
    .click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await writeFile(manuscript, "后来：" + chapter.body);
  await open();
  await dialog()
    .getByLabel("事件类型", { exact: true })
    .selectOption("relation");
  await count(1);
  await rows().first().getByText("待复核", { exact: true }).first().waitFor();
  await shot("relation-stale-dark-narrow.png");
  const geometry = await dialog().evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  assert.ok(
    geometry.scroll <= geometry.width + 2,
    "narrow dialog has no horizontal overflow",
  );
  await rows()
    .first()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .scrollIntoViewIfNeeded();
  await dialog()
    .getByRole("button", { name: "关闭全书证据", exact: true })
    .waitFor({ state: "visible" });
  await shot("relation-actions-dark-narrow.png");
  await rows()
    .first()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.slice(0, 8),
  );
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
  await open();
  await writeFile(
    join(data, "library", book.id, "materials", `${randomUUID()}.json`),
    "{broken",
  );
  await dialog().getByRole("button", { name: "刷新证据", exact: true }).click();
  await dialog()
    .getByText("1 份资料未能读取，结果可能不完整", { exact: true })
    .waitFor();
  await application.close();
  application = null;
  await launch();
  await dialog()
    .getByText("1 份资料未能读取，结果可能不完整", { exact: true })
    .waitFor();
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
  report.checks.push(
    "retired event remains visible; external text modification becomes stale; narrow dark view and source relocation work; unreadable card is disclosed; real restart preserves source bytes and evidence",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw e;
} finally {
  if (application) await application.close();
  await writeFile(
    join(screenshots, "continuity-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
