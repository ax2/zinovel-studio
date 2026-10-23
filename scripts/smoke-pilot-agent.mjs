import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "pilot-agent-")),
  store = new NovelStore(join(data, "library")),
  journal = new TaskJournal(join(data, "tasks"));
const crashCases = [];
for (const stage of ["intent-written", "pilot-saved"]) {
  const book = await store.createBook(`试写恢复 ${stage}`),
    group = await store.pilots.createGroup(book.id, {
      title: "恢复实验",
      scene: "追船",
    }),
    pilot = await store.pilots.save(book.id, group.id, {
      title: "恢复样稿",
      body: "接受前的稿件。",
    }),
    pack = await store.pilots.taskSnapshot(book.id, pilot),
    id = randomUUID();
  await journal.create(
    {
      id,
      kind: "pilot",
      bookId: book.id,
      pilotId: pilot.id,
      pilotTitle: pilot.title,
      status: "preparing",
      skillId: "novel-pilot",
      model: "synthetic-no-model",
      startedAt: new Date().toISOString(),
    },
    { context: pack.context, selectedText: "", pilotTarget: pack.target },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", { candidate: "待确认稿" });
  let code;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        join(root, "tests/fixtures/pilot-acceptance-crash.mjs"),
        data,
        id,
        stage,
      ],
      { windowsHide: true, timeout: 20000 },
    );
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, 91);
  let current = await store.pilots.read(book.id, pilot.id);
  if (stage === "pilot-saved")
    current = await store.pilots.save(
      book.id,
      group.id,
      { ...current, body: "作者在接受后修改的试写，不可被恢复覆盖。" },
      current,
    );
  crashCases.push({
    id,
    bookId: book.id,
    pilotId: pilot.id,
    bodyHash: current.bodyHash,
    diskHash: current.diskHash,
    expected: stage === "intent-written" ? "awaiting-review" : "applied",
  });
}
const book = await store.importBook("试写 AI 合成验证", [
    {
      title: "正式首章",
      body: "MANUSCRIPT_SENTINEL：这段正式稿不应进入试写模型。\r\n🌧️",
    },
  ]),
  material = await store.materials.save(book.id, {
    kind: "idea",
    title: "离港前取信",
    status: "planned",
    fields: { promise: "用取信行动展开悬念" },
    notes: "合成创意",
    chapterIds: [],
  }),
  group = await store.pilots.createGroup(book.id, {
    title: "雨港第一人称",
    scene: "渡船离港，林舟须取回父亲的信。",
    sourceIds: [material.id],
  }),
  pilot = await store.pilots.save(book.id, group.id, {
    title: "取信试写",
    body: "我站在栈桥上。",
    pov: "第一人称",
    voice: "克制",
    action: "取回父亲的信",
    obstacle: "渡船离港",
    promise: "失踪悬念",
  }),
  other = await store.pilots.save(book.id, group.id, {
    title: "其他分支",
    body: "OTHER_PILOT_SENTINEL：不能自动读取。",
  });
await store.materials.save(book.id, {
  kind: "character",
  title: "未选择的人物",
  status: "planned",
  fields: {},
  notes: "UNSELECTED_MATERIAL_SENTINEL",
  chapterIds: [],
});
const original = await readFile(
  join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
);
let suspended = false,
  releaseReply;
const model = await modelFixture({
  pilot: true,
  beforeReply: async () => {
    if (suspended)
      await new Promise((resolve) => {
        releaseReply = resolve;
      });
  },
});
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "pilot-agent",
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
const studio = () =>
  page.getByRole("dialog", { name: "试写实验室", exact: true });
const assistant = () =>
  studio().getByRole("region", { name: "试写 AI 协作", exact: true });
const review = () =>
  page.getByRole("dialog", { name: "审阅 AI 候选", exact: true });
