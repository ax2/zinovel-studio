import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "creation-ui-")),
  store = new NovelStore(join(data, "library")),
  book = await store.importBook("认知保存回执合成稿", [
    { title: "来信", body: "旧信有一道蓝印。" },
  ]);
await store.materials.save(book.id, {
  kind: "proposition",
  title: "寄信人",
  fields: { claim: "船主寄信", truthIntent: "尚未确定" },
  notes: "",
  status: "planned",
  chapterIds: [],
});
const chapter = await store.readChapter(book.id, book.chapters[0].id),
  source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  };
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
  "knowledge-creation",
);
await mkdir(shots, { recursive: true });
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
    page.getByRole("dialog", { name: "认知矩阵", exact: true }),
  save = () =>
    dialog().getByRole("button", { name: "保存并绑定当前选区", exact: true }),
  recovery = () =>
    dialog().getByRole("region", { name: "已保存认知恢复", exact: true });
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
  await open();
}
async function open() {
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 1 个命题" })
    .waitFor();
}
async function start(text) {
  await dialog()
    .getByRole("button", { name: "为此命题记录认知", exact: true })
    .click();
  await dialog().getByLabel("认知说明", { exact: true }).fill(text);
  await page.waitForFunction(
    () => !document.querySelector(".knowledge-body:disabled"),
  );
}
async function faults(both) {
  await page.evaluate((both) => {
    window.__remove = Storage.prototype.removeItem;
    window.__set = Storage.prototype.setItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith("zinovel.knowledge-draft."))
        throw new DOMException("合成清理失败", "SecurityError");
      return window.__remove.call(this, key);
    };
    if (both)
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("zinovel.knowledge-draft."))
          throw new DOMException("合成写草稿失败", "QuotaExceededError");
        return window.__set.call(this, key, value);
      };
  }, both);
}
async function restore() {
  await page.evaluate(() => {
    if (window.__remove) {
      Storage.prototype.removeItem = window.__remove;
      Storage.prototype.setItem = window.__set;
      delete window.__remove;
      delete window.__set;
    }
  });
}
async function shot(name) {
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
  await start("第一条合成认知。");
  await faults(false);
  await save().click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "记录已保存到书库" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  assert.equal(await save().isDisabled(), true);
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  assert.equal(await dialog().isVisible(), true);
  await shot("cleanup-error-protected.png");
  await restore();
  await dialog()
    .getByRole("button", { name: "重试清理已保存草稿", exact: true })
    .click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "本机草稿已清理" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  await start("第二条合成认知，清理及回执草稿写入均故障。");
  const birth = await page.evaluate(
    (bookId) =>
      JSON.parse(localStorage.getItem(`zinovel.knowledge-draft.${bookId}`)),
    book.id,
  );
  assert.ok(birth.creationId);
  await faults(true);
  await save().click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "记录已保存到书库" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 2);
  const exited = new Promise((resolve) =>
    application.process().once("exit", resolve),
  );
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await exited;
  application = null;
  await launch();
  await recovery()
    .getByText("第二条合成认知，清理及回执草稿写入均故障。", { exact: true })
    .waitFor();
  assert.equal(await save().isDisabled(), true);
  await recovery()
    .getByRole("button", { name: "找回已保存记录，保留当前调整", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "放弃认知草稿", exact: true })
    .click();
  assert.equal((await store.knowledge.list(book.id)).total, 2);
  await start("第三条合成草稿，模拟持久写入后尚无界面回执。");
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (el) => el.textContent === "保存并绑定当前选区",
      )?.disabled,
  );
  const pending = await page.evaluate(
    (bookId) =>
      JSON.parse(localStorage.getItem(`zinovel.knowledge-draft.${bookId}`)),
    book.id,
  );
  let committed = await store.knowledge.save(
    book.id,
    pending.input,
    null,
    source,
    null,
    pending.creationId,
  );
  committed = await store.knowledge.save(
    book.id,
    { ...pending.input, statement: "作者在回执丢失后又修订了这条记录。" },
    committed,
    source,
  );
  await save().click();
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "已有保存记录" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 3);
  await dialog()
    .getByRole("button", { name: "检查是否已保存", exact: true })
    .click();
  await recovery().getByText(committed.statement, { exact: true }).waitFor();
  assert.equal(
    await dialog().getByLabel("认知说明", { exact: true }).inputValue(),
    pending.input.statement,
  );
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  await launch();
  await recovery().getByText(committed.statement, { exact: true }).waitFor();
  await recovery()
    .getByRole("button", { name: "找回已保存记录，保留当前调整", exact: true })
    .click();
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("作者找回后明确调整同一条认知。");
  await save().click();
  await dialog()
    .getByRole("region", { name: "认知记录详情", exact: true })
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 3/ })
    .waitFor();
  const current = await store.knowledge.read(book.id, pending.creationId);
  assert.equal(current.statement, "作者找回后明确调整同一条认知。");
  assert.equal((await store.knowledge.list(book.id)).total, 3);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  await start("旧版格式草稿升级后明确保存。");
  await page.evaluate((bookId) => {
    const key = `zinovel.knowledge-draft.${bookId}`,
      data = JSON.parse(localStorage.getItem(key));
    delete data.creationId;
    localStorage.setItem(key, JSON.stringify(data));
  }, book.id);
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  await launch();
  await save().click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "认知已保存，正文未改写。" })
    .waitFor();
  assert.equal((await store.knowledge.list(book.id)).total, 4);
  assert.deepEqual(report.errors, []);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 806, height: 803 });
  await shot("creation-recovered-dark-narrow.png");
  report.checks.push(
    "actual save commits once when localStorage.removeItem fails; repeat save and dialog close are protected; cleanup retry preserves one record",
    "simultaneous draft cleanup and fallback persistence failure followed by forced app exit still recovers the already-saved creation through its durable draft identity",
    "synthetic durable-save/no-renderer-receipt checkpoint plus later author edit rejects stale retry; explicit lookup and full restart retain on-screen draft, and explicit recovery edits the same record rather than creating another",
    "old-format draft without creation identity migrates before explicit save; four deliberate author creation intents remain exactly four records and manuscript bytes never change",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (application) {
    await restore().catch(() => {});
    await page
      ?.getByRole("button", { name: "放弃认知草稿", exact: true })
      .click({ timeout: 3000 })
      .catch(() => {});
    await page
      ?.waitForFunction(
        () => !document.querySelector(".knowledge-body:disabled"),
      )
      .catch(() => {});
    await application.close();
  }
  await writeFile(
    join(shots, "knowledge-creation-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
