import { _electron as electron } from "playwright";
import electronPath from "electron";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import { waitForCondition } from "./windows-installer-observation.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "reference-images-ui-")),
  out = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-006",
    "reference-images",
  );
await mkdir(out, { recursive: true });
const store = new NovelStore(join(data, "library")),
  body = "参考图操作不得修改原稿𠮷🙂。";
const book = await store.importBook("参考编辑合成验收", [
  { title: "旧港", body },
]);
const character = await store.materials.save(book.id, {
  title: "合成人物",
  kind: "character",
  status: "planned",
  fields: {},
  notes: "保持人物的原有文字设定",
  chapterIds: [],
});
const original = await sharp({
  create: { width: 180, height: 280, channels: 3, background: "#366c8a" },
})
  .jpeg()
  .withMetadata({ exif: { IFD0: { Artist: "PRIVATE_REFERENCE_ARTIST" } } })
  .toBuffer();
const assetInput = {
  title: "人物参考原图",
  purpose: "portrait",
  source: "自行合成",
  rights: "验收",
  notes: "原件不得覆盖",
  linkedIds: [character.id],
};
const asset = await store.assets.import(book.id, original, assetInput);
const output = await sharp({
  create: { width: 180, height: 280, channels: 3, background: "#537b64" },
})
  .png()
  .toBuffer();
const observations = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, "/v1/images/edits");
    assert.equal(req.headers.authorization, "Bearer synthetic-edit-ui-key");
    assert.equal(request.images.length, 1);
    const png = Buffer.from(
      request.images[0].image_url.split(",")[1],
      "base64",
    );
    assert.equal(png.includes(Buffer.from("PRIVATE_REFERENCE_ARTIST")), false);
    observations.push({
      url: req.url,
      referenceSha256: binaryHash(png),
      selectedKey: true,
    });
    if (request.prompt.includes("强制中断")) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: [{ b64_json: output.toString("base64") }] }),
    );
  } catch {
    res.writeHead(500);
    res.end("Synthetic fixture failed");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:/Windows", "System32");
}
const report = {
  status: "running",
  checks: [],
  errors: [],
  browser: "Browser plugin unavailable; repository Playwright/Electron",
  scope:
    "Actual host/UI and controlled HTTP for pinned reference preparation, preview, one send, adoption, stale reference refusal and restart. Synthetic pictures/keys; no actual provider, visual consistency, native IME or installation qualification.",
};
let app, page, owned;
const expected = (v) => ({
    id: v.id,
    revision: v.revision,
    diskHash: v.diskHash,
  }),
  baseline = (v) => ({ revision: v.revision, diskHash: v.diskHash });