async function expand(text, parent = assistant()) {
  const summary = parent.getByText(text, { exact: true });
  if (!(await summary.evaluate((element) => element.parentElement.open)))
    await summary.click();
}
async function launch(settings = false) {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_APP_EXE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  if (settings) {
    await page.getByLabel("主导航").getByTitle("模型设置").click();
    await page.getByLabel("服务地址").fill(model.url);
    await page.getByLabel("API Key").fill("synthetic-pilot-key");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page
      .getByRole("dialog", { name: "模型设置" })
      .waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "试写实验室", exact: true }).click();
  await studio()
    .getByLabel("选择试写样稿", { exact: true })
    .selectOption(pilot.id);
  await page.waitForFunction(
    (title) =>
      document.querySelector('[aria-label="试写标题"]')?.value === title,
    pilot.title,
  );
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
  await launch(true);
  for (const item of crashCases) {
    assert.equal((await journal.read(item.id)).record.status, item.expected);
    const current = await store.pilots.read(item.bookId, item.pilotId);
    assert.equal(current.bodyHash, item.bodyHash);
    assert.equal(current.diskHash, item.diskHash);
  }
  report.checks.push(
    "real worker exit(91) before/after pilot write; actual desktop startup reconciles correct task type, preserves later author edits and never replays model output",
  );
  await expand("AI 试写当前分支");
  await assistant()
    .getByRole("button", { name: "估算试写任务", exact: true })
    .click();
  await assistant()
    .getByRole("status")
    .filter({ hasText: "作者材料约" })
    .waitFor();
  assert.equal(model.requests.length, 0);
  await store.materials.save(
    book.id,
    { ...material, notes: "生成前修改，必须刷新快照" },
    material,
  );
  await assistant()
    .getByRole("button", { name: "生成试写候选", exact: true })
    .click();
  await assistant().getByRole("alert").filter({ hasText: "刷新" }).waitFor();
  assert.equal(model.requests.length, 0);
  await assistant()
    .getByRole("button", { name: "刷新试写快照", exact: true })
    .click();
  await assistant()
    .getByRole("button", { name: "生成试写候选", exact: true })
    .click();
  await review().waitFor({ timeout: 45000 });
  assert.equal(model.requests.length, 3);
  for (const request of model.requests) {
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_pilot_propose",
      "novel_pilot_read",
    ]);
    const sent = JSON.stringify(request);
    for (const sentinel of [
      "MANUSCRIPT_SENTINEL",
      "OTHER_PILOT_SENTINEL",
      "UNSELECTED_MATERIAL_SENTINEL",
    ])
      assert.equal(sent.includes(sentinel), false);
    assert.match(sent, /本任务只为当前试写分支/);
  }
  assert.equal(
    (await store.pilots.read(book.id, pilot.id)).diskHash,
    pilot.diskHash,
  );
  const authorDraft = "我沿河追赶渡船。🌊\n父亲的信还在船上，我不能就此停下。";
  await review().getByLabel("候选文本", { exact: true }).fill(authorDraft);
  await review()
    .getByRole("button", { name: "保存审阅草稿", exact: true })
    .click();
  await review()
    .getByRole("status", { name: "审阅草稿状态" })
    .filter({ hasText: "已保存" })
    .waitFor();
  await review()
    .getByRole("heading", { name: "原试写正文", exact: true })
    .waitFor();
  await shot("pilot-review-light.png");
  // Reopen the same task detail as well as a real process restart: both must use the latest saved review draft.
  await review().getByRole("button", { name: "关闭候选", exact: true }).click();
  await assistant()
    .getByRole("button", { name: "审阅试写候选", exact: true })
    .click();
  assert.equal(
    await review().getByLabel("候选文本", { exact: true }).inputValue(),
    authorDraft,
  );
  await application.close();
  application = null;
  await launch();
  const summary = assistant()
    .locator(":scope > details")
    .filter({
      has: page.locator("summary").filter({ hasText: /^这份试写的 AI 任务/ }),
    })
    .locator(":scope > summary");
  await summary.click();
  await assistant()
    .getByRole("button", { name: /待审阅$/ })
    .click();
  await review().waitFor();
  assert.equal(
    await review().getByLabel("候选文本", { exact: true }).inputValue(),
    authorDraft,
  );
  assert.equal(model.requests.length, 3);
  await review().getByRole("button", { name: "接受候选", exact: true }).click();
  await review().waitFor({ state: "hidden" });
  await assistant()
    .getByText("已接受试写候选，正式章节未改动。", { exact: true })
    .waitFor();
  const accepted = await store.pilots.read(book.id, pilot.id);
  assert.equal(accepted.body, authorDraft);
  assert.equal(accepted.title, pilot.title);
  assert.equal(accepted.voice, pilot.voice);
  assert.deepEqual(await store.pilots.read(book.id, other.id), other);
  assert.deepEqual(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
    ),
    original,
  );
  report.checks.push(
    "official Harness makes exactly three scoped tool requests; preview/estimate zero requests; changed source blocks dispatch; no unrelated sample/material/manuscript sent; review is proposal-only, saves draft, reopens in same session and after real relaunch, explicit acceptance changes only pilot body",
  );
  await expand("AI 试写当前分支");
  await assistant()
    .getByRole("button", { name: "生成试写候选", exact: true })
    .click();
  await review().waitFor({ timeout: 45000 });
  const changed = await store.pilots.save(
    book.id,
    group.id,
    { ...accepted, body: authorDraft + "\n作者在生成后又手改。" },
    accepted,
  );
  await review().getByRole("button", { name: "接受候选", exact: true }).click();
  await review().getByRole("alert").filter({ hasText: "外部编辑" }).waitFor();
  assert.equal(
    (await store.pilots.read(book.id, pilot.id)).diskHash,
    changed.diskHash,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await shot("pilot-stale-dark-narrow.png");
  await review().getByRole("button", { name: "关闭候选", exact: true }).click();
  await studio()
    .getByRole("button", { name: "读取磁盘版本供对照", exact: true })
    .click();
  await studio()
    .getByRole("button", { name: "放弃本地调整并重读", exact: true })
    .click();
  await studio()
    .getByLabel("试写正文编辑器", { exact: true })
    .getByText("作者在生成后又手改。", { exact: true })
    .waitFor();
  await expand("AI 试写当前分支");
  suspended = true;
  await assistant()
    .getByRole("button", { name: "生成试写候选", exact: true })
    .click();
  for (let attempt = 0; attempt < 150 && !releaseReply; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(releaseReply, "model request reached suspended fixture");
  await assistant()
    .getByRole("button", { name: "取消试写生成", exact: true })
    .click();
  releaseReply();
  suspended = false;
  await assistant()
    .getByRole("alert")
    .filter({ hasText: /取消|中断/ })
    .waitFor({ timeout: 30000 });
  const tasks = await journal.list(book.id, 40, { pilotId: pilot.id });
  assert.ok(tasks.some((item) => item.status === "cancelled"));
  assert.ok(tasks.some((item) => item.status === "awaiting-review"));
  assert.equal(
    (await store.pilots.read(book.id, pilot.id)).diskHash,
    changed.diskHash,
  );
  await application.close();
  application = null;
  const requestsBeforeRestart = model.requests.length;
  await launch();
  assert.equal(model.requests.length, requestsBeforeRestart);
  await studio().getByRole("button", { name: "关闭试写实验室", exact: true }).click();
  await page.getByTitle("写作任务", { exact: true }).click();
  await page.locator(".task-row").filter({ hasText: pilot.title }).first().click();
  await page.getByText("这是独立试写任务。", { exact: false }).waitFor();
  assert.equal(await page.getByText("这是没有章节绑定的旧版任务", { exact: false }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "用当前选区重试", exact: true }).count(), 0);
  assert.deepEqual(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
    ),
    original,
  );
  report.checks.push(
    "stale candidate rejects without replacing newer author manuscript; dark narrow review remains usable; explicit cancel stops in-flight provider request; restart neither retries model nor applies retained candidate",
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
  releaseReply?.();
  if (application) await application.close();
  await model.close();
  await writeFile(
    join(screenshots, "pilot-agent-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
