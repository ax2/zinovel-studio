import { _electron as electron } from "playwright";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

if (!process.argv[2] || !process.argv[3])
  throw new Error(
    "Usage: node scripts/smoke-image-task-backcompat.mjs OLD_31_EXE OLD_31_MANIFEST",
  );
const root = resolve(import.meta.dirname, ".."),
  executable = resolve(process.argv[2]),
  manifest = JSON.parse(await readFile(resolve(process.argv[3]), "utf8")),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  expected = (value) => ({
    id: value.id,
    revision: value.revision,
    diskHash: value.diskHash,
  });
assert.equal(manifest.version, "0.1.0-alpha.31");
const previousAsarSha256 = hash(
  await readFile(join(dirname(executable), "resources/app.asar")),
);
assert.equal(previousAsarSha256, manifest.imageStudio.appAsarSha256);
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache/image-backcompat-")),
  out = join(root, "screenshots/stage-006/image-task-backcompat");
await mkdir(out, { recursive: true });
const store = new NovelStore(join(data, "library")),
  book = await store.importBook("旧版只读保护合成书", [
    { title: "旧港", body: "旧程序不得改动的合成原稿𠮷。" },
  ]),
  character = await store.materials.save(book.id, {
    kind: "character",
    title: "合成人物",
    status: "planned",
    fields: { appearance: "蓝衣" },
    notes: "旧设定",
    chapterIds: [],
  }),
  made = await store.imageTasks.create(book.id, {
    id: randomUUID(),
    request: {
      prompt: "合成图像保护验收",
      n: 1,
      size: "1024x1024",
      responseMode: "default-base64",
    },
    budget: { maxImages: 1, maxCost: 0, pricing: null },
    profile: {
      id: randomUUID(),
      label: "合成配置，无网络",
      model: "synthetic-image",
      protocol: "openai-images",
      revision: 1,
      diskHash: "a".repeat(64),
    },
    target: {
      purpose: "portrait",
      material: expected(character),
      chapter: null,
    },
  }),
  sent = await store.imageTasks.markSending(book.id, expected(made)),
  image = await sharp({
    create: { width: 32, height: 48, channels: 3, background: "#247e9a" },
  })
    .png()
    .toBuffer(),
  received = await store.imageTasks.receive(
    book.id,
    expected(sent),
    sent.attemptId,
    {
      candidates: [{ bytes: image }],
      usage: null,
      interruptedAfterResponse: false,
    },
  );
await store.materials.save(
  book.id,
  { ...character, fields: { appearance: "旅行斗篷" } },
  character,
);
const comparison = await store.imageTasks.compareTarget(
    book.id,
    expected(received),
    0,
  ),
  adopted = await store.imageTasks.adoptReviewed(
    book.id,
    expected(received),
    0,
    {
      title: "合成复评候选",
      purpose: "portrait",
      source: "自行合成",
      rights: "合成测试",
      notes: "",
      linkedIds: [character.id],
    },
    {
      target: comparison.current,
      responseHash: received.responseHash,
      confirmation: "adopt-for-current-target-v1",
    },
  ),
  taskPath = join(
    data,
    "library",
    book.id,
    ".zinovel/image-tasks",
    made.id + ".json",
  ),
  bodyPath = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  assetPath = join(
    data,
    "library",
    book.id,
    "assets/items",
    adopted.asset.id + ".json",
  ),
  before = await Promise.all(
    [taskPath, bodyPath, assetPath].map((path) => readFile(path)),
  ),
  report = {
    status: "running",
    version: JSON.parse(await readFile(join(root, "package.json"), "utf8"))
      .version,
    previousVersion: manifest.version,
    previousAsarSha256,
    checks: [],
    errors: [],
    scope:
      "Actual retained local alpha.31 packaged EXE opens synthetic v2 task created by current production storage; no installer, downgrade support, provider or native IME qualification",
  };
let app, page, owned;
try {
  const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: data,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("Unexpected renderer request");
  });
  assert.deepEqual(
    await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
    })),
    { version: manifest.version, packaged: true },
  );
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  await page.getByRole("button", { name: "AI 图像", exact: true }).click();
  const panel = page.getByRole("dialog", {
    name: "AI 图像工作室",
    exact: true,
  });
  await panel
    .getByRole("alert")
    .filter({ hasText: "部分历史任务不能读取，原文件已保留" })
    .waitFor();
  const list = await page.evaluate(
    (bookId) => window.novel.request("image.list", { bookId }),
    book.id,
  );
  assert.equal(list.tasks.length, 0);
  assert.equal(list.errors.length, 1);
  await assert.rejects(
    page.evaluate(
      ({ bookId, id }) => window.novel.request("image.read", { bookId, id }),
      { bookId: book.id, id: made.id },
    ),
    /版本、状态或所属作品无效/,
  );
  await page.screenshot({ path: join(out, "old-31-preserves-v2.png") });
  await app.close();
  app = null;
  await confirmOwnedProcessesExited(owned);
  owned = null;
  const after = await Promise.all(
    [taskPath, bodyPath, assetPath].map((path) => readFile(path)),
  );
  after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
  const again = await store.imageTasks.read(book.id, made.id);
  assert.equal(again.schemaVersion, 2);
  assert.deepEqual(
    again.candidates[0].adoption.targetReview,
    adopted.task.candidates[0].adoption.targetReview,
  );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Actual old alpha.31 packaged UI refuses the v2 task and reports unreadable history; no automatic rewrite, discard or replay",
    "After old UI exits, exact task/manuscript/asset bytes remain unchanged and current storage reads the original reviewed adoption receipt",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (owned) await terminateOwnedProcesses(owned);
  await writeFile(
    join(out, "compatibility.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
