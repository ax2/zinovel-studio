import { _electron as electron } from "playwright";
import electronPath from "electron";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, relative, isAbsolute } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "image-studio-")),
  out = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-006",
    "image-studio",
  );
await mkdir(out, { recursive: true });
const store = new NovelStore(join(data, "library")),
  body = "合成原稿𠮷🌊。图像操作不得改动正文。",
  book = await store.importBook("图像工作室合成验收", [
    { title: "港口", body },
  ]);
const pictures = await Promise.all(
  ["png", "jpeg", "webp"].map((format, index) =>
    sharp({
      create: {
        width: 240 + index * 40,
        height: 160 + index * 20,
        channels: 4,
        background: ["#247e9a", "#ba6f4b", "#619747"][index],
      },
    })
      [format]()
      .toBuffer(),
  ),
);
const rescue = await sharp({
  create: { width: 160, height: 220, channels: 4, background: "#b44499" },
})
  .png()
  .toBuffer();
const old = await store.assets.import(book.id, pictures[0], {
  title: "原有封面资源",
  purpose: "cover",
  source: "自行合成",
  rights: "合成验收",
  notes: "不得覆盖",
  linkedIds: [],
});
const material = await store.materials.save(book.id, {
  title: "合成人物",
  kind: "character",
  status: "planned",
  fields: {},
  notes: "合成人物卡",
  chapterIds: [],
});
const keys = [
    "synthetic-text-image-qa",
    "synthetic-image-selected-qa",
    "synthetic-image-unused-qa",
  ],
  calls = [[], [], []];
