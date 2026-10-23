import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-ui-"));
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("认知矩阵界面合成验证", [
  { title: "来信", body: "旧信有一道蓝印。\n林舟怀疑船主就是发信人。🌊" },
  { title: "倒叙", body: "一年前，船主还没有收到这封信。" },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id);
const create = (title, kind) =>
  store.materials.save(book.id, {
    title,
    kind,
    fields:
      kind === "proposition"
        ? { claim: "船主就是发信人", truthIntent: "尚未确定" }
        : {},
    notes: "合成计划",
    status: "planned",
    chapterIds: [],
  });
const person = await create("林舟", "character"),
  proposition = await create("发信人的身份", "proposition");
await create("另一封信的身份", "proposition");
const source = {
  chapterId: chapter.id,
  body: chapter.body,
  hash: chapter.diskHash,
  start: 0,
  end: 9,
};
await store.knowledge.save(
  book.id,
  {
    propositionId: proposition.id,
    scope: "reader",
    characterId: null,
    state: "believes",
    statement: "读者相信这封信来自船主，尚无证实。",
    storyTime: "抵港当晚",
  },
  null,
  source,
);
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
  "knowledge",
);
await mkdir(shots, { recursive: true });
const report = { status: "running", checks: [], errors: [], viewports: [] };
let application, page;
const dialog = () =>
  page.getByRole("dialog", { name: "认知矩阵", exact: true });
