import { _electron as electron, chromium } from "playwright";
import electronPath from "electron";
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, relative, isAbsolute } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  WINDOWS_CREDENTIAL_PREFIX,
  windowsCredentialAvailable,
  protectWindowsCredential,
  unprotectWindowsCredential,
} from "../packages/novel-storage/windows-credentials.mjs";
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
            data: Array.from({ length: value.n }, (_, n) =>
              value.prompt.includes("整批坏图") ||
              (value.prompt.includes("混合坏图") && n === 1)
                ? {
                    b64_json: "not base64",
                    private_error: "synthetic private pixel failure",
                  }
                : {
                    b64_json: (value.prompt.includes("补存")
                      ? rescue
                      : pictures[n % pictures.length]
                    ).toString("base64"),
                    revised_prompt: `自行合成候选 ${n + 1}；只作说明`,
                  },
            ),
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
    "Synthetic prompts/manuscript/keys/images; actual host IPC, Windows CurrentUser DPAPI, HTTP, decode/storage/adoption, process restart and renderer-only crash. Native recovery choice instrumented; fresh CDP observes the original app-reopened window without extra reload. No real provider, literary/visual quality or native IME certification; installer lifecycle is verified separately by its suite.",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned, recoveryObserver;
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
async function credentialProbe() {
  const profiles = JSON.parse(
      await readFile(join(data, "model-profiles.json"), "utf8"),
    ),
    cipher = profiles.profiles.find(
      (item) => item.label === "图像专用B",
    ).encryptedKey;
  if (cipher.startsWith(WINDOWS_CREDENTIAL_PREFIX)) {
    let readable = false,
      roundtrip = false;
    try {
      readable = unprotectWindowsCredential(cipher) === keys[1];
    } catch {}
    try {
      roundtrip =
        unprotectWindowsCredential(
          protectWindowsCredential("synthetic-roundtrip-probe"),
        ) === "synthetic-roundtrip-probe";
    } catch {}
    return {
      provider: "current-user-dpapi",
      available: windowsCredentialAvailable(),
      readable,
      roundtrip,
      fingerprint: null,
    };
  }
  let wrapped;
  try {
    wrapped = JSON.parse(await readFile(join(data, "Local State"), "utf8"))
      ?.os_crypt?.encrypted_key;
  } catch {}
  const state = await app.evaluate(
    ({ safeStorage }, input) => {
      let readable = false,
        roundtrip = false;
      try {
        readable =
          safeStorage.decryptString(Buffer.from(input.cipher, "base64")) ===
          input.expected;
      } catch {}
      try {
        roundtrip =
          safeStorage.decryptString(
            safeStorage.encryptString("synthetic-roundtrip-probe"),
          ) === "synthetic-roundtrip-probe";
      } catch {}
      return {
        available: safeStorage.isEncryptionAvailable(),
        readable,
        roundtrip,
      };
    },
    { cipher, expected: keys[1] },
  );
  return {
    ...state,
    osKeyPresent: typeof wrapped === "string",
    fingerprint:
      typeof wrapped === "string" ? binaryHash(Buffer.from(wrapped)) : null,
  };
}
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
  // Kill only the renderer. Keep the paid bytes and job in the real main process;
  // instrument the native recovery choice, not the recovery implementation.
  const beforeRendererCrash = await app.evaluate(
    ({ BrowserWindow, dialog }) => {
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.__imageRecoveryQA = {
        originalMessageBox: dialog.showMessageBox,
        originalErrorBox: dialog.showErrorBox,
        dialogs: [],
        errors: [],
      };
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        globalThis.__imageRecoveryQA.dialogs.push({
          title: options.title,
          buttons: options.buttons,
          protectsImages: options.detail.includes("当前进程保留其结果"),
        });
        return new Promise((resolve) => {
          globalThis.__imageRecoveryQA.reopen = resolve;
        });
      };
      dialog.showErrorBox = (title) => {
        globalThis.__imageRecoveryQA.errors.push(title);
      };
      return { main: process.pid, renderer: win.webContents.getOSProcessId() };
    },
  );
  const crashedRenderer = page.waitForEvent("crash", { timeout: 45000 });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  await crashedRenderer;
  await app.evaluate(async () => {
    for (let i = 0; i < 1000; i++) {
      if (globalThis.__imageRecoveryQA.reopen) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Renderer recovery did not reach the native choice");
  });
  // Playwright deliberately rejects pending page waits at the crash event.
  // Attach the new-document wait after that event and before choosing reopen.
  const reopenedDocument = page.waitForEvent("domcontentloaded", {
    timeout: 45000,
  });
  await app.evaluate(() =>
    globalThis.__imageRecoveryQA.reopen({
      response: 0,
      checkboxChecked: false,
    }),
  );
  await reopenedDocument;
  // This Playwright version permanently closes the crashed Page's operation
  // scope. Observe the already reopened same window through a fresh CDP client;
  // do not reload it a second time or replace the app's recovery handler.
  const [activePort, activeSocket] = (
    await readFile(join(data, "DevToolsActivePort"), "utf8")
  ).split(/\r?\n/);
  assert.match(activePort, /^\d{1,5}$/);
  assert.match(activeSocket, /^\/devtools\/browser\/[a-f0-9-]+$/i);
  recoveryObserver = await chromium.connectOverCDP(
    `ws://127.0.0.1:${activePort}${activeSocket}`,
  );
  assert.equal(recoveryObserver.contexts().length, 1);
  const recoveredPages = recoveryObserver.contexts()[0].pages();
  assert.equal(recoveredPages.length, 1);
  page = recoveredPages[0];
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (event) => {
    if (["error", "warning"].includes(event.type()))
      report.errors.push(event.text());
  });
  page.on("request", (event) => {
    if (/^https?:/.test(event.url()))
      report.errors.push("Unexpected renderer HTTP request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  const afterRendererCrash = await app.evaluate(({ BrowserWindow, dialog }) => {
    const state = globalThis.__imageRecoveryQA;
    dialog.showMessageBox = state.originalMessageBox;
    dialog.showErrorBox = state.originalErrorBox;
    const result = {
      main: process.pid,
      renderer: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
      windows: BrowserWindow.getAllWindows().length,
      dialogs: state.dialogs,
      errors: state.errors,
    };
    delete globalThis.__imageRecoveryQA;
    return result;
  });
  assert.equal(afterRendererCrash.main, beforeRendererCrash.main);
  assert.notEqual(afterRendererCrash.renderer, beforeRendererCrash.renderer);
  assert.equal(afterRendererCrash.windows, 1);
  assert.deepEqual(afterRendererCrash.errors, []);
  assert.deepEqual(afterRendererCrash.dialogs, [
    {
      title: "写作窗口需要恢复",
      buttons: ["重新打开"],
      protectsImages: true,
    },
  ]);
  report.rendererRecoveryObserver =
    "Fresh CDP observation of the app-reopened original window; no extra reload";
  assert.equal((await request("image.status")).localResponseRetained, true);
  assert.equal(calls[1].length, 2);
  await open();
  await panel().locator(`[data-task-id="${paid.id}"]`).click();
  await panel()
    .getByRole("button", { name: "重试本地保存（不重新请求）", exact: true })
    .waitFor();
  await screenshot("renderer-recovered-paid-result.png");
  report.rendererRecoveryRetainsPaidResult = true;
  report.checks.push(
    "Actual renderer-only crash changes renderer PID while retaining the same main PID; native recovery offers reopen only for unsaved paid images; reloaded author UI retains the job and local-save action with no extra HTTP request",
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
  const credentialBeforeCrash = await credentialProbe();
  const interruptedHostPid = app.process().pid;
  owned = await captureOwnedProcesses(interruptedHostPid);
  const terminatedImageHost = await terminateOwnedProcesses(owned);
  assert.equal(
    terminatedImageHost.find((item) => item.pid === interruptedHostPid)?.status,
    "terminated",
  );
  app = null;
  owned = null;
  hold = false;
  await launch();
  const credentialAfterCrash = await credentialProbe();
  report.crashCredentialProbe = {
    before: { ...credentialBeforeCrash, fingerprint: undefined },
    after: { ...credentialAfterCrash, fingerprint: undefined },
    wrappedKeyChanged:
      credentialBeforeCrash.fingerprint && credentialAfterCrash.fingerprint
        ? credentialBeforeCrash.fingerprint !== credentialAfterCrash.fingerprint
        : null,
  };
  assert.equal(credentialBeforeCrash.provider, "current-user-dpapi");
  assert.equal(credentialBeforeCrash.readable, true);
  assert.equal(credentialAfterCrash.readable, true);
  assert.equal(credentialAfterCrash.roundtrip, true);
  report.crashCredentialsRetained = true;
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

  const mixedTask = await prepare(
    "混合坏图批次：保留原返回1和3，记录第2项无效。",
    3,
  );
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "部分候选可审阅" })
    .waitFor();
  await panel()
    .getByRole("region", { name: "逐项图像结果", exact: true })
    .getByText(/原返回第 2 项/)
    .waitFor();
  await panel().getByLabel("审阅候选", { exact: true }).selectOption("1");
  await panel()
    .getByRole("img", { name: "候选 3 实际原图预览", exact: true })
    .waitFor();
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("混合批次·有效原候选3𠮷");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "候选已新增到图像资源库" })
    .waitFor();
  const mixedSaved = await request("image.read", {
    bookId: book.id,
    id: mixedTask.id,
  });
  assert.deepEqual(
    mixedSaved.candidates.map((item) => item.sourceIndex),
    [0, 2],
  );
  assert.deepEqual(mixedSaved.candidateErrors, [
    { sourceIndex: 1, code: "IMAGE" },
  ]);
  assert.equal(mixedSaved.candidates[1].decision, "accepted");
  assert.equal(
    (
      await request("assets.read", {
        bookId: book.id,
        id: mixedSaved.candidates[1].assetId,
      })
    ).blob.sha256,
    binaryHash(pictures[2]),
  );
  assert.ok(
    !JSON.stringify(mixedSaved).includes("synthetic private pixel failure"),
  );
  await panel()
    .getByRole("region", { name: "逐项图像结果", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("mixed-candidates.png");
  const allInvalidTask = await prepare(
    "整批坏图：已收到响应，不得伪报未知或创建图片。",
    2,
  );
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "响应无可用候选" })
    .waitFor();
  const allInvalidSaved = await request("image.read", {
    bookId: book.id,
    id: allInvalidTask.id,
  });
  assert.equal(allInvalidSaved.status, "received");
  assert.equal(allInvalidSaved.dispatchState, "response-received");
  assert.equal(allInvalidSaved.candidates.length, 0);
  assert.equal(allInvalidSaved.candidateErrors.length, 2);
  assert.equal(
    await panel()
      .getByRole("button", { name: "明确采用当前候选", exact: true })
      .count(),
    0,
  );
  assert.equal(
    (await request("assets.list", { bookId: book.id })).items.length,
    3,
  );
  await screenshot("all-invalid-results.png");

  await panel()
    .getByLabel("图像用途", { exact: true })
    .selectOption("portrait");
  await panel()
    .getByLabel("目标人物", { exact: true })
    .selectOption(material.id);
  const stalePortrait = await prepare(
    "合成人物定妆：返回后修改资料必须拒绝旧采用。",
  );
  assert.equal(stalePortrait.target.material.id, material.id);
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "候选待审阅" })
    .waitFor();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  let changedMaterial = await request("materials.save", {
    bookId: book.id,
    expected: expected(material),
    input: {
      title: material.title,
      kind: "character",
      status: "planned",
      fields: {},
      notes: "作者通过宿主明确修改目标；旧候选须重新核对",
      chapterIds: [],
    },
  });
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("人物定妆·冲突说明不丢失");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "图像目标资料已改变" })
    .waitFor();
  assert.equal(
    await panel().getByLabel("采用后的图像标题", { exact: true }).inputValue(),
    "人物定妆·冲突说明不丢失",
  );
  assert.equal(
    (await request("assets.list", { bookId: book.id })).items.length,
    3,
  );
  const stalePortraitPath = join(
      data,
      "library",
      book.id,
      ".zinovel/image-tasks",
      stalePortrait.id + ".json",
    ),
    portraitBeforeReview = await readFile(stalePortraitPath),
    reviewRegion = () =>
      panel().getByRole("region", { name: "目标版本复评", exact: true }),
    reviewButton = () =>
      panel().getByRole("button", {
        name: "确认按当前目标采用（不重新生成）",
        exact: true,
      }),
    reviewCheckbox = () =>
      panel().getByLabel(
        "我已核对画面与当前目标，确认将旧候选关联当前版本（不重新生成）",
        { exact: true },
      );
  await assert.rejects(
    request("image.compare-target", {
      bookId: book.id,
      expected: expected(stalePortrait),
      index: 0,
      apiKey: "synthetic-rejected",
    }),
    /额外字段/,
  );
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await reviewRegion()
    .getByText("原生成目标与当前目标", { exact: true })
    .waitFor();
  assert.equal(await reviewButton().isDisabled(), true);
  assert.equal(calls[1].length, 7);
  assert.deepEqual(await readFile(stalePortraitPath), portraitBeforeReview);
  await panel()
    .getByRole("button", { name: "取消本次复评", exact: true })
    .click();
  assert.equal(await reviewRegion().count(), 0);
  assert.equal(
    await panel().getByLabel("采用后的图像标题", { exact: true }).inputValue(),
    "人物定妆·冲突说明不丢失",
  );
  assert.deepEqual(await readFile(stalePortraitPath), portraitBeforeReview);
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await reviewRegion().waitFor();
  changedMaterial = await request("materials.save", {
    bookId: book.id,
    expected: expected(changedMaterial),
    input: {
      title: material.title,
      kind: "character",
      status: "planned",
      fields: { appearance: "旅行斗篷𠮷🌊" },
      notes: "作者在复评后再次修改；必须重读当前版本",
      chapterIds: [],
    },
  });
  await reviewCheckbox().check();
  await reviewButton().click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "目标再次改变" })
    .waitFor();
  assert.equal(await reviewCheckbox().isChecked(), false);
  assert.deepEqual(await readFile(stalePortraitPath), portraitBeforeReview);
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await open();
  await panel().locator(`[data-task-id="${stalePortrait.id}"]`).click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  assert.equal(await reviewRegion().count(), 0);
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await reviewRegion().getByText("旅行斗篷𠮷🌊", { exact: true }).waitFor();
  assert.equal(await reviewCheckbox().isChecked(), false);
  await reviewCheckbox().check();
  await reviewRegion().scrollIntoViewIfNeeded();
  await screenshot("portrait-target-review.png");
  await reviewButton().click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已有候选已按明确复评的当前目标采用" })
    .waitFor();
  const reviewedPortrait = await request("image.read", {
    bookId: book.id,
    id: stalePortrait.id,
  });
  assert.equal(reviewedPortrait.schemaVersion, 2);
  const originalPortraitReceipt = JSON.parse(
    portraitBeforeReview.toString("utf8"),
  );
  assert.equal(
    reviewedPortrait.responseHash,
    originalPortraitReceipt.responseHash,
  );
  assert.equal(
    reviewedPortrait.candidates[0].assetId,
    originalPortraitReceipt.candidates[0].assetId,
  );
  assert.deepEqual(
    reviewedPortrait.candidates[0].blob,
    originalPortraitReceipt.candidates[0].blob,
  );
  assert.deepEqual(reviewedPortrait.target, stalePortrait.target);
  assert.equal(
    reviewedPortrait.candidates[0].adoption.targetReview.target.material
      .revision,
    changedMaterial.revision,
  );
  assert.equal(calls[1].length, 7);
  report.reviewedTargetAdoption = true;
  report.checks.push(
    "Author comparison and cancellation do not write task or call a service; extra IPC fields refuse; target changing after comparison refuses and unchecks confirmation while retaining input; reopening drops confirmation; explicit refreshed portrait review adopts existing bytes with a versioned receipt and no HTTP call",
  );
  const freshPortrait = await prepare(
    "合成人物定妆：作者明确选择当前人物修订。",
  );
  assert.equal(
    freshPortrait.target.material.revision,
    changedMaterial.revision,
  );
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "候选待审阅" })
    .waitFor();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("人物定妆·当前版本明确采用");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "候选已新增到图像资源库" })
    .waitFor();
  const portraitSaved = await request("image.read", {
      bookId: book.id,
      id: freshPortrait.id,
    }),
    portraitAsset = await request("assets.read", {
      bookId: book.id,
      id: portraitSaved.candidates[0].assetId,
    });
  assert.equal(portraitAsset.purpose, "portrait");
  assert.deepEqual(portraitAsset.linkedIds, [material.id]);
  report.characterTargetVersionChecked = true;
  report.checks.push(
    "Actual portrait selection freezes character identity/hash; a later host material edit refuses old adoption without losing input or paid candidates; a separately prepared current revision can be explicitly adopted with the exact character link",
  );

  await panel()
    .getByLabel("图像用途", { exact: true })
    .selectOption("illustration");
  await panel()
    .getByLabel("目标章节", { exact: true })
    .selectOption(book.chapters[0].id);
  const staleChapter = await prepare("合成章节插图：准备后正文外改不能发送。");
  const manuscriptPath = join(
      data,
      "library",
      book.id,
      "manuscript",
      book.chapters[0].id + ".md",
    ),
    originalBody = await readFile(manuscriptPath),
    externalBody = Buffer.concat([
      originalBody,
      Buffer.from("\n合成外部修改必须保留"),
    ]);
  await writeFile(manuscriptPath, externalBody);
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "请求未完成" })
    .waitFor();
  const blockedChapter = await request("image.read", {
    bookId: book.id,
    id: staleChapter.id,
  });
  assert.equal(blockedChapter.outcome.dispatched, false);
  assert.equal(blockedChapter.outcome.code, "INTENT");
  assert.equal(calls[1].length, 8);
  assert.deepEqual(await readFile(manuscriptPath), externalBody);
  await writeFile(manuscriptPath, originalBody); // Explicit repair of this fixture's external edit.
  const freshChapter = await prepare("合成章节插图：当前原稿版本明确确认。");
  assert.equal(freshChapter.target.chapter.diskHash, binaryHash(originalBody));
  await send();
  await panel()
    .locator(".image-review h3")
    .filter({ hasText: "候选待审阅" })
    .waitFor();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel()
    .getByLabel("采用后的图像标题", { exact: true })
    .fill("章节港口图·明确采用");
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await reviewRegion()
    .getByRole("status")
    .filter({ hasText: "当前目标与生成时版本一致" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "取消本次复评", exact: true })
    .click();
  const chapterForRename = await request("chapter.read", {
      bookId: book.id,
      chapterId: book.chapters[0].id,
    }),
    renamed = await request("chapter.save", {
      bookId: book.id,
      chapterId: chapterForRename.id,
      expectedRevision: chapterForRename.revision,
      expectedHash: chapterForRename.diskHash,
      title: "港口·复评当前标题",
      body: chapterForRename.body,
    });
  assert.equal(renamed.status, "saved");
  await panel()
    .getByRole("button", { name: "明确采用当前候选", exact: true })
    .click();
  await panel()
    .getByRole("alert")
    .filter({ hasText: "图像目标章节已改变" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  assert.equal(
    await reviewRegion()
      .getByLabel("当前目标正文供核对", { exact: true })
      .inputValue(),
    body,
  );
  await reviewRegion()
    .getByText("港口·复评当前标题", { exact: true })
    .waitFor();
  assert.equal(await reviewButton().isDisabled(), true);
  await reviewCheckbox().check();
  await reviewRegion().scrollIntoViewIfNeeded();
  await screenshot("chapter-target-review.png");
  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
  );
  await page.getByTitle("深色主题", { exact: true }).click();
  await open();
  await panel().getByRole("button", { name: "任务记录", exact: true }).click();
  await panel().locator(`[data-task-id="${freshChapter.id}"]`).click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "比较原目标与当前版本", exact: true })
    .click();
  await reviewRegion().waitFor();
  assert.equal(await reviewCheckbox().isChecked(), false);
  await reviewCheckbox().check();
  await reviewRegion()
    .getByLabel("当前目标正文供核对", { exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("chapter-target-review-dark-narrow.png");
  await reviewButton().scrollIntoViewIfNeeded();
  await screenshot("chapter-target-confirm-dark-narrow.png");
  await reviewButton().click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已有候选已按明确复评的当前目标采用" })
    .waitFor();
  const chapterSaved = await request("image.read", {
      bookId: book.id,
      id: freshChapter.id,
    }),
    chapterAsset = await request("assets.read", {
      bookId: book.id,
      id: chapterSaved.candidates[0].assetId,
    });
  assert.equal(chapterSaved.target.chapter.id, book.chapters[0].id);
  assert.equal(chapterAsset.purpose, "illustration");
  assert.equal(
    chapterSaved.candidates[0].adoption.targetReview.target.chapter.revision,
    renamed.chapter.revision,
  );
  assert.equal(
    chapterSaved.target.chapter.revision,
    freshChapter.target.chapter.revision,
  );
  assert.equal(calls[1].length, 9);
  report.reviewedChapterAdoption = true;
  report.reviewedTargetNarrowConfirmation = true;
  report.checks.push(
    "Unchanged chapter comparison permits ordinary adoption; formal author title change preserves manuscript bytes but invalidates old target; actual current title/body review requires explicit confirmation; closing/reopening in dark narrow view resets it and reachable controls adopt existing image with both revisions and zero extra HTTP",
  );
  report.chapterTargetVersionChecked = true;
  report.checks.push(
    "Actual chapter selection freezes chapter/body version; same-revision external manuscript changes refuse before HTTP while preserving external bytes; explicit synthetic repair permits a new author-confirmed task and later local adoption through an explicit current-target review",
  );

  await panel()
    .getByRole("button", { name: "关闭图像工作室", exact: true })
    .click();
  await page.getByTitle("浅色主题", { exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }),
  );
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
  const mixedAfterRestart = await request("image.read", {
      bookId: book.id,
      id: mixedTask.id,
    }),
    invalidAfterRestart = await request("image.read", {
      bookId: book.id,
      id: allInvalidTask.id,
    });
  assert.equal(mixedAfterRestart.responseHash, mixedSaved.responseHash);
  assert.deepEqual(
    mixedAfterRestart.candidateErrors,
    mixedSaved.candidateErrors,
  );
  assert.deepEqual(
    mixedAfterRestart.candidates.map((item) => [
      item.sourceIndex,
      item.assetId,
      item.decision,
    ]),
    mixedSaved.candidates.map((item) => [
      item.sourceIndex,
      item.assetId,
      item.decision,
    ]),
  );
  assert.equal(invalidAfterRestart.responseHash, allInvalidSaved.responseHash);
  assert.equal(invalidAfterRestart.dispatchState, "response-received");
  assert.equal(calls[1].length, 9);
  for (const original of [reviewedPortrait, chapterSaved]) {
    const reread = await request("image.read", {
      bookId: book.id,
      id: original.id,
    });
    assert.equal(reread.schemaVersion, 2);
    assert.equal(reread.responseHash, original.responseHash);
    assert.deepEqual(
      reread.candidates[0].adoption.targetReview,
      original.candidates[0].adoption.targetReview,
    );
    assert.deepEqual(reread.target, original.target);
  }
  report.mixedBatchRecovery = true;
  report.checks.push(
    "A real mixed HTTP batch preserves valid original positions 1/3 and bounded bad-item 2, previews/adopts original 3 without private errors; all-invalid structured response is known received with no adoptable images; full restart retains hashes, identities/errors/adoption and never reissues either request",
  );
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
  await panel().locator(`[data-task-id="${paid.id}"]`).click();
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
  await panel().locator(`[data-task-id="${paid.id}"]`).click();
  await panel()
    .getByRole("img", { name: "候选 1 实际原图预览", exact: true })
    .waitFor();
  await panel().locator(".image-candidate-preview").scrollIntoViewIfNeeded();
  await screenshot("image-studio-dark-narrow.png");
  assert.deepEqual(
    calls.map((rows) => rows.length),
    [0, 9, 0],
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
  assert.equal(
    (await request("materials.read", { bookId: book.id, id: material.id }))
      .notes,
    changedMaterial.notes,
  );
  assert.deepEqual(report.errors, []);
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).title,
    "港口·复评当前标题",
  );
  report.originalsPreserved = true;
  report.requests = calls.map((rows) => rows.length);
  report.checks.push(
    "Unknown future draft retained through full restart until explicit discard; Chinese/astral prompt persists without generation; narrow history/review reachable, no horizontal overflow/renderer requests/errors; original manuscript/old asset preserved and explicit author material edit retained",
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
    if (recoveryObserver) await recoveryObserver.close().catch(() => {});
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
