import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "pilots-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("试写分支合成验证", [
  { title: "正式首章", body: "林舟推开了窗。\r\n🌧️ 原始首章保留。" },
]);
const material = await store.materials.save(book.id, {
  kind: "idea",
  title: "雨港立项",
  status: "planned",
  fields: {
    promise: "通过取信行动展开失踪悬念",
    conflict: "追上信使还是留在家中",
  },
  notes: "同一场景比较人物行动",
  chapterIds: [],
});
const original = await readFile(
  join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
);
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "pilots",
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
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; Playwright Electron",
  inputBoundary:
    "Chinese insertText and keyboard undo; native Windows IME not exercised",
};
const dialog = () =>
  page.getByRole("dialog", { name: "试写实验室", exact: true });
const button = (name) => dialog().getByRole("button", { name, exact: true });
const field = (name) => dialog().getByLabel(name, { exact: true });
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
  await page.getByLabel("正文编辑器", { exact: true }).waitFor();
  await page.getByRole("button", { name: "试写实验室", exact: true }).click();
}
async function body(text) {
  await field("试写正文编辑器").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
}
async function saved() {
  await button("保存试写").click();
  await dialog()
    .getByRole("status")
    .filter({ hasText: "试写已保存，正式章节未改动" })
    .waitFor();
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
  await field("实验标题").fill("同一雨港：追信实验");
  await field("共同场景任务").fill(
    "渡船即将离港，林舟必须取回父亲留下的旧信。固定场景，比较人物行动和叙述声音。",
  );
  await dialog()
    .getByText("关联创意、人物或场景资料（已选 0/8）", { exact: true })
    .click();
  await dialog()
    .getByRole("checkbox", { name: material.title, exact: true })
    .check();
  await button("建立实验组").click();
  await button("新建空白样稿").click();
  await field("试写标题").fill("追信 · 第一人称");
  for (const [label, value] of [
    ["叙事视角", "林舟第一人称"],
    ["语言与声音", "短句，急促，感官直接"],
    ["人物行动", "冒雨追赶离港信使"],
    ["场景阻碍", "渡船已离岸，旧信在信使手中"],
    ["读者承诺", "取回旧信，逐步揭开父亲失踪的原因"],
  ])
    await field(`试写${label}`).fill(value);
  const firstBody =
    "我冲下栈桥。🌧️\n船已经离岸了。\n我脱下外衣，跳进冰冷的河里。";
  await body(firstBody);
  await saved();
  const firstId = await field("选择试写样稿").inputValue();
  await button("复制为独立分支").click();
  await field("试写标题").fill("追信 · 第三人称");
  await field("试写叙事视角").fill("第三人称限知，贴近林舟");
  await field("试写语言与声音").fill("克制，以动作代替解释");
  await field("试写人物行动").fill("沿河追船，寻找下游靠岸点");
  const secondBody = "林舟停在栈桥尽头。\n他没有喊叫，而是转身奔向下游的渡口。";
  await body(secondBody);
  await saved();
  const secondId = await field("选择试写样稿").inputValue();
  await field("选择对照样稿").selectOption(firstId);
  await dialog()
    .getByRole("region", { name: "样稿对照", exact: true })
    .getByText(firstBody, { exact: true })
    .waitFor();
  await dialog()
    .getByRole("region", { name: "当前试写编辑", exact: true })
    .scrollIntoViewIfNeeded();
  await dialog().evaluate((element) => {
    const panes = element.querySelector(".pilot-panes"),
      header = element.querySelector(":scope > header");
    element.scrollTop +=
      panes.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      header.getBoundingClientRect().height -
      24;
  });
  await shot("comparison-light.png");
  await field("选择对照样稿").selectOption("");
  await field("选定理由").fill(
    "第三人称版本的行动选择更具体，并保留信件悬念。",
  );
  await button("选定这个版本").click();
  await dialog()
    .getByRole("status", { name: "选定版本状态" })
    .filter({ hasText: "版本一致" })
    .waitFor();
  await field("反馈来源").fill("合成读者甲 / 首轮试读");
  await field("反馈内容").fill("追船行动清楚，期待旧信里的信息。");
  await button("归档试读反馈").click();
  await dialog().getByText("反馈与稿件快照已归档。", { exact: true }).waitFor();
  const draft = secondBody + "\n沿河的灯一盏盏亮了起来。";
  await body(draft);
  await field("试写正文编辑器").press("Control+Z");
  assert.equal(await field("试写正文编辑器").innerText(), secondBody);
  await field("试写正文编辑器").press("Control+Y");
  assert.equal(await field("试写正文编辑器").innerText(), draft);
  await field("试写标题").fill("");
  await application.close();
  application = null;
  await launch();
  await field("试写正文编辑器")
    .getByText("沿河的灯一盏盏亮了起来。", { exact: true })
    .waitFor();
  assert.equal(await field("试写标题").inputValue(), "");
  await field("试写标题").fill("追信 · 第三人称修订");
  await saved();
  await dialog()
    .getByRole("status", { name: "选定版本状态" })
    .filter({ hasText: "版本已变化" })
    .waitFor();
  const groupId = await field("选择试写实验组").inputValue();
  const feedback = await store.pilots.versions(book.id, secondId, true);
  assert.equal(feedback[0].snapshot.body, secondBody);
  assert.equal(
    (await store.pilots.readGroup(book.id, groupId)).selection.snapshot.body,
    secondBody,
  );
  assert.equal((await store.pilots.read(book.id, firstId)).body, firstBody);
  report.checks.push(
    "actual UI creates source-bound scene experiment, independent branches and saved comparison; selection and feedback freeze the prior version; Chinese keyboard edits/undo/redo; real close/relaunch restores unsaved body and temporarily blank title",
  );
  const path = join(data, "library", book.id, "pilots", `${secondId}.md`),
    external = draft + "\n外部编辑者补充。";
  await writeFile(path, external);
  await body(draft + "\n本机待合并调整。");
  await button("保存试写").click();
  await dialog().getByRole("alert").filter({ hasText: "外部编辑" }).waitFor();
  assert.equal(await readFile(path, "utf8"), external);
  await button("读取磁盘版本供对照").click();
  await dialog()
    .getByRole("region", { name: "磁盘版本对照" })
    .getByText(external, { exact: true })
    .waitFor();
  await button("保留本地调整，以此磁盘版本为基线").click();
  const merged = external + "\n本机待合并调整。";
  await body(merged);
  await saved();
  assert.ok(
    (await store.pilots.versions(book.id, secondId)).some(
      (entry) => entry.body === external,
    ),
  );
  // Fault-inject browser storage exhaustion; actions remain real visible UI/native close interactions.
  await page.evaluate(() => {
    window.__pilotOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.pilot-draft."))
        throw new DOMException(
          "Synthetic quota exhaustion",
          "QuotaExceededError",
        );
      return window.__pilotOriginalSetItem.call(this, key, value);
    };
  });
  await field("试写语言与声音").fill("克制，保留雨声；模拟草稿空间不足");
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "草稿空间不足" })
    .waitFor();
  assert.equal(await field("选择试写样稿").isDisabled(), true);
  assert.equal(await button("关闭试写实验室").isDisabled(), true);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await dialog().getByRole("alert").filter({ hasText: "关闭已取消" }).waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__pilotOriginalSetItem;
    delete window.__pilotOriginalSetItem;
  });
  await field("试写语言与声音").press("Control+s");
  await dialog()
    .getByRole("status")
    .filter({ hasText: "试写已保存，正式章节未改动" })
    .waitFor();
  assert.equal(await button("关闭试写实验室").isEnabled(), true);
  report.checks.push(
    "synthetic localStorage quota exhaustion blocks sample navigation and native window close; explicit Ctrl+S persists current changes and clears close guard",
  );
  await button("移入样稿回收站").click();
  await button("恢复样稿").click();
  await field("试写正文编辑器").waitFor();
  assert.equal(await field("试写正文编辑器").innerText(), merged);
  await store.materials.save(
    book.id,
    { ...material, notes: "后续立项调整，原试写来源不能随之替换" },
    material,
  );
  await button("刷新实验状态").click();
  await dialog().getByText("来源快照与当前状态（1）", { exact: true }).click();
  await dialog()
    .getByRole("heading", { name: /雨港立项.*版本已变化/ })
    .waitFor();
  report.checks.push(
    "external same-revision body changes block save and preserve both; explicit disk comparison/rebase preserves external version in history; soft delete/restore keeps identity and body; source freshness changes without changing original scene snapshot",
  );
  await field("选择对照样稿").selectOption(firstId);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await dialog()
    .getByRole("region", { name: "样稿对照", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("comparison-dark-narrow.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
  );
  await field("试写转章标题").fill("由第三人称试写建立的章节");
  await button("建立新章节并打开").click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(
    await page.getByLabel("章节标题", { exact: true }).inputValue(),
    "由第三人称试写建立的章节",
  );
  assert.equal(
    await page.getByLabel("正文编辑器", { exact: true }).innerText(),
    merged,
  );
  assert.deepEqual(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
    ),
    original,
  );
  const backup = await store.createBackup(book.id, join(data, "backups")),
    restored = await store.restoreBackup(backup.path);
  assert.deepEqual(
    await store.pilots.read(restored.id, secondId),
    await store.pilots.read(book.id, secondId),
  );
  assert.deepEqual(
    await store.pilots.readGroup(restored.id, groupId),
    await store.pilots.readGroup(book.id, groupId),
  );
  assert.deepEqual(
    await store.pilots.versions(restored.id, secondId, true),
    feedback,
  );
  report.checks.push(
    "dark narrow comparison has no page/dialog overflow; explicit promotion opens a new chapter with exact trial text and original first-chapter bytes unchanged; whole-book backup restores branch/group/selection/feedback under new book identity",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  if (page)
    await page
      .screenshot({ path: join(screenshots, "failure.png") })
      .catch(() => {});
  throw e;
} finally {
  if (application) await application.close();
  await writeFile(
    join(screenshots, "pilots-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
