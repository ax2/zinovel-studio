import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "evidence-ui-")),
  store = new NovelStore(join(data, "library"));
const body = "旧信上有一道蓝印。\n林舟把信收进衣袋，船主没有开口。🌊";
const book = await store.importBook("伏笔与人物证据验证", [
  { title: "抵港", body },
  { title: "夜航", body: "夜里，船驶离港口。" },
]);
const base = (kind, title) => ({
  kind,
  title,
  status: "accepted",
  notes: "合成计划",
  fields: {},
  chapterIds: [],
});
const clue = await store.materials.save(
    book.id,
    base("foreshadow", "信上的蓝印"),
  ),
  character = await store.materials.save(book.id, base("character", "林舟"));
let captain = await store.materials.save(
  book.id,
  base("character", "船主顾远"),
);
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "evidence",
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
const panel = () => page.getByRole("region", { name: "创作资料", exact: true });
const evidence = () => panel().getByLabel("正文证据", { exact: true });
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
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
}
async function selectLine() {
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+Home");
  await editor.press("Shift+End");
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
  await panel()
    .getByRole("button", { name: /信上的蓝印/ })
    .click();
  await selectLine();
  await evidence()
    .locator("summary")
    .filter({ hasText: "添加正文证据" })
    .click();
  await evidence()
    .getByRole("combobox", { name: "证据类型", exact: true })
    .selectOption("plant");
  await evidence()
    .getByLabel("证据说明", { exact: true })
    .fill("蓝印首次出现，读者尚不知道意义。");
  await evidence().getByLabel("故事时间", { exact: true }).fill("抵港当天");
  await evidence()
    .getByRole("combobox", { name: "认知范围", exact: true })
    .selectOption("reader");
  await evidence()
    .getByRole("button", { name: "绑定当前选区为证据", exact: true })
    .click();
  await evidence()
    .getByRole("heading", { name: "伏笔埋设 · 正文版本一致" })
    .waitFor();
  let read = await store.materials.read(book.id, clue.id);
  assert.equal(read.evidence[0].anchor.quote, body.split("\n")[0]);
  const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  );
  assert.equal(await readFile(manuscript, "utf8"), body);
  await evidence()
    .getByRole("heading", { name: "伏笔埋设 · 正文版本一致" })
    .scrollIntoViewIfNeeded();
  await snapshot("planted-light.png");
  await page
    .locator(".chapter-list")
    .getByRole("button", { name: /夜航/ })
    .click();
  await page
    .getByLabel("正文编辑器")
    .getByText("夜里，船驶离港口。", { exact: true })
    .waitFor();
  await evidence()
    .getByRole("button", { name: "定位正文证据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    body.split("\n")[0],
  );
  const editor = page.getByLabel("正文编辑器");
  await editor.press("Control+Home");
  await page.keyboard.insertText("后来，");
  await editor.press("Control+s");
  await evidence()
    .getByRole("heading", { name: "伏笔埋设 · 正文已变或缺失 · 待复核" })
    .waitFor();
  read = await store.materials.read(book.id, clue.id);
  assert.equal(read.evidence[0].anchor.quote, body.split("\n")[0]);
  assert.equal(read.evidence[0].resolution.status, "relocated");
  await snapshot("source-changed.png");
  await evidence()
    .getByRole("button", { name: "定位正文证据", exact: true })
    .click();
  await page.waitForFunction(
    (quote) => window.getSelection()?.toString() === quote,
    body.split("\n")[0],
  );
  assert.equal(
    (await store.materials.read(book.id, clue.id)).evidence[0].freshness,
    "stale",
  );
  report.checks.push(
    "evidence navigation resolves the current editor text after manuscript changes and selects the exact original quote without silently reconfirming evidence",
  );
  await selectLine();
  await evidence()
    .getByRole("button", { name: "用当前选区重新确认", exact: true })
    .click();
  await evidence()
    .getByRole("heading", { name: "伏笔埋设 · 正文版本一致" })
    .waitFor();
  read = await store.materials.read(book.id, clue.id);
  assert.equal(read.evidence[0].anchor.quote, "后来，" + body.split("\n")[0]);
  report.checks.push(
    "real keyboard selection binds exact saved manuscript to a planted clue without changing it; manual manuscript save automatically marks old evidence stale; explicit reconfirm updates only the selected evidence and retains prior history",
  );
  await panel().getByRole("button", { name: /^林舟/ }).click();
  await selectLine();
  await evidence()
    .locator("summary")
    .filter({ hasText: "添加正文证据" })
    .click();
  await evidence()
    .getByRole("combobox", { name: "证据类型", exact: true })
    .selectOption("relation");
  await evidence()
    .getByLabel("证据说明", { exact: true })
    .fill("林舟开始怀疑船主。");
  await evidence()
    .getByRole("combobox", { name: "认知范围", exact: true })
    .selectOption("character");
  await evidence().getByLabel("故事时间", { exact: true }).fill("抵港之后");
  await evidence()
    .getByRole("checkbox", { name: "船主顾远", exact: true })
    .check();
  await evidence()
    .getByRole("button", { name: "绑定当前选区为证据", exact: true })
    .click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 正文版本一致" })
    .waitFor();
  await evidence()
    .getByRole("combobox", { name: "证据类型", exact: true })
    .selectOption("knowledge");
  await evidence()
    .getByRole("combobox", { name: "认知范围", exact: true })
    .selectOption("reader");
  await evidence()
    .getByLabel("证据说明", { exact: true })
    .fill("读者知道信上有蓝印，尚不知道来历。");
  await evidence()
    .getByRole("button", { name: "绑定当前选区为证据", exact: true })
    .click();
  await evidence()
    .getByRole("heading", { name: "认知变化 · 正文版本一致" })
    .waitFor();
  read = await store.materials.read(book.id, character.id);
  assert.equal(read.evidence.length, 2);
  assert.equal(read.evidence[0].scope, "character");
  assert.equal(read.evidence[1].scope, "reader");
  captain = await store.materials.save(
    book.id,
    { ...captain, fields: { desire: "隐瞒旧信的来源" } },
    captain,
  );
  await evidence()
    .getByRole("button", { name: "重新检查证据", exact: true })
    .click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 关联资料已变或未核对 · 待复核" })
    .waitFor();
  await snapshot("dependency-changed.png");
  await selectLine();
  await evidence()
    .getByRole("button", { name: "用当前选区重新确认", exact: true })
    .first()
    .click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 正文版本一致" })
    .waitFor();
  report.checks.push(
    "linked character definition changes mark source-stable relationship evidence for review; explicit reconfirmation records current dependency versions without changing manuscript bytes; unrelated knowledge stays current",
  );
  await evidence()
    .getByRole("heading", { name: "认知变化 · 正文版本一致" })
    .waitFor();
  await evidence()
    .getByRole("button", { name: "停用证据", exact: true })
    .first()
    .click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 已停用" })
    .waitFor();
  await application.close();
  application = null;
  await launch();
  await panel().getByRole("button", { name: /^林舟/ }).click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 已停用" })
    .waitFor();
  await evidence()
    .getByRole("heading", { name: "认知变化 · 正文版本一致" })
    .waitFor();
  report.checks.push(
    "relationship and reader/character knowledge records remain distinct; retirement keeps prior evidence; actual app restart preserves identities, scopes and states without replay or manuscript writes",
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  if (!(await panel().isVisible()))
    await page.getByTitle("打开创作参考").click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await evidence()
    .getByRole("heading", { name: "关系变化 · 已停用" })
    .scrollIntoViewIfNeeded();
  await snapshot("knowledge-dark-narrow.png");
  assert.equal(await readFile(manuscript, "utf8"), "后来，" + body);
  // Repeated and missing quotes must not select an arbitrary range, including in the drawer layout.
  for (const [replacement, warning] of [
    [("后来，" + body + "\n").repeat(2), "证据引文在当前稿件中有多个匹配"],
    ["原始线索已经从正文删除。", "证据引文在当前稿件中已找不到"],
  ]) {
    if (await page.getByLabel("关闭创作参考", { exact: true }).isVisible())
      await page.getByLabel("关闭创作参考", { exact: true }).click();
    const currentEditor = page.getByLabel("正文编辑器");
    await currentEditor.press("Control+a");
    await page.keyboard.insertText(replacement);
    await currentEditor.press("Control+s");
    await page
      .getByRole("status", { name: "正文保存状态" })
      .filter({ hasText: "已保存" })
      .waitFor();
    if (!(await panel().isVisible()))
      await page.getByTitle("打开创作参考").click();
    await panel()
      .getByRole("button", { name: /^信上的蓝印/ })
      .click();
    await evidence()
      .getByRole("button", { name: "定位正文证据", exact: true })
      .click();
    await page.getByText(new RegExp(warning)).waitFor();
    assert.equal(await readFile(manuscript, "utf8"), replacement);
    assert.equal(
      (await store.materials.read(book.id, clue.id)).evidence[0].anchor.quote,
      "后来，" + body.split("\n")[0],
    );
  }
  await snapshot("missing-evidence-narrow.png");
  report.checks.push(
    "cross-chapter navigation selects the source after the target editor commits; duplicate and deleted quotes produce explicit warnings and never rewrite manuscript or evidence",
  );
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
  await writeFile(
    join(screenshots, "evidence-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
