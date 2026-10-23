import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-choice-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("作者选择界面合成稿", [
  { title: "来信", body: "旧信有一道蓝印。\n林舟仍不知道发信人的名字。🌊" },
]);
const create = (kind, title) =>
  store.materials.save(book.id, {
    kind,
    title,
    fields:
      kind === "proposition"
        ? { claim: "船主就是发信人", truthIntent: "尚未确定" }
        : {},
    notes: "",
    status: "planned",
    chapterIds: [],
  });
const proposition = await create("proposition", "发信人"),
  person = await create("character", "林舟"),
  chapter = await store.readChapter(book.id, book.chapters[0].id),
  source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  },
  input = {
    propositionId: proposition.id,
    scope: "character",
    characterId: person.id,
    state: "suspects",
    statement: "林舟怀疑船主寄信。",
    storyTime: "抵港当晚",
  };
const first = await store.knowledge.save(book.id, input, null, source),
  second = await store.knowledge.save(
    book.id,
    {
      ...input,
      state: "unaware",
      statement: "另一条依据明确记载林舟不知此事。",
    },
    null,
    source,
  ),
  secondFile = join(
    data,
    "library",
    book.id,
    "knowledge/events",
    `${second.id}.json`,
  ),
  secondBytes = await readFile(secondFile);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "knowledge-choices",
);
await mkdir(shots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
    page.getByRole("dialog", { name: "认知矩阵", exact: true }),
  detail = () =>
    dialog().getByRole("region", { name: "认知记录详情", exact: true }),
  choice = () =>
    detail().getByRole("region", { name: "作者当前认知选择", exact: true });
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
}
async function open() {
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 1 个命题" })
    .waitFor();
  await dialog().getByText("选择人物列（最多 8 人）", { exact: true }).click();
  await dialog().getByRole("checkbox", { name: "林舟", exact: true }).check();
  await dialog()
    .getByRole("columnheader", { name: "林舟", exact: true })
    .waitFor();
}
async function firstDetails() {
  await dialog()
    .locator("tbody article")
    .filter({ hasText: first.statement })
    .getByRole("button", { name: "查看认知依据", exact: true })
    .click();
}
async function heading(text) {
  await choice().getByRole("heading", { name: text, exact: true }).waitFor();
}
async function shot(name, top = false) {
  await page.waitForFunction(
    () =>
      !document.querySelector(".knowledge-body:disabled") &&
      document.querySelector(".knowledge-table")?.getAttribute("aria-busy") ===
        "false",
  );
  if (top) await dialog().evaluate((el) => (el.scrollTop = 0));
  else await choice().scrollIntoViewIfNeeded();
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
  await firstDetails();
  await heading("作者尚未选择当前认知");
  await choice()
    .getByRole("button", { name: "明确采用为当前认知", exact: true })
    .click();
  await heading("作者当前选择 · 怀疑 · 有效");
  await dialog().getByText("作者选用：怀疑 · 有效", { exact: true }).waitFor();
  await shot("choice-matrix-light.png", true);
  const previous = await store.knowledge.choices.read(book.id, input);
  await store.knowledge.choices.select(
    book.id,
    second,
    previous,
    "合成并发外部改选",
  );
  await choice()
    .getByRole("button", { name: "清除当前认知选择", exact: true })
    .click();
  await dialog().getByRole("alert").filter({ hasText: "选择已改变" }).waitFor();
  assert.equal(
    (await store.knowledge.choices.read(book.id, input)).selected.id,
    second.id,
  );
  await firstDetails();
  await heading("作者当前选择 · 明确不知 · 有效");
  await choice()
    .getByRole("button", { name: "明确采用为当前认知", exact: true })
    .click();
  await heading("作者当前选择 · 怀疑 · 有效");
  await detail()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    first.anchor.quote,
  );
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+Home");
  await page.keyboard.insertText("后来，");
  await editor.press("Control+s");
  await page.waitForFunction(() =>
    document.body.textContent.includes("已保存"),
  );
  await open();
  await firstDetails();
  await heading("作者当前选择 · 怀疑 · 待复核");
  assert.equal(
    await choice()
      .getByRole("button", { name: "明确采用为当前认知", exact: true })
      .isDisabled(),
    true,
  );
  await choice().getByText("选择时冻结的记录与引文", { exact: true }).click();
  await choice().getByText(first.anchor.quote, { exact: true }).waitFor();
  await detail()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    first.anchor.quote,
  );
  await open();
  await firstDetails();
  await detail()
    .getByRole("button", { name: "修订并重新绑定依据", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 2/ })
    .waitFor();
  await heading("作者当前选择 · 怀疑 · 待复核");
  await choice()
    .getByRole("button", { name: "明确采用为当前认知", exact: true })
    .click();
  await heading("作者当前选择 · 怀疑 · 有效");
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  await launch();
  await open();
  await firstDetails();
  await heading("作者当前选择 · 怀疑 · 有效");
  await choice()
    .getByRole("button", { name: "清除当前认知选择", exact: true })
    .click();
  await heading("作者当前选择已清除");
  await choice()
    .getByRole("button", { name: "查看选择历史", exact: true })
    .click();
  await choice()
    .getByLabel("作者选择历史", { exact: true })
    .getByText("共 4 个历史选择版本，只读。", { exact: true })
    .waitFor();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 806, height: 803 });
  await shot("choice-history-dark-narrow.png");
  assert.equal(
    (await store.knowledge.choices.read(book.id, input)).status,
    "cleared",
  );
  assert.equal((await store.knowledge.list(book.id)).total, 2);
  assert.deepEqual(await readFile(secondFile), secondBytes);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    "后来，" + chapter.body,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual author selection freezes one explicit event without removing contradictory records; matrix shows the choice separately",
    "external same-cell decision cannot be cleared with a stale UI baseline; re-reading permits explicit author change",
    "manuscript edit expires the old choice; original quote remains visible and current-source rebinding alone does not silently reconfirm the choice",
    "explicit new selection survives full restart; clearing preserves four prior choice versions and unchosen event bytes; dark narrow history remains reachable",
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
    join(shots, "knowledge-choices-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
