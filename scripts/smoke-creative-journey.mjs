import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "creative-journey-")),
  store = new NovelStore(join(data, "library")),
  book = await store.createBook("雨港来信·完整创作合成稿");
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "creative-journey",
);
await mkdir(shots, { recursive: true });
const model = await modelFixture({ readMaterials: true }),
  env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page;
const report = { status: "running", checks: [], errors: [], viewports: [] };
const panel = () => page.getByRole("region", { name: "创作资料", exact: true });
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
  await page.getByRole("button", { name: "试写实验室", exact: true }).waitFor();
}
async function materials() {
  if (
    !(await page
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
}
async function card(kind, title, fields, chapterTitle) {
  await panel()
    .getByRole("combobox", { name: "新建类型", exact: true })
    .selectOption(kind);
  await panel().getByRole("button", { name: "新建资料", exact: true }).click();
  await panel().getByLabel("资料标题", { exact: true }).fill(title);
  for (const [label, value] of Object.entries(fields)) {
    const field = panel().getByLabel(label, { exact: true });
    if (await field.evaluate((element) => element.tagName === "SELECT"))
      await field.selectOption(value);
    else await field.fill(value);
  }
  if (chapterTitle) {
    if (!(await panel().getByLabel(chapterTitle, { exact: true }).isVisible()))
      await panel().locator("summary").filter({ hasText: "关联章节" }).click();
    await panel().getByLabel(chapterTitle, { exact: true }).check();
  }
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "已保存资料" }).waitFor();
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
  await page.getByRole("button", { name: "整理创作资料", exact: true }).click();
  await shot("empty-book-light.png");
  await card("idea", "追信与失踪的父亲", {
    题材与读者承诺: "少年追索父亲失踪真相",
    核心冲突: "渡船将离港，唯一的信使拒绝交信",
    独特切入点: "灯塔每次熄灭都会改变信上的地址",
  });
  await page.getByRole("button", { name: "先做一场试写", exact: true }).click();
  const pilot = page.getByRole("dialog", { name: "试写实验室", exact: true });
  await pilot.getByLabel("实验标题", { exact: true }).fill("同一场景比较行动");
  await pilot
    .getByLabel("共同场景任务", { exact: true })
    .fill("林舟来到渡口，在船离港前取回旧信。");
  await pilot
    .getByText("关联创意、人物或场景资料（已选 0/8）", { exact: true })
    .click();
  await pilot
    .getByRole("checkbox", { name: "追信与失踪的父亲", exact: true })
    .check();
  await pilot.getByRole("button", { name: "建立实验组", exact: true }).click();
  await pilot
    .getByRole("button", { name: "新建空白样稿", exact: true })
    .click();
  await pilot.getByLabel("试写标题", { exact: true }).fill("沿岸追船版");
  await pilot
    .getByLabel("试写叙事视角", { exact: true })
    .fill("贴近林舟的第三人称");
  const sample = "林舟站在栈桥尽头。\n船离岸了，他转身奔向下游渡口。🌧️";
  await pilot.getByLabel("试写正文编辑器", { exact: true }).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(sample);
  await pilot.getByRole("button", { name: "保存试写", exact: true }).click();
  await pilot.getByRole("status").filter({ hasText: "试写已保存" }).waitFor();
  await pilot
    .getByLabel("选定理由", { exact: true })
    .fill("追船行动推动追信主线，保留第三人称声音。");
  await pilot
    .getByRole("button", { name: "选定这个版本", exact: true })
    .click();
  await pilot
    .getByRole("status", { name: "选定版本状态" })
    .filter({ hasText: "版本一致" })
    .waitFor();
  const chapterTitle = "第一章 雨港追信";
  assert.equal((await store.listBooks()).books[0].chapters.length, 0);
  await pilot.getByLabel("试写转章标题", { exact: true }).fill(chapterTitle);
  await pilot
    .getByRole("button", { name: "建立新章节并打开", exact: true })
    .click();
  await pilot.waitFor({ state: "hidden" });
  const editor = page.getByLabel("正文编辑器", { exact: true });
  assert.equal(await editor.innerText(), sample);
  const currentBook = (await store.listBooks()).books.find(
      (item) => item.id === book.id,
    ),
    chapter = currentBook.chapters.find((item) => item.title === chapterTitle);
  assert.ok(chapter);
  assert.equal(currentBook.chapters.length, 1);
  await materials();
  await card("outline", "雨港全书总纲", {
    纲要层级: "全书总纲",
    目标与规模: "追寻失踪父亲",
    关键因果: "取信迫使林舟离港，地址指向内陆",
    终局与落点: "决定公开父亲守护的秘密",
  });
  await card(
    "character",
    "林舟的人物弧线",
    {
      欲望与目标: "找到父亲，拒绝被隐瞒",
      语言与声音: "少解释，以行动回答",
      人物变化: "由独自追问变为承担公开真相的代价",
    },
    chapterTitle,
  );
  await card(
    "outline",
    "雨港近期细纲",
    {
      纲要层级: "近期细纲",
      目标与规模: "本章取回信，下一章发现地址变化",
      关键因果: "船离港迫使林舟选择下游渡口",
      不可逆转折: "信使发现林舟追船",
    },
    chapterTitle,
  );
  await card(
    "scene",
    "追到下游渡口",
    {
      场景目标: "取回旧信",
      阻碍: "船将离港",
      人物选择: "沿岸追船",
      结果与局面变化: "打开旧信，地址改变",
    },
    chapterTitle,
  );
  const scene = (await store.materials.list(book.id, { kind: "scene" }))
    .items[0];
  await page.getByRole("button", { name: "场景编排", exact: true }).click();
  const planning = page.getByRole("dialog", { name: "场景编排", exact: true });
  await planning
    .getByLabel("移动 追到下游渡口 到章节", { exact: true })
    .selectOption(chapter.id);
  const column = planning.getByRole("region", {
    name: `规划列：${chapterTitle}`,
    exact: true,
  });
  await column
    .getByRole("article", { name: "场景：追到下游渡口", exact: true })
    .waitFor();
  await planning.getByRole("button", { name: "章纲", exact: true }).click();
  await shot("planned-chapter-light.png");
  await column
    .getByRole("button", { name: "打开本章正文", exact: true })
    .click();
  await planning.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "写作工具", exact: true }).click();
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-creative-journey-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await page.locator(".context-selector:visible > summary").click();
  for (const title of [
    "雨港全书总纲",
    "林舟的人物弧线",
    "雨港近期细纲",
    "追到下游渡口",
  ])
    await page.getByRole("checkbox", { name: title, exact: true }).check();
  await page.getByLabel("将发送的资料快照", { exact: true }).waitFor();
  await materials();
  await panel()
    .getByRole("button", { name: /^林舟的人物弧线/ })
    .click();
  await panel()
    .getByLabel("语言与声音", { exact: true })
    .fill("修订声音：克制，以动作代替解释");
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "已保存资料" }).waitFor();
  await page.getByRole("button", { name: "写作工具", exact: true }).click();
  const preview = page.getByLabel("将发送的资料快照", { exact: true });
  await preview
    .locator("summary")
    .filter({ hasText: "林舟的人物弧线 · 版本 1" })
    .waitFor();
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "资料或证据已改变" })
    .waitFor();
  assert.equal(model.requests.length, 0);
  await page.getByRole("button", { name: "刷新资料快照", exact: true }).click();
  await preview
    .locator("summary")
    .filter({ hasText: "林舟的人物弧线 · 版本 2" })
    .waitFor();
  const materialBaselines = await Promise.all(
    (await store.materials.list(book.id)).items.map(async (item) => [
      item.id,
      (await store.materials.read(book.id, item.id)).diskHash,
    ]),
  );
  await page
    .getByLabel("写作要求", { exact: true })
    .fill("按细纲续写追信场景，保留人物行动与声音，不自动确认作者计划为事实。");
  await editor.click();
  await page.keyboard.press("Control+A");
  assert.equal(model.requests.length, 0);
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  const review = page.getByRole("dialog", {
    name: "审阅 AI 候选",
    exact: true,
  });
  await review.waitFor({ timeout: 45000 });
  assert.equal((await store.readChapter(book.id, chapter.id)).body, sample);
  assert.equal(model.requests.length, 4);
  const sent = JSON.stringify(model.requests);
  for (const title of [
    "雨港全书总纲",
    "林舟的人物弧线",
    "雨港近期细纲",
    "追到下游渡口",
  ])
    assert.ok(sent.includes(title));
  assert.ok(sent.includes("修订声音"));
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_change_propose",
      "novel_materials_read",
      "novel_selection_read",
    ]);
  await review.getByRole("button", { name: "接受候选", exact: true }).click();
  await review.waitFor({ state: "hidden" });
  await page.getByText("已保存", { exact: true }).waitFor();
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    model.replacement,
  );
  await application.close();
  application = null;
  await launch();
  await page
    .locator(".chapter-list button")
    .filter({ hasText: chapterTitle })
    .click();
  assert.equal(
    await page.getByLabel("正文编辑器", { exact: true }).innerText(),
    model.replacement,
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await page.getByTitle("深色主题", { exact: true }).click();
  await shot("written-chapter-narrow.png");
  const group = (await store.pilots.listGroups(book.id)).items[0];
  assert.equal(
    (await store.pilots.readGroup(book.id, group.id)).selection.snapshot.body,
    sample,
  );
  assert.equal(
    (await store.planning.read(book.id)).columns.find(
      (item) => item.id === chapter.id,
    ).scenes[0].id,
    scene.id,
  );
  assert.equal((await store.materials.list(book.id)).total, 5);
  for (const [id, diskHash] of materialBaselines)
    assert.equal((await store.materials.read(book.id, id)).diskHash, diskHash);
  assert.equal(model.requests.length, 4);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "actual empty-book entry points and labeled forms create idea and source-bound pilot selection without formal chapters; explicit promotion creates exactly one chapter, followed by master outline, character, detailed outline and scene; frozen pilot selection stays unchanged",
    "scene is placed against exact promoted chapter identity and opens that manuscript; four explicit planning references travel through official Harness then author review acceptance writes only formal text",
    "new reference options appear automatically after authoring cards; a UI edit refreshes only options while selected version 1 stays frozen, generation rejects with zero requests, explicit refresh selects version 2",
    "real desktop restart preserves manuscript, selected pilot, planning placement and all five materials with zero replay; all model content is synthetic fixture data, not literary-quality evidence",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await application?.close();
  await model.close();
  await writeFile(
    join(shots, "creative-journey-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