async function open() {
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 2 个命题" })
    .waitFor();
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
}
async function shot(name) {
  await page.waitForFunction(
    () =>
      document.querySelector(".knowledge-table")?.getAttribute("aria-busy") ===
      "false",
  );
  await dialog().evaluate((element) => {
    element.scrollTop = 0;
  });
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
async function selectSource() {
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
}
const row = () =>
  dialog().locator("tbody tr").filter({ hasText: "发信人的身份" });
const detail = () =>
  dialog().getByRole("region", { name: "认知记录详情", exact: true });
try {
  await launch();
  await selectSource();
  await open();
  await dialog().getByText("选择人物列（最多 8 人）", { exact: true }).click();
  await dialog().getByRole("checkbox", { name: "林舟", exact: true }).check();
  await dialog()
    .getByRole("columnheader", { name: "林舟", exact: true })
    .waitFor();
  await row().getByText("相信", { exact: true }).waitFor();
  assert.ok((await row().getByText("没有记录", { exact: true }).count()) >= 2);
  await row()
    .getByRole("button", { name: "为此命题记录认知", exact: true })
    .click();
  await dialog()
    .getByLabel("认知范围", { exact: true })
    .selectOption("character");
  await dialog()
    .getByLabel("认知人物", { exact: true })
    .selectOption(person.id);
  await dialog()
    .getByLabel("明确认知状态", { exact: true })
    .selectOption("suspects");
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("林舟怀疑船主写信，但没有证实。🌊");
  await dialog().getByLabel("认知故事时间", { exact: true }).fill("抵港当晚");
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 1/ })
    .waitFor();
  let events = await store.knowledge.list(book.id);
  assert.equal(events.total, 2);
  const event = events.items.find((item) => item.scope === "character");
  assert.equal(event.anchor.quote, chapter.body.split("\n")[0]);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  await shot("matrix-light.png");
  await detail()
    .getByRole("button", { name: "修订并重新绑定依据", exact: true })
    .click();
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("重启后的认知草稿：林舟仍只是在怀疑。");
  await dialog().getByText("新建命题与秘密", { exact: true }).click();
  await dialog().getByLabel("新命题名称", { exact: true }).fill("重启保留命题");
  await dialog()
    .getByLabel("新命题内容", { exact: true })
    .fill("这封信隐藏着另一个名字。");
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await application.close();
  application = null;
  await launch();
  await selectSource();
  await open();
  assert.equal(
    await dialog().getByLabel("认知说明", { exact: true }).inputValue(),
    "重启后的认知草稿：林舟仍只是在怀疑。",
  );
  await dialog().getByText("新建命题与秘密", { exact: true }).click();
  assert.equal(
    await dialog().getByLabel("新命题名称", { exact: true }).inputValue(),
    "重启保留命题",
  );
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /怀疑 · 有效 · 版本 2/ })
    .waitFor();
  await detail()
    .getByRole("button", { name: "查看认知历史", exact: true })
    .click();
  await detail()
    .getByLabel("认知历史", { exact: true })
    .getByText("林舟怀疑船主写信，但没有证实。🌊", { exact: true })
    .waitFor();
  await detail()
    .getByRole("button", { name: "停用认知记录", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /版本 3/ })
    .waitFor();
  await detail()
    .getByRole("button", { name: "恢复认知记录", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /版本 4/ })
    .waitFor();
  await detail()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.split("\n")[0],
  );
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+Home");
  await page.keyboard.insertText("后来，");
  await editor.press("Control+s");
  await page.waitForFunction(() =>
    document.body.textContent.includes("已保存"),
  );
  await open();
  await dialog()
    .getByRole("button", { name: "全部认知记录", exact: true })
    .click();
  const list = dialog().getByRole("region", {
    name: "认知记录列表",
    exact: true,
  });
  await list.getByRole("heading", { name: "全部认知记录 · 2 条" }).waitFor();
  await list
    .locator("article")
    .filter({ hasText: "重启后的认知草稿" })
    .getByRole("button", { name: "查看记录详情", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /待复核 · 版本 4/ })
    .waitFor();
  await detail()
    .getByRole("button", { name: "查看正文依据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    chapter.body.split("\n")[0],
  );
  await open();
  await dialog()
    .getByRole("button", { name: "全部认知记录", exact: true })
    .click();
  await list
    .locator("article")
    .filter({ hasText: "重启后的认知草稿" })
    .getByRole("button", { name: "查看记录详情", exact: true })
    .click();
  await detail()
    .getByRole("button", { name: "修订并重新绑定依据", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "保存并绑定当前选区", exact: true })
    .click();
  await detail()
    .getByRole("heading", { name: /有效 · 版本 5/ })
    .waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.setViewportSize({ width: 806, height: 803 });
  await shot("matrix-dark-narrow.png");
  await dialog().getByText("新建命题与秘密", { exact: true }).click();
  await dialog().getByRole("button", { name: "创建命题", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 3 个命题" })
    .waitFor();
  await dialog()
    .getByRole("button", { name: "全部认知记录", exact: true })
    .click();
  await list.getByRole("heading", { name: "全部认知记录 · 2 条" }).waitFor();
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await page.evaluate(() => {
    window.__knowledgeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.knowledge-draft."))
        throw new DOMException("合成空间不足", "QuotaExceededError");
      return window.__knowledgeSetItem.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "共 3 个命题" })
    .waitFor();
  await row()
    .getByRole("button", { name: "为此命题记录认知", exact: true })
    .click();
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("草稿空间不足时，窗口必须保留这段输入。");
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  assert.equal(await dialog().isVisible(), true);
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "草稿保存尚未完成" })
    .waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__knowledgeSetItem;
    delete window.__knowledgeSetItem;
  });
  await dialog()
    .getByLabel("认知说明", { exact: true })
    .fill("空间恢复后，草稿已保存到本机。");
  await dialog()
    .getByRole("button", { name: "关闭认知矩阵", exact: true })
    .click();
  await page.getByRole("button", { name: "认知矩阵", exact: true }).click();
  assert.equal(
    await dialog().getByLabel("认知说明", { exact: true }).inputValue(),
    "空间恢复后，草稿已保存到本机。",
  );
  await dialog()
    .getByRole("button", { name: "放弃认知草稿", exact: true })
    .click();
  report.checks.push(
    "synthetic localStorage quota failure blocks dialog close without losing input; after storage recovers the same draft reopens intact and can be explicitly discarded",
  );
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    "后来，" + chapter.body,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual UI distinguishes belief, suspicion and empty cells; saved Unicode source binding never changes manuscript",
    "event and proposition drafts survive full desktop restart; revision CAS and original quote history remain visible",
    "retire/restore, source jump, author edit invalidation and explicit current-source rebind work",
    "dark narrow view and manual proposition creation complete without model requests; narrative source bytes preserved",
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
    join(shots, "knowledge-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
