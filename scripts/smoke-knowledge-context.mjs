import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-context-ui-")),
  store = new NovelStore(join(data, "library")),
  book = await store.importBook("认知Agent上下文合成稿", [
    { title: "蓝印", body: "旧信有一道蓝印。\n林舟望着潮水。" },
  ]),
  other = await store.createBook("他书隔离");
const make = (bookId, kind, title, fields = {}, notes = "") =>
  store.materials.save(bookId, {
    kind,
    title,
    fields,
    notes,
    status: "planned",
    chapterIds: [],
  });
const p = await make(
    book.id,
    "proposition",
    "寄信人",
    { claim: "船主是寄信人", truthIntent: "作者设定为真" },
    "UNSELECTED_TRUTH_SENTINEL",
  ),
  person = await make(book.id, "character", "林舟");
await make(other.id, "character", "他书人物", {
  voice: "OTHER_BOOK_KNOWLEDGE_SENTINEL",
});
const chapter = await store.readChapter(book.id, book.chapters[0].id),
  source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  },
  input = {
    propositionId: p.id,
    scope: "character",
    characterId: person.id,
    state: "believes",
    statement: "林舟相信船主寄信，尚未证实。",
    storyTime: "抵港日",
  };
let event = await store.knowledge.save(book.id, input, null, source);
await store.knowledge.save(
  book.id,
  {
    ...input,
    scope: "reader",
    characterId: null,
    statement: "SAME_BOOK_UNSELECTED_KNOWLEDGE_SENTINEL",
  },
  null,
  source,
);
await store.knowledge.choices.select(book.id, event, null);
const model = await modelFixture({ readMaterials: true }),
  shots = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-004",
    "knowledge-context",
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
// After launch, the actual host is the only active book writer, including recovery reads.
const hostRequest = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const preview = () => page.getByLabel("将发送的资料快照", { exact: true });
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
async function expandPreview() {
  for (const summary of await preview().locator("summary").all())
    if (!(await summary.evaluate((el) => el.parentElement.open)))
      await summary.click();
}
async function shot(name) {
  await preview().scrollIntoViewIfNeeded();
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
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-knowledge-context-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await page.locator("summary").filter({ hasText: "本次参考资料" }).click();
  await page
    .getByLabel("参考资料类型", { exact: true })
    .selectOption("knowledge");
  await page
    .getByRole("checkbox", { name: /寄信人 · 人物：林舟 · 相信/ })
    .check();
  await preview().waitFor();
  await page.getByLabel("参考资料类型", { exact: true }).selectOption("choice");
  await page
    .getByRole("checkbox", { name: /寄信人 · 人物：林舟 · 作者选用相信/ })
    .check();
  await preview().locator("summary").filter({ hasText: "作者选择" }).waitFor();
  await expandPreview();
  assert.match(await preview().textContent(), /状态：相信/);
  assert.equal(model.requests.length, 0);
  await shot("mixed-knowledge-preview-light.png");
  event = await hostRequest("knowledge.save", {
    bookId: book.id,
    input: {
      ...input,
      state: "suspects",
      statement: "林舟现在怀疑船主寄信，仍未证实。",
    },
    expected: event,
    source,
  });
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "资料或证据已改变" })
    .waitFor();
  assert.equal(model.requests.length, 0);
  await page.getByRole("button", { name: "刷新资料快照", exact: true }).click();
  await preview()
    .locator("summary")
    .filter({ hasText: "认知 · 寄信人" })
    .filter({ hasText: "版本 2" })
    .waitFor();
  await expandPreview();
  assert.match(await preview().textContent(), /林舟现在怀疑船主寄信/);
  assert.match(await preview().textContent(), /林舟相信船主寄信/);
  await editor.press("Control+a");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  assert.equal(model.requests.length, 4);
  for (const req of model.requests)
    assert.deepEqual(req.tools.map((tool) => tool.name).sort(), [
      "novel_change_propose",
      "novel_materials_read",
      "novel_selection_read",
    ]);
  const messages = JSON.stringify(model.requests);
  assert.match(messages, /林舟现在怀疑船主寄信/);
  assert.match(messages, /林舟相信船主寄信/);
  assert.doesNotMatch(
    messages,
    /UNSELECTED_TRUTH_SENTINEL|OTHER_BOOK_KNOWLEDGE_SENTINEL|SAME_BOOK_UNSELECTED_KNOWLEDGE_SENTINEL|作者设定为真/,
  );
  assert.ok(
    model.requests[2].messages.some((message) =>
      JSON.stringify(message).includes("knowledge-event"),
    ),
  );
  await page.getByLabel("关闭候选", { exact: true }).click();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.locator("summary").filter({ hasText: "当时的参考资料" }).click();
  await page
    .getByRole("dialog", { name: "写作任务记录" })
    .getByText(/林舟现在怀疑船主寄信/)
    .waitFor();
  event = await hostRequest("knowledge.save", {
    bookId: book.id,
    input: { ...input, state: "knows", statement: "任务后修改的新认知哨兵" },
    expected: event,
    source,
  });
  await application.close();
  application = null;
  await launch();
  await page.getByRole("button", { name: "写作任务记录", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.locator("summary").filter({ hasText: "当时的参考资料" }).click();
  const history = page.getByRole("dialog", { name: "写作任务记录" });
  await history.getByText(/林舟现在怀疑船主寄信/).waitFor();
  assert.equal(await history.getByText(/任务后修改的新认知哨兵/).count(), 0);
  assert.equal(model.requests.length, 4);
  await page.getByLabel("关闭任务记录").click();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 806, height: 803 });
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.locator("summary").filter({ hasText: "本次参考资料" }).click();
  await page.getByLabel("参考资料类型", { exact: true }).selectOption("choice");
  await page.getByRole("checkbox", { name: /作者选用相信/ }).check();
  await preview().waitFor();
  await expandPreview();
  await shot("knowledge-choice-dark-narrow.png");
  assert.equal(
    (
      await hostRequest("chapter.read", {
        bookId: book.id,
        chapterId: chapter.id,
      })
    ).body,
    chapter.body,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual UI selects a knowledge event and frozen author choice; preview sends zero requests and a changed event blocks generation before any model call",
    "official Harness uses exactly selection-read, bounded frozen-context-read and proposal tools; request and tool output contain selected suspicion plus frozen belief, no unselected truth/person/other-book sentinel",
    "task context survives later event edits and full desktop restart without replay or manuscript changes; dark narrow selected-choice preview stays readable",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await model.close();
  await writeFile(
    join(shots, "knowledge-context-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
