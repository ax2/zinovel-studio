import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  data = await mkdtemp(join(root, ".cache", "offline-writing-"));
const fixture = new NovelStore(join(data, "library"));
const bookA = await fixture.importBook("离线合成作品甲", [
    { title: "旧信", body: "甲书冻结原文𠮷🌊。" },
  ]),
  bookB = await fixture.importBook("离线合成作品乙", [
    { title: "独立章节", body: "BOOK_B_PRIVATE_SENTINEL。乙书独立原文。" },
  ]);
await fixture.materials.save(bookB.id, {
  kind: "proposition",
  title: "乙书私有命题",
  notes: "BOOK_B_MATERIAL_SENTINEL",
  status: "planned",
  fields: { claim: "乙书私有因果", truthIntent: "作者设定为真" },
  chapterIds: [],
});
let release, firstRequest;
const gate = new Promise((resolve) => {
    release = resolve;
  }),
  received = new Promise((resolve) => {
    firstRequest = resolve;
  });
let modelRequests = 0,
  foreignTextSent = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      response.writeHead(413);
      response.end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  modelRequests++;
  foreignTextSent ||= /BOOK_B_PRIVATE_SENTINEL|BOOK_B_MATERIAL_SENTINEL/.test(
    body,
  );
  firstRequest();
  await gate;
  response.writeHead(503, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: "Synthetic provider is unavailable",
      },
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/anthropic`;
const output = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-008",
  "offline-writing",
);
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Chromium HTTP(S) is denied after attachment/reload; a controlled loopback provider fails with HTTP503. This is model unavailability and local-write independence, not an OS-wide airplane-mode or real-model literary-quality claim",
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
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    env,
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    timeout: 45000,
  });
  report.launchPid = app.process().pid;
  owned = await captureOwnedProcesses(app.process().pid);
  await app.evaluate(async ({ app, session }) => {
    await app.whenReady();
    globalThis.offlineRendererRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => {
        globalThis.offlineRendererRequests++;
        callback({ cancel: true });
      },
    );
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 900 });
  });
  // firstWindow can attach while the initial file navigation is still replacing its context.
  await page.locator(".book-card").first().waitFor();
  report.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
  }));
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.locator(".book-card").first().waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".book-card").first().waitFor();
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("https://zinovel-offline-probe.invalid/denied");
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "Renderer networking must actually be denied",
  );
  assert.equal(
    await app.evaluate(async ({ session }) => {
      try {
        await session.defaultSession.fetch(
          "https://zinovel-offline-probe.invalid/denied",
        );
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "Chromium session interceptor must actually deny a request",
  );
  assert.equal(await app.evaluate(() => globalThis.offlineRendererRequests), 1);
  owned = await captureOwnedProcesses(app.process().pid);
}
async function open(book) {
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (
    !(await page
      .getByRole("button", { name: "生成候选", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
}
async function save(book, addition) {
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText(addition);
  await editor.press("Control+s");
  const deadline = Date.now() + 10000;
  while (
    !(
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body.endsWith(addition)
  ) {
    assert.ok(Date.now() < deadline, "Manual save did not settle");
    await page.waitForTimeout(30);
  }
}
async function close() {
  for (const [pid, identity] of await captureOwnedProcesses(app.process().pid))
    owned.set(pid, identity);
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
try {
  await launch();
  report.version = await app.evaluate(({ app }) => app.getVersion());
  await open(bookA);
  const first = "\n没有模型也能手写并保存𠮷🌊。";
  await save(bookA, first);
  await request("settings.save", {
    baseURL,
    model: "deepseek-v4-flash",
    apiKey: "synthetic-offline-only-not-a-real-key",
    budget: { maxSteps: 1, maxOutputTokens: 64 },
  });
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  await Promise.race([
    received,
    new Promise((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Official Harness did not reach the controlled unavailable provider",
            ),
          ),
        45000,
      ).unref(),
    ),
  ]);
  const during = "\n模型等待期间作者继续写𠮷🌊。";
  await save(bookA, during);
  await page.getByTitle("书库", { exact: true }).click();
  await open(bookB);
  const other = "\n乙书手写保持独立。";
  await save(bookB, other);
  release();
  const deadline = Date.now() + 10000;
  let task;
  while (Date.now() < deadline) {
    task = (await request("ai.tasks", { bookId: bookA.id }))[0];
    if (task?.status === "cancelled") break;
    await page.waitForTimeout(100);
  }
  assert.equal(task?.status, "cancelled");
  report.switchedTaskStatus = task.status;
  await page.getByTitle("书库", { exact: true }).click();
  await open(bookA);
  const retryEditor = page.getByLabel("正文编辑器");
  await retryEditor.click();
  await retryEditor.press("Control+Home");
  await retryEditor.press("Shift+End");
  await page.getByRole("button", { name: "生成候选", exact: true }).click();
  const failureDeadline = Date.now() + 60000;
  while (Date.now() < failureDeadline) {
    task = (await request("ai.tasks", { bookId: bookA.id }))[0];
    if (task?.status === "failed") break;
    await page.waitForTimeout(100);
  }
  assert.equal(task?.status, "failed");
  await page.getByTitle("书库", { exact: true }).click();
  await open(bookB);
  assert.equal(foreignTextSent, false);
  assert.ok(modelRequests >= 1);
  assert.deepEqual(await request("ai.tasks", { bookId: bookB.id }), []);
  const textA = "甲书冻结原文𠮷🌊。" + first + during,
    textB = "BOOK_B_PRIVATE_SENTINEL。乙书独立原文。" + other;
  assert.equal(
    (
      await request("chapter.read", {
        bookId: bookA.id,
        chapterId: bookA.chapters[0].id,
      })
    ).body,
    textA,
  );
  assert.equal(
    (
      await request("chapter.read", {
        bookId: bookB.id,
        chapterId: bookB.chapters[0].id,
      })
    ).body,
    textB,
  );
  assert.ok(
    (await page.getByLabel("正文编辑器").innerText()).includes(
      "乙书手写保持独立。",
    ),
  );
  await page.screenshot({
    path: join(output, "other-book-after-provider-failure.png"),
  });
  const beforeRestartRequests = modelRequests;
  await close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await launch();
  await open(bookA);
  assert.ok(
    (await page.getByLabel("正文编辑器").innerText()).includes(
      "模型等待期间作者继续写𠮷🌊。",
    ),
  );
  const after = "\n服务已关闭仍可保存。";
  await save(bookA, after);
  await page.getByRole("button", { name: "阅读预览", exact: true }).click();
  const reader = page.getByRole("dialog", { name: /阅读/ });
  await reader.waitFor();
  assert.ok((await reader.innerText()).includes("服务已关闭仍可保存。"));
  report.readingLayout = await reader.evaluate((dialog) => {
    const bounds = (node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    return {
      dialog: bounds(dialog),
      paragraph: bounds(dialog.querySelector(".reader-sheet p")),
      layout: bounds(dialog.querySelector(".reader-layout")),
      horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  const geometry = report.readingLayout;
  assert.equal(
    geometry.horizontalOverflow,
    false,
    "Reading dialog must not create implicit overflowing columns",
  );
  assert.ok(
    geometry.layout.height > 100,
    "Reading body must have usable height",
  );
  assert.ok(
    geometry.paragraph.width >= 200,
    "Reading text must have a usable line width, not a zero-width offscreen column",
  );
  assert.ok(
    geometry.paragraph.left >= 0 &&
      geometry.paragraph.right <= geometry.viewport.width &&
      geometry.paragraph.top >= 0 &&
      geometry.paragraph.bottom <= geometry.viewport.height,
    "Reading text must actually be visible after entering from a narrow assistant drawer",
  );
  await page.screenshot({
    path: join(output, "offline-reading-after-restart.png"),
  });
  assert.equal(modelRequests, beforeRestartRequests);
  assert.deepEqual(report.errors, []);
  report.providerRequests = modelRequests;
  report.failedTaskStatus = task.status;
  report.foreignBookTextSent = foreignTextSent;
  report.rendererRequestsDenied = await app.evaluate(
    () => globalThis.offlineRendererRequests,
  );
  report.checks.push(
    "renderer fetch is denied by CSP and an independent session fetch proves Chromium HTTP interception; actual author writes/saves without a model and while the official Harness waits for a controlled failing provider",
    "switching to another book cancels the pending original task and permits independent manual writing; default model payload contains no other-book manuscript/material markers and task history stays bound to the originating book",
    "provider503 leaves a failed task, never applies a candidate or rewrites either manuscript; both books retain exact author additions",
    "after full application restart and loopback provider shutdown, manual save and visibly readable narrow preview remain usable without horizontal overflow, additional provider requests or page errors",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(output, "offline-writing-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  release();
  if (app) {
    if (report.status === "failed") {
      try {
        for (const [pid, identity] of await captureOwnedProcesses(
          app.process().pid,
        ))
          owned.set(pid, identity);
      } catch {}
      if (owned) await terminateOwnedProcesses(owned);
      else await app.close();
    } else await close();
  }
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await writeFile(
    join(output, "offline-writing-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