const request = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const panel = () =>
  page.getByRole("dialog", { name: "AI 图像工作室", exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("request", (e) => {
    if (/^https?:/.test(e.url()))
      report.errors.push("Unexpected renderer HTTP");
  });
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = binaryHash(await readFile(runtime.path));
  else {
    report.desktopBundleSha256 = binaryHash(
      await readFile(join(root, "dist/desktop/main.cjs")),
    );
    report.workbench = Object.fromEntries(
      await Promise.all(
        ["app.js", "app.css", "index.html"].map(async (name) => [
          name,
          binaryHash(await readFile(join(root, "dist/workbench", name))),
        ]),
      ),
    );
  }
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
}
async function close() {
  owned = await captureOwnedProcesses(app.process().pid);
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function open() {
  await page.getByRole("button", { name: "AI 图像", exact: true }).click();
  await panel().getByLabel("图像提示词", { exact: true }).waitFor();
}
async function prepare(prompt) {
  await panel().getByLabel("图像提示词", { exact: true }).fill(prompt);
  await panel()
    .getByRole("button", { name: "准备图像任务（不发送）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "任务已保存，尚未发送" })
    .waitFor();
  await panel()
    .getByRole("img", { name: "本次固定参考图", exact: true })
    .waitFor();
  const list = await request("image.list", { bookId: book.id });
  return request("image.read", { bookId: book.id, id: list.tasks[0].id });
}
async function send() {
  await panel()
    .getByLabel(
      "我确认提示词、参考图、用途、目标服务与参考输入费用，明确发送一次",
      { exact: true },
    )
    .check();
  await panel()
    .getByRole("button", { name: "确认发送图像请求", exact: true })
    .click();
}
async function screenshot(name) {
  const referenceImage = panel().getByRole("img", {
    name: "本次固定参考图",
    exact: true,
  });
  await referenceImage.scrollIntoViewIfNeeded();
  await referenceImage.evaluate(async (image) => {
    await image.decode();
    if (!image.complete || !image.naturalWidth)
      throw new Error("Reference preview has not decoded");
  });
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(geometry.scroll <= geometry.width + 1);
  const bounds = await referenceImage.boundingBox();
  assert.ok(
    bounds && bounds.y >= 0 && bounds.y + bounds.height <= geometry.height,
  );
  report.viewports = [
    ...(report.viewports || []),
    { name, ...geometry, referenceBounds: bounds },
  ];
  await page.screenshot({ path: join(out, name) });
}
try {
  await launch();
  await request("settings.save", {
    baseURL: "http://127.0.0.1:9/v1",
    model: "synthetic-text-unused",
    apiKey: "synthetic-unused-text-key",
  });
  let view = await request("profiles.list");
  view = await request("profiles.migrate", { legacyToken: view.legacyToken });
  view = await request("profiles.add", {
    expected: baseline(view),
    input: {
      label: "参考图编辑专用",
      protocol: "openai-images-edits",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      model: "synthetic-edit-ui",
      apiKey: "synthetic-edit-ui-key",
      imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
      imageOptions: { responseMode: "default-base64" },
    },
  });
  const profile = view.profiles.find(
    (p) => p.protocol === "openai-images-edits",
  );
  await request("profiles.select", {
    capability: "image",
    id: profile.id,
    expected: baseline(view),
  });
  await open();
  await panel()
    .getByLabel("图像用途", { exact: true })
    .selectOption("portrait");
  await panel()
    .getByLabel("目标人物", { exact: true })
    .selectOption(character.id);
  await panel()
    .getByLabel("参考图资源", { exact: true })
    .selectOption(`${asset.id}/${asset.diskHash}`);
  const prepared = await prepare("保留参考人物轮廓，改为冬季衣装。");
  assert.equal(prepared.schemaVersion, 3);
  assert.equal(observations.length, 0);
  assert.equal((await request("assets.list", { bookId: book.id })).total, 1);
  assert.equal(
    await panel()
      .getByRole("button", { name: "确认发送图像请求", exact: true })
      .isEnabled(),
    false,
  );
  const preview = await panel()
    .getByRole("img", { name: "本次固定参考图", exact: true })
    .getAttribute("src");
  assert.equal(
    binaryHash(Buffer.from(preview.split(",")[1], "base64")),
    prepared.reference.derivative.sha256,
  );
  await screenshot("reference-before-send-light.png");
  report.checks.push(
    "Actual author UI chooses a fixed same-book asset and character; preparation persists schema3 and exact preview without HTTP, canonical asset creation or manuscript change",
  );
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "候选待审阅" })
    .waitFor();
  assert.equal(observations.length, 1);
  assert.equal(
    observations[0].referenceSha256,
    prepared.reference.derivative.sha256,
  );
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("冬装候选·明确采用");
  await panel().getByLabel("权利与使用范围", { exact: true }).fill("合成验收");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "候选已新增到图像资源库" })
    .waitFor();
  const adopted = await request("image.read", {
    bookId: book.id,
    id: prepared.id,
  });
  assert.equal(adopted.schemaVersion, 3);
  assert.equal(adopted.candidates[0].decision, "accepted");
  assert.deepEqual(adopted.reference, prepared.reference);
  report.checks.push(
    "One explicit DPAPI-resolved edit key calls only /images/edits with the frozen metadata-free PNG; explicit candidate adoption adds a new portrait and preserves original/reference/character/manuscript",
  );
  await close();
  await launch();
  await open();
  const cached = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    `zinovel-image-studio/${book.id}`,
  );
  assert.equal(cached.schemaVersion, 2);
  assert.deepEqual(cached.reference, expected(asset));
  await panel().locator(`[data-task-id="${prepared.id}"]`).click();
  await panel()
    .getByRole("img", { name: "本次固定参考图", exact: true })
    .waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("zinovel-theme", "dark");
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(806, 803),
  );
  await screenshot("reference-restarted-dark.png");
  assert.equal(observations.length, 1);
  report.checks.push(
    "Full restart retains the exact schema2 reference draft, schema3 adopted receipt and frozen reference preview; dark narrow view remains reachable with no automatic HTTP replay",
  );
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await open();
  const stale = await prepare("原参考版本已确认，准备后修改资源。");
  await request("assets.save", {
    bookId: book.id,
    input: { ...assetInput, notes: "作者在别处更新了参考资源说明" },
    expected: expected(asset),
  });
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "请求未完成" })
    .waitFor();
  const failed = await request("image.read", { bookId: book.id, id: stale.id });
  assert.equal(failed.outcome.dispatched, false);
  assert.equal(observations.length, 1);
  await screenshot("reference-stale-refused-dark.png");
  report.checks.push(
    "A real host asset edit after preparation causes the old reference task to fail before dispatch; frozen preview and reference draft remain, with no new request or automatic asset rebinding",
  );
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await open();
  const latest = await request("assets.read", {
    bookId: book.id,
    id: asset.id,
  });
  await panel()
    .getByLabel("参考图资源", { exact: true })
    .selectOption(`${latest.id}/${latest.diskHash}`);
  const interrupted = await prepare("参考编辑发出后强制中断，重启不得重发。");
  await send();
  await waitForCondition(
    async () => observations.length === 2,
    "Controlled reference edit dispatch not observed",
  );
  const taskPath = join(
    data,
    "library",
    book.id,
    ".zinovel/image-tasks",
    interrupted.id + ".json",
  );
  const beforeKill = await readFile(taskPath),
    durable = JSON.parse(beforeKill);
  assert.equal(durable.schemaVersion, 3);
  assert.equal(durable.status, "send-intent");
  const killed = await captureOwnedProcesses(app.process().pid);
  await terminateOwnedProcesses(killed);
  await confirmOwnedProcessesExited(killed);
  app = null;
  owned = null;
  server.closeAllConnections();
  await launch();
  await open();
  await panel().locator(`[data-task-id="${interrupted.id}"]`).click();
  await panel().getByText("远端结果未知。", { exact: false }).waitFor();
  await panel()
    .getByRole("img", { name: "本次固定参考图", exact: true })
    .waitFor();
  const recovered = await request("image.read", {
    bookId: book.id,
    id: interrupted.id,
  });
  assert.equal(recovered.status, "remote-unknown");
  assert.deepEqual(recovered.reference, interrupted.reference);
  assert.deepEqual(await readFile(taskPath), beforeKill);
  assert.equal(observations.length, 2);
  await screenshot("reference-forced-exit-unknown.png");
  report.forcedEditRestart = true;
  report.checks.push(
    "After actual HTTP edit dispatch and durable schema3 intent, the owned desktop process tree is forcibly terminated; restart preserves exact task/reference bytes, displays remote-unknown and never replays the request",
  );
  const originalPath = join(
    data,
    "library",
    book.id,
    "assets/blobs",
    asset.blob.sha256 + ".jpeg",
  );
  assert.deepEqual(await readFile(originalPath), original);
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    body,
  );
  assert.equal(
    (await request("materials.read", { bookId: book.id, id: character.id }))
      .diskHash,
    character.diskHash,
  );
  assert.deepEqual(report.errors, []);
  report.requests = observations.length;
  report.referenceSha256 = prepared.reference.derivative.sha256;
  report.originalsPreserved = true;
  if (process.env.ZINOVEL_REFERENCE_UPGRADE_EXPORT === "1") {
    assert.equal(report.packaged, true);
    assert.equal(report.version, "0.1.0-alpha.40");
    report.upgradeState = {
      data,
      bookId: book.id,
      chapterId: book.chapters[0].id,
      adoptedTaskId: prepared.id,
      unknownTaskId: interrupted.id,
      draftKey: `zinovel-image-studio/${book.id}`,
      draftValue: await page.evaluate(
        (key) => localStorage.getItem(key),
        `zinovel-image-studio/${book.id}`,
      ),
      modelPort: server.address().port,
    };
  }
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw e;
} finally {
  if (app) {
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else await close();
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    join(out, "reference-images-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