let hold = false;
const servers = await Promise.all(
  keys.map(async (_key, index) => {
    const server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        calls[index].push({
          selectedKey:
            request.headers.authorization === `Bearer ${keys[index]}`,
          mode: value.response_format || null,
          count: value.n,
        });
        if (hold) return; // An actual dispatched request left pending for cancel/crash checks.
        const current = await readFile(
          join(data, "library", book.id, ".zinovel/pending.json"),
          "utf8",
        );
        assert.equal(current.trim(), "");
        const rows = await import("node:fs/promises").then((fs) =>
          fs.readdir(join(data, "library", book.id, ".zinovel/image-tasks")),
        );
        let sent = false;
        for (const entry of rows) {
          const task = JSON.parse(
            await readFile(
              join(data, "library", book.id, ".zinovel/image-tasks", entry),
              "utf8",
            ),
          );
          if (
            task.request.prompt === value.prompt &&
            task.status === "send-intent"
          )
            sent = true;
        }
        assert.equal(sent, true);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: Array.from({ length: value.n }, (_, n) => ({
              b64_json: (value.prompt.includes("补存")
                ? rescue
                : pictures[n % pictures.length]
              ).toString("base64"),
              revised_prompt: `自行合成候选 ${n + 1}；只作说明`,
            })),
            usage: {
              input_tokens: 7,
              output_tokens: 11,
              private: "not retained",
            },
          }),
        );
      } catch {
        response.writeHead(500);
        response.end("Synthetic fixture assertion failed");
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return server;
  }),
);
const url = (index) => `http://127.0.0.1:${servers[index].address().port}/v1`;
const report = {
  status: "running",
  checks: [],
  errors: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Synthetic prompts/manuscript/keys/images; actual host IPC, Windows safeStorage, HTTP, decode/storage/adoption and process restart. No real provider, literary/visual quality, native IME or installation claim.",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const request = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const panel = () =>
  page.getByRole("dialog", { name: "AI 图像工作室", exact: true });
const baseline = (value) => ({
  revision: value.revision,
  diskHash: value.diskHash,
});
const expected = (value) => ({ id: value.id, ...baseline(value) });
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (event) => {
    if (["error", "warning"].includes(event.type()))
      report.errors.push(event.text());
  });
  page.on("request", (event) => {
    if (/^https?:/.test(event.url()))
      report.errors.push("Unexpected renderer HTTP request");
  });
  await page.waitForURL(/\/workbench\/index\.html$/);
  assert.equal(await page.title(), "ZiNovel Studio");
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  if (report.version) assert.equal(runtime.version, report.version);
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = binaryHash(await readFile(runtime.path));
  else
    report.desktopBundleSha256 = binaryHash(
      await readFile(join(runtime.path, "dist/desktop/main.cjs")),
    );
  if (!runtime.packaged)
    report.workbench = Object.fromEntries(
      await Promise.all(
        ["app.js", "app.css", "index.html"].map(async (file) => [
          file,
          binaryHash(
            await readFile(join(runtime.path, "dist/workbench", file)),
          ),
        ]),
      ),
    );
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
async function prepare(prompt, n = 1) {
  await panel().getByLabel("图像提示词", { exact: true }).fill(prompt);
  await panel().getByLabel("候选数量", { exact: true }).fill(String(n));
  await panel()
    .getByRole("button", { name: "准备图像任务（不发送）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "任务已保存，尚未发送" })
    .waitFor();
  const list = await request("image.list", { bookId: book.id });
  return request("image.read", { bookId: book.id, id: list.tasks[0].id });
}
async function send() {
  await panel()
    .getByLabel("我确认提示词、用途、所选图像服务及可能的费用，明确发送一次")
    .check();
  await panel()
    .getByRole("button", { name: "确认发送图像请求", exact: true })
    .click();
}
async function screenshot(name) {
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    theme:
      document.documentElement.dataset.theme ||
      document.body.dataset.theme ||
      "unknown",
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(geometry.scroll <= geometry.width + 1);
  report.viewports = [...(report.viewports || []), { name, ...geometry }];
  await page.screenshot({ path: join(out, name) });
}
try {
  await launch();
  await request("settings.save", {
    baseURL: url(0),
    model: "synthetic-text",
    apiKey: keys[0],
  });
  let view = await request("profiles.list");
  view = await request("profiles.migrate", { legacyToken: view.legacyToken });
  for (const index of [1, 2]) {
    view = await request("profiles.add", {
      expected: baseline(view),
      input: {
        label: index === 1 ? "图像专用B" : "未选图像C",
        protocol: "openai-images",
        baseURL: url(index),
        model: `synthetic-images-${index}`,
        apiKey: keys[index],
        imageBudget: { maxImages: 3, maxCost: 0, pricing: null },
        ...(index === 1
          ? { imageOptions: { responseMode: "request-base64" } }
          : {}),
      },
    });
  }
  const selected = view.profiles.find((entry) => entry.label === "图像专用B");
  view = await request("profiles.select", {
    capability: "image",
    id: selected.id,
    expected: baseline(view),
  });
  await assert.rejects(
    request("image.settings", { apiKey: "synthetic-forged" }),
    /额外字段/,
  );
  await assert.rejects(
    request("image.prepare", {
      bookId: book.id,
      input: { apiKey: "synthetic-forged" },
    }),
    /字段无效/,
  );
  await open();
  await panel()
    .getByLabel("图像提示词", { exact: true })
    .fill("超出手填数量预算的合成检查");
  await panel().getByLabel("候选数量", { exact: true }).fill("4");
  await panel()
    .getByRole("button", { name: "准备图像任务（不发送）", exact: true })
    .click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "图像数量超过本配置预算" })
    .waitFor();
  assert.equal(calls.flat().length, 0);
  assert.equal(
    await panel().getByLabel("候选数量", { exact: true }).inputValue(),
    "4",
  );
  const first = await prepare("自行合成港口，中文𠮷🌊，三张不同格式候选。", 3);
  assert.equal(calls.flat().length, 0);
  assert.equal(
    await panel()
      .getByRole("button", { name: "确认发送图像请求", exact: true })
      .isEnabled(),
    false,
  );
  await panel()
    .getByText("费用未知：未配置每图单价；未知不代表免费。", { exact: true })
    .waitFor();
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "候选待审阅" })
    .waitFor();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  assert.deepEqual(
    calls.map((rows) => rows.length),
    [0, 1, 0],
  );
  assert.equal(calls[1][0].selectedKey, true);
  assert.equal(calls[1][0].mode, "b64_json");
  let saved = await request("image.read", { bookId: book.id, id: first.id });
  assert.equal(saved.candidates.length, 3);
  assert.deepEqual(
    saved.candidates.map((item) => item.blob.format),
    ["png", "jpeg", "webp"],
  );
  assert.equal(
    (await request("assets.list", { bookId: book.id })).items.length,
    1,
  );
  for (let index = 0; index < 3; index++) {
    await panel()
      .getByLabel("审阅候选", { exact: true })
      .selectOption(String(index));
    await panel()
      .getByRole("img", { name: `候选 ${index + 1} 实际原图预览`, exact: true })
      .waitFor();
    assert.equal(
      saved.candidates[index].blob.sha256,
      binaryHash(pictures[index]),
    );
  }
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("雾港封面·作者采用𠮷🌊");
  await panel()
    .getByLabel("权利与使用范围", { exact: true })
    .fill("自行绘制合成验证；不作真实服务许可声明");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "候选已新增到图像资源库" })
    .waitFor();
  saved = await request("image.read", { bookId: book.id, id: first.id });
  const asset = await request("assets.read", {
    bookId: book.id,
    id: saved.candidates[2].assetId,
  });
  assert.equal(asset.title, "雾港封面·作者采用𠮷🌊");
  assert.equal(asset.blob.sha256, binaryHash(pictures[2]));
  assert.equal(
    (await request("assets.list", { bookId: book.id })).items.length,
    2,
  );
  await screenshot("image-studio-desktop.png");
  report.checks.push(
    "Budget excess creates no request and retains form; explicit prepare sends nothing; one separately DPAPI-resolved image key calls only selected endpoint after unknown-cost confirmation; real PNG/JPEG/WebP decode/hash/preview and explicit adoption preserve existing asset/manuscript",
  );

  // Force a real book-local blob filesystem failure, without a second live writer.
  const blocker = join(
      data,
      "library",
      book.id,
      "assets/blobs",
      binaryHash(rescue) + ".png",
    ),
    retained = blocker + ".synthetic-directory-retained";
  await mkdir(blocker);
  const paid = await prepare("合成补存候选；收到后测试本地原图保存失败。");
  await send();
  await panel()
    .getByRole("status")
    .filter({ hasText: "候选已返回但本地保存未完成" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "重试本地保存（不重新请求）", exact: true })
    .waitFor();
  assert.equal((await request("image.status")).localResponseRetained, true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "图像任务仍在运行或有结果尚未保存" })
    .waitFor();
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await assert.rejects(
    request("image.discard", {
      bookId: book.id,
      expected: expected(
        await request("image.read", { bookId: book.id, id: paid.id }),
      ),
    }),
    /仍保留/,
  );
  for (const path of [blocker, retained]) {
    const rel = relative(resolve(data), resolve(path));
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  }
  await rename(blocker, retained);
  await panel()
    .getByRole("button", { name: "重试本地保存（不重新请求）", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "本地保存完成，没有再次请求" })
    .waitFor();
  assert.equal(calls[1].length, 2);
  assert.equal(await request("image.status"), null);
  report.closeProtected = true;
  report.retainedSaveRecoveredLocally = true;
  const locallySaved = await request("image.read", {
    bookId: book.id,
    id: paid.id,
  });
  assert.equal(locallySaved.status, "received");
  assert.equal(locallySaved.candidates[0].blob.sha256, binaryHash(rescue));
  report.checks.push(
    "Actual filesystem obstruction retains returned paid bytes and receipt; native window close is rejected without renderer error, direct discard bypass refuses; removing only the synthetic obstruction lets UI save locally with no second HTTP request",
  );

  hold = true;
  const cancelled = await prepare("合成等待取消，远端请求已经实际到达。");
  await send();
  await page.waitForFunction(() =>
    document
      .querySelector(".image-job-status")
      ?.textContent?.includes("等待图像服务"),
  );
  await panel()
    .getByRole("button", { name: "取消本地图像等待", exact: true })
    .waitFor();
  const cancelDispatchDeadline = Date.now() + 15000;
  while (calls[1].length < 3 && Date.now() < cancelDispatchDeadline)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(calls[1].length, 3);
  await panel()
    .getByRole("button", { name: "取消本地图像等待", exact: true })
    .click();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "远端结果未知" })
    .waitFor();
  assert.equal(
    (await request("image.read", { bookId: book.id, id: cancelled.id })).outcome
      .dispatched,
    true,
  );
  assert.equal(calls[1].length, 3);
  report.checks.push(
    "Cancellation after actual request dispatch preserves remote-unknown state, does not claim cancellation is free, and does not automatically repeat the request",
  );

  const interrupted = await prepare("合成进程中断，重启不可重发。");
  await send();
  await panel()
    .getByRole("button", { name: "取消本地图像等待", exact: true })
    .waitFor();
  await page.waitForFunction(
    async ({ id, bookId }) =>
      (await window.novel.request("image.read", { id, bookId }))
        .storedStatus === "send-intent",
    { id: interrupted.id, bookId: book.id },
  );
  // Verify the HTTP reached the fixture before abruptly ending only this owned process tree.
  const dispatchDeadline = Date.now() + 15000;
  while (calls[1].length < 4 && Date.now() < dispatchDeadline)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(calls[1].length, 4);
  owned = await captureOwnedProcesses(app.process().pid);
  await terminateOwnedProcesses(owned);
  app = null;
  owned = null;
  hold = false;
  await launch();
  await open();
  await panel()
    .getByRole("button")
    .filter({ hasText: "远端结果未知" })
    .first()
    .click();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "远端结果未知" })
    .waitFor();
  assert.equal(calls[1].length, 4);
  const restarted = await request("image.read", {
    bookId: book.id,
    id: interrupted.id,
  });
  assert.equal(restarted.status, "remote-unknown");
  await assert.rejects(
    request("image.start", {
      bookId: book.id,
      expected: expected(restarted),
      choice: (await request("image.settings")).modelChoice,
    }),
    /未发送请求/,
  );
  assert.equal(calls[1].length, 4);
  report.checks.push(
    "Actual verified owned-process termination after send intent/HTTP restarts to unknown; no automatic generation or resuming old task, and explicit start on the interrupted task refuses",
  );
  report.remoteUnknownAfterRestart = true;

  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  const draftKey = `zinovel-image-studio/${book.id}`,
    future = JSON.stringify({
      schemaVersion: 999,
      synthetic: "未知图像草稿必须保留𠮷",
    });
  await page.evaluate(
    ({ draftKey, future }) => localStorage.setItem(draftKey, future),
    { draftKey, future },
  );
  await close();
  await launch();
  await open();
  await panel()
    .getByRole("button", {
      name: "明确放弃无法识别的本机图像草稿",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await panel()
    .locator(".image-task-list button")
    .filter({ hasText: "候选待审阅" })
    .first()
    .click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  assert.equal(
    await panel().getByLabel("采用后的图像标题", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await panel()
    .getByRole("button", {
      name: "明确放弃无法识别的本机图像草稿",
      exact: true,
    })
    .click();
  await panel()
    .getByLabel("图像提示词", { exact: true })
    .fill("本机草稿中文𠮷🌊保持；不自动发送。");
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await close();
  await launch();
  await open();
  assert.equal(
    await panel().getByLabel("图像提示词", { exact: true }).inputValue(),
    "本机草稿中文𠮷🌊保持；不自动发送。",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
  );
  await screenshot("image-studio-narrow.png");
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await open();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  await panel().getByRole("button", { name: "任务记录", exact: true }).click();
  await panel()
    .locator(".image-task-list button")
    .filter({ hasText: "候选待审阅" })
    .first()
    .click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel().locator(".image-candidate-preview").scrollIntoViewIfNeeded();
  await screenshot("image-studio-dark-narrow.png");
  assert.deepEqual(
    calls.map((rows) => rows.length),
    [0, 4, 0],
  );
  assert.ok(calls[1].every((row) => row.selectedKey));
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    body,
  );
  assert.deepEqual(
    await request("assets.read", { bookId: book.id, id: old.id }),
    old,
  );
  assert.equal(
    (await request("materials.read", { bookId: book.id, id: material.id }))
      .title,
    material.title,
  );
  assert.deepEqual(report.errors, []);
  report.originalsPreserved = true;
  report.requests = calls.map((rows) => rows.length);
  report.checks.push(
    "Unknown future draft retained through full restart until explicit discard; ordinary Chinese/astral prompt persists without generation; desktop/narrow/dark screenshots, no horizontal overflow/renderer external requests/errors, original manuscript/old asset/material unchanged",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else await close();
    }
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    await writeFile(
      join(out, "image-studio-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report);
  }
}
