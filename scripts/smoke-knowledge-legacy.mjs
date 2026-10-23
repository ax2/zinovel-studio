import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-legacy-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("旧认知整理界面合成稿", [
  { title: "蓝印", body: "旧信有一道蓝印。\n林舟怀疑船主就是发信人。🌊" },
]);
const make = (kind, title) =>
  store.materials.save(book.id, {
    kind,
    title,
    status: "planned",
    fields:
      kind === "proposition"
        ? { claim: "船主寄来了信", truthIntent: "尚未确定" }
        : {},
    notes: "",
    chapterIds: [],
  });
let owner = await make("character", "林舟");
await make("proposition", "寄信人");
const chapter = await store.readChapter(book.id, book.chapters[0].id),
  source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  };
for (let n = 0; n < 41; n++)
  owner = await store.materials.mutateEvidence(book.id, owner, {
    action: "add",
    kind: "knowledge",
    scope: "character",
    statement: n === 0 ? "林舟只见蓝印，不知道寄信人。" : `合成旧认知第${n}条`,
    storyTime: "抵港日",
    relatedIds: [],
    source,
  });
const oldEvent = owner.evidence[0],
  oldFile = join(data, "library", book.id, "materials", `${owner.id}.json`);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "knowledge-legacy",
);
await mkdir(shots, { recursive: true });
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
    page.getByRole("dialog", { name: "认知矩阵", exact: true }),
  legacy = () =>
    dialog().getByRole("region", { name: "旧认知整理", exact: true }),
  pending = () =>
    dialog().getByRole("region", { name: "待关联旧认知", exact: true }),
  details = () =>
    dialog().getByRole("region", { name: "认知记录详情", exact: true }),
  origin = () =>
    details().getByRole("region", { name: "旧认知来源", exact: true });
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
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  await editor.click();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
}
async function open() {
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 1 个命题" })
    .waitFor();
}
async function openLegacy() {
  await dialog().getByText("整理旧认知证据", { exact: true }).click();
  await legacy()
    .getByRole("status")
    .filter({ hasText: "共 41 条旧认知" })
    .waitFor();
}
async function chooseOld() {
  await legacy().getByLabel("搜索旧认知", { exact: true }).fill("蓝印");
  await legacy()
    .getByRole("status")
    .filter({ hasText: "共 1 条旧认知" })
    .waitFor();
  await legacy()
    .getByRole("button", { name: "带入此旧认知", exact: true })
    .click();
  await pending().getByText(oldEvent.statement, { exact: true }).waitFor();
}
async function detail() {
  await dialog()
    .getByRole("button", { name: "全部认知记录", exact: true })
    .click();
  await dialog()
    .getByRole("region", { name: "认知记录列表", exact: true })
    .getByRole("button", { name: "查看记录详情", exact: true })
    .click();
}
async function shot(name) {
  await page.waitForFunction(
    () => !document.querySelector(".knowledge-body:disabled"),
  );
  await origin().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, name) });
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
  await open();
  await dialog()
    .getByRole("button", { name: "为此命题记录认知", exact: true })
    .click();
  await openLegacy();
  assert.equal(await legacy().locator("article").count(), 40);
  await legacy()
    .getByRole("button", { name: "下一页旧认知", exact: true })
    .click();
  await legacy().getByText("第 2 页", { exact: true }).waitFor();
  assert.equal(await legacy().locator("article").count(), 1);
  await chooseOld();
  assert.equal(
    await dialog().getByLabel("明确认知状态", { exact: true }).inputValue(),
    "unspecified",
  );
  await dialog().getByLabel("认知范围", { exact: true }).selectOption("reader");
  await dialog()
    .getByLabel("明确认知状态", { exact: true })
    .selectOption("suspects");
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("读者怀疑蓝印来自船主，但尚未证实。");
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  await launch();
  await open();
  assert.equal(
    await dialog().getByLabel("认知说明", { exact: true }).inputValue(),
    "读者怀疑蓝印来自船主，但尚未证实。",
  );
  await pending().getByText(oldEvent.statement, { exact: true }).waitFor();
  owner = await store.materials.save(
    book.id,
    { ...owner, notes: "合成外部并发笔记" },
    owner,
  );
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "旧资料已改变" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 0);
  await openLegacy();
  await chooseOld();
  await dialog().getByLabel("认知范围", { exact: true }).selectOption("reader");
  await dialog()
    .getByLabel("明确认知状态", { exact: true })
    .selectOption("suspects");
  const before = await readFile(oldFile);
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await origin().getByText("林舟 · 原事件内容未改", { exact: true }).waitFor();
  assert.deepEqual(await readFile(oldFile), before);
  await origin().getByText(oldEvent.anchor.quote, { exact: true }).waitFor();
  await shot("legacy-linked-light.png");
  await origin()
    .getByRole("button", { name: "打开旧资料", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "创作资料", exact: true });
  await panel.getByLabel("资料标题", { exact: true }).waitFor();
  assert.equal(
    await panel.getByLabel("资料标题", { exact: true }).inputValue(),
    "林舟",
  );
  await panel
    .getByLabel("资料笔记", { exact: true })
    .fill("作者在旧资料中补充无关笔记。");
  await panel.getByRole("button", { name: "保存资料", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "已保存资料" }).waitFor();
  await open();
  await detail();
  await origin()
    .getByText("旧资料有其他修改，原事件内容未变。", { exact: true })
    .waitFor();
  await details()
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 1/ })
    .waitFor();
  owner = await store.materials.read(book.id, owner.id);
  await store.materials.mutateEvidence(book.id, owner, {
    action: "retire",
    eventId: oldEvent.id,
  });
  await detail();
  await origin()
    .getByText("林舟 · 原事件已改或停用", { exact: true })
    .waitFor();
  await origin().getByText(oldEvent.statement, { exact: true }).waitFor();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 806, height: 803 });
  await shot("legacy-changed-dark-narrow.png");
  await origin()
    .getByRole("button", { name: "查看旧引文位置", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    oldEvent.anchor.quote,
  );
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "41 actual legacy records paginate 40/1; explicit source selection starts with unspecified knowledge state and permits author scope/state review",
    "legacy source and author edits survive full desktop restart; a changed old-card baseline rejects creation without a new record",
    "refreshing and explicitly linking writes new event plus frozen provenance while old card bytes stay exact",
    "manual old notes change is distinct from old-event retirement; frozen source quote remains readable and navigates to its saved manuscript range; formal manuscript unchanged",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (application) {
    await page
      ?.waitForFunction(
        () => !document.querySelector(".knowledge-body:disabled"),
      )
      .catch(() => {});
    await application.close();
  }
  await writeFile(
    join(shots, "knowledge-legacy-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
