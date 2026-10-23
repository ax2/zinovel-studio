import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-target-ui-")),
  store = new NovelStore(join(data, "library")),
  book = await store.importBook("资料试写认知上下文合成稿", [
    {
      title: "蓝印",
      body: "旧信有一道蓝印。\nFORMAL_UNSELECTED_BODY_SENTINEL",
    },
  ]);
const make = (kind, title, fields = {}, notes = "") =>
  store.materials.save(book.id, {
    kind,
    title,
    fields,
    notes,
    status: "planned",
    chapterIds: [],
  });
const person = await make("character", "林舟", {}, "原始人物资料"),
  p = await make(
    "proposition",
    "寄信人",
    { claim: "船主寄信", truthIntent: "作者设定为真" },
    "UNSELECTED_TRUTH_SENTINEL",
  );
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
    state: "suspects",
    statement: "只属于林舟的初始怀疑。",
    storyTime: "抵港日",
  };
let event = await store.knowledge.save(book.id, input, null, source);
await store.knowledge.save(
  book.id,
  {
    ...input,
    scope: "reader",
    characterId: null,
    statement: "OTHER_KNOWLEDGE_SENTINEL",
  },
  null,
  source,
);
const group = await store.pilots.createGroup(book.id, {
    title: "独立试写场景",
    scene: "雨港取信",
  }),
  pilot = await store.pilots.save(book.id, group.id, {
    title: "试写一",
    body: "我站在栈桥上。",
    pov: "第一人称",
  });
const materialModel = await modelFixture({
    readMaterials: true,
    materialProposal: {
      title: person.title,
      fields: person.fields,
      notes: "供审阅的人物资料候选",
    },
  }),
  pilotModel = await modelFixture({ readMaterials: true, pilot: true });
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
  "knowledge-context-targets",
);
await mkdir(shots, { recursive: true });
const report = { status: "running", checks: [], errors: [] };
let application, page;
async function settings(url) {
  await page.getByLabel("主导航").getByTitle("模型设置").click();
  await page.getByLabel("服务地址").fill(url);
  await page.getByLabel("API Key").fill("synthetic-mixed-target-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "模型设置" })
    .waitFor({ state: "hidden" });
}
async function select(parent) {
  await parent.locator("summary").filter({ hasText: "本次参考资料" }).click();
  await parent
    .getByLabel("参考资料类型", { exact: true })
    .selectOption("knowledge");
  await parent
    .getByRole("checkbox", { name: /寄信人 · 人物：林舟 · 怀疑/ })
    .check();
  await parent.getByLabel("将发送的资料快照", { exact: true }).waitFor();
}
try {
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
  await settings(materialModel.url);
  if (
    !(await page
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
  const panel = page.getByRole("region", { name: "创作资料", exact: true });
  await panel.getByRole("button", { name: /^林舟/ }).click();
  const material = panel.getByRole("region", {
    name: "资料 AI 协作",
    exact: true,
  });
  await material.getByText("AI 完善这份资料", { exact: true }).click();
  await material
    .getByLabel("资料修改要求", { exact: true })
    .fill("根据所选认知完善人物动机，保持已有事实。");
  await select(material);
  assert.equal(materialModel.requests.length, 0);
  event = await store.knowledge.save(
    book.id,
    { ...input, statement: "人物资料生成前更新的怀疑。" },
    event,
    source,
  );
  await material
    .getByRole("button", { name: "生成资料候选", exact: true })
    .click();
  await material
    .getByRole("alert")
    .filter({ hasText: "资料或证据已改变" })
    .waitFor();
  assert.equal(materialModel.requests.length, 0);
  await material
    .getByRole("button", { name: "刷新资料快照", exact: true })
    .click();
  await material
    .getByLabel("将发送的资料快照", { exact: true })
    .locator("summary")
    .filter({ hasText: "版本 2" })
    .waitFor();
  await material
    .getByRole("button", { name: "生成资料候选", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "审阅资料候选", exact: true })
    .waitFor({ timeout: 45000 });
  assert.equal(materialModel.requests.length, 4);
  for (const request of materialModel.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_material_propose",
      "novel_material_read",
      "novel_materials_read",
    ]);
  await page.screenshot({ path: join(shots, "material-knowledge-review.png") });
  await page.getByLabel("关闭资料候选", { exact: true }).click();
  assert.equal(
    (await store.materials.read(book.id, person.id)).notes,
    person.notes,
  );
  await settings(pilotModel.url);
  await page.getByRole("button", { name: "试写实验室", exact: true }).click();
  const studio = page.getByRole("dialog", { name: "试写实验室", exact: true });
  await studio
    .getByLabel("选择试写样稿", { exact: true })
    .selectOption(pilot.id);
  const assistant = studio.getByRole("region", {
    name: "试写 AI 协作",
    exact: true,
  });
  await assistant.getByText("AI 试写当前分支", { exact: true }).click();
  await select(assistant);
  event = await store.knowledge.save(
    book.id,
    { ...input, statement: "试写生成前更新的怀疑。" },
    event,
    source,
  );
  await assistant
    .getByRole("button", { name: "估算试写任务", exact: true })
    .click();
  await assistant
    .getByRole("alert")
    .filter({ hasText: "资料或认知已改变" })
    .waitFor();
  assert.equal(pilotModel.requests.length, 0);
  await assistant
    .getByRole("button", { name: "刷新资料快照", exact: true })
    .click();
  await assistant
    .getByLabel("将发送的资料快照", { exact: true })
    .locator("summary")
    .filter({ hasText: "版本 3" })
    .waitFor();
  await assistant
    .getByRole("button", { name: "估算试写任务", exact: true })
    .click();
  await assistant.getByText(/作者材料约/).waitFor();
  assert.equal(pilotModel.requests.length, 0);
  await assistant
    .getByRole("button", { name: "生成试写候选", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "审阅 AI 候选" })
    .waitFor({ timeout: 45000 });
  assert.equal(pilotModel.requests.length, 4);
  for (const request of pilotModel.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_materials_read",
      "novel_pilot_propose",
      "novel_pilot_read",
    ]);
  await page.screenshot({ path: join(shots, "pilot-knowledge-review.png") });
  await page.getByLabel("关闭候选", { exact: true }).click();
  const messages = JSON.stringify([
    ...materialModel.requests,
    ...pilotModel.requests,
  ]);
  assert.match(messages, /人物资料生成前更新的怀疑/);
  assert.match(messages, /试写生成前更新的怀疑/);
  assert.doesNotMatch(
    messages,
    /UNSELECTED_TRUTH_SENTINEL|OTHER_KNOWLEDGE_SENTINEL|FORMAL_UNSELECTED_BODY_SENTINEL|作者设定为真/,
  );
  assert.equal((await store.pilots.read(book.id, pilot.id)).body, pilot.body);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "material proposal UI rejects stale knowledge with zero requests then uses only material-read, frozen-reference-read and proposal after refresh; original card unchanged",
    "pilot UI rejects stale knowledge before estimation and generation; refreshed estimate sends zero requests and official Harness uses only pilot-read, frozen-reference-read and pilot proposal",
    "both target prompts/tool results contain selected knowledge without unselected truth, other knowledge or whole formal manuscript; no candidate is applied automatically",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await materialModel.close();
  await pilotModel.close();
  await writeFile(
    join(shots, "knowledge-context-targets-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
