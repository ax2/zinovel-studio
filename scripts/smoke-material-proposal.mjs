import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { validateMaterialInput } from "../packages/novel-domain/materials.mjs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "material-proposal-ui-"));
const store = new NovelStore(join(data, "library"));
const journal = new TaskJournal(join(data, "tasks")),
  crashCases = [];
for (const stage of ["intent-written", "material-saved"]) {
  const crashBook = await store.createBook(`资料恢复 ${stage}`);
  const original = await store.materials.save(crashBook.id, {
    kind: "character",
    title: "崩溃恢复角色",
    status: "planned",
    fields: {},
    notes: "旧计划",
    chapterIds: [],
  });
  const id = randomUUID();
  await journal.create(
    {
      id,
      kind: "material",
      materialId: original.id,
      materialTitle: original.title,
      bookId: crashBook.id,
      status: "preparing",
      skillId: "novel-character",
      model: "synthetic-no-model",
      startedAt: new Date().toISOString(),
    },
    {
      context: "合成恢复资料",
      selectedText: "",
      instruction: "恢复验证",
      materialTarget: {
        bookId: crashBook.id,
        id: original.id,
        revision: original.revision,
        diskHash: original.diskHash,
        input: validateMaterialInput(original),
      },
    },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: JSON.stringify({
      title: original.title,
      fields: {},
      notes: "模型候选",
    }),
  });
  let code;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        join(root, "tests/fixtures/material-acceptance-crash.mjs"),
        data,
        id,
        stage,
      ],
      { windowsHide: true, timeout: 20000 },
    );
  } catch (error) {
    code = error.code;
  }
  assert.equal(
    code,
    91,
    "worker must exit at the durable material acceptance checkpoint",
  );
  let current = await store.materials.read(crashBook.id, original.id);
  if (stage === "material-saved")
    current = await store.materials.save(
      crashBook.id,
      { ...current, notes: "接受后又被作者修改的计划" },
      current,
    );
  crashCases.push({
    id,
    bookId: crashBook.id,
    cardId: original.id,
    diskHash: current.diskHash,
    expected: stage === "intent-written" ? "awaiting-review" : "applied",
  });
}
const book = await store.importBook("人物提案合成验证", [
  { title: "抵港", body: "林舟在岸边等船。" },
]);
const card = await store.materials.save(book.id, {
  kind: "character",
  title: "林舟",
  status: "planned",
  fields: { desire: "离开港口", voice: "惜字如金" },
  notes: "尚未写入正文",
  chapterIds: [book.chapters[0].id],
});
const model = await modelFixture({
  materialProposal: {
    title: "林舟",
    fields: { desire: "找到旧信的主人", voice: "先问事实，再下判断" },
    notes: "模型提出的计划",
  },
});
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "material-proposal",
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
const assistant = () =>
  panel().getByRole("region", { name: "资料 AI 协作", exact: true });
const review = () =>
  page.getByRole("dialog", { name: "审阅资料候选", exact: true });
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
  if (
    !(await page
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
  await panel().getByRole("button", { name: /^林舟/ }).click();
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
async function reopenTask() {
  const details = assistant()
    .locator("details")
    .filter({
      has: page.locator("summary").filter({ hasText: "这份资料的 AI 任务" }),
    })
    .first();
  if (!(await details.evaluate((element) => element.open)))
    await details.locator("summary").click();
  await assistant().locator(".material-task-row").first().click();
  await review().waitFor();
}
try {
  await launch();
  for (const item of crashCases) {
    assert.equal((await journal.read(item.id)).record.status, item.expected);
    assert.equal(
      (await store.materials.read(item.bookId, item.cardId)).diskHash,
      item.diskHash,
    );
  }
  report.checks.push(
    "two worker processes actually exit after material intent / durable book receipt; actual desktop startup restores pending review or applied state without overwriting later author edits or calling the model",
  );
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(model.url);
  await page.getByLabel("API Key").fill("synthetic-material-proposal-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
  await assistant()
    .locator("summary")
    .filter({ hasText: "AI 完善这份资料" })
    .click();
  await assistant()
    .getByLabel("资料修改要求", { exact: true })
    .fill("完善人物行动目标和声音，保留章节与证据。");
  await assistant()
    .getByRole("button", { name: "估算资料任务", exact: true })
    .click();
  await assistant()
    .getByRole("status")
    .filter({ hasText: "作者材料约" })
    .waitFor();
  assert.equal(model.requests.length, 0);
  await assistant()
    .getByRole("button", { name: "生成资料候选", exact: true })
    .click();
  await review().waitFor({ timeout: 45000 });
  assert.equal(model.requests.length, 3);
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_material_propose",
      "novel_material_read",
    ]);
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    card.diskHash,
  );
  await review()
    .getByLabel("候选笔记", { exact: true })
    .fill("作者调整：隐瞒旧信，但不隐瞒出身。🌊");
  await review().getByLabel("候选标题", { exact: true }).fill("");
  await review()
    .getByRole("button", { name: "保存资料审阅草稿", exact: true })
    .click();
  await review()
    .getByRole("status")
    .filter({ hasText: "已保存资料审阅草稿" })
    .waitFor();
  await snapshot("review-light.png");
  await application.close();
  application = null;
  await launch();
  await reopenTask();
  assert.equal(
    await review().getByLabel("候选笔记", { exact: true }).inputValue(),
    "作者调整：隐瞒旧信，但不隐瞒出身。🌊",
  );
  assert.equal(model.requests.length, 3);
  assert.equal(
    await review().getByLabel("候选标题", { exact: true }).inputValue(),
    "",
  );
  await review().getByLabel("候选标题", { exact: true }).fill("林舟");
  await review()
    .getByLabel("候选笔记", { exact: true })
    .fill("作者最终选择：先查信，再离港。🌊");
  await review()
    .getByRole("button", { name: "接受资料修改", exact: true })
    .click();
  await review().waitFor({ state: "hidden" });
  const accepted = await store.materials.read(book.id, card.id);
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.status, "planned");
  assert.equal(accepted.fields.desire, "找到旧信的主人");
  assert.equal(accepted.notes, "作者最终选择：先查信，再离港。🌊");
  assert.deepEqual(accepted.chapterIds, card.chapterIds);
  await reopenTask();
  assert.equal(
    await review().getByLabel("候选笔记", { exact: true }).inputValue(),
    "作者最终选择：先查信，再离港。🌊",
  );
  assert.equal(
    await review()
      .getByRole("button", { name: "接受资料修改", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("关闭资料候选", { exact: true }).click();
  // New proposal must not overwrite edits made after its frozen baseline.
  const generateDetails = assistant()
    .locator("summary")
    .filter({ hasText: "AI 完善这份资料" });
  if (
    !(await generateDetails.evaluate((element) => element.parentElement.open))
  )
    await generateDetails.click();
  await assistant()
    .getByLabel("资料修改要求", { exact: true })
    .fill("另提一版供比较");
  await assistant()
    .getByRole("button", { name: "生成资料候选", exact: true })
    .click();
  await review().waitFor({ timeout: 45000 });
  const external = await store.materials.save(
    book.id,
    { ...accepted, notes: "作者在另一窗口更新设定" },
    accepted,
  );
  await review()
    .getByRole("button", { name: "接受资料修改", exact: true })
    .click();
  await review()
    .getByRole("alert")
    .filter({ hasText: "生成后已改变" })
    .waitFor();
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    external.diskHash,
  );
  await snapshot("stale-proposal.png");
  await page.getByLabel("关闭资料候选", { exact: true }).click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  if (!(await panel().isVisible()))
    await page.getByTitle("打开创作参考").click();
  await reopenTask();
  await snapshot("review-dark-narrow.png");
  await review()
    .getByLabel("候选笔记", { exact: true })
    .scrollIntoViewIfNeeded();
  await snapshot("review-dark-fields.png");
  assert.ok(
    await review().evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
  );
  assert.equal(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
      "utf8",
    ),
    "林舟在岸边等船。",
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "real official Harness exposes exactly material-read/propose; preview sends no model requests; typed candidate leaves original card/manuscript unchanged; saved author review survives restart without replay and explicit acceptance preserves host-owned fields",
    "accepted task is read-only; subsequent proposal rejects competing card edits and keeps both candidate and current card; light desktop and dark narrow semantic review remain usable",
  );
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
  await model.close();
  await writeFile(
    join(screenshots, "material-proposal-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
