import { _electron as electron } from "playwright";
import electronPath from "electron";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rmdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "recovery-"));
const store = new NovelStore(join(data, "library")),
  original = "已落盘的合成原稿。";
const book = await store.importBook("故障恢复合成验证", [
  { title: "窗口", body: original },
]);
const chapterId = book.chapters[0].id,
  directory = join(data, "library", book.id);
const pending = join(directory, ".zinovel", "pending.json"),
  held = `${pending}.held`;
const manuscript = join(directory, "manuscript", `${chapterId}.md`);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002", "recovery");
await mkdir(screenshots, { recursive: true });
let application,
  page,
  blocked = false;
const report = { checks: [], status: "running" };
// Playwright 1.56 marks Page permanently crashed. After a real crash/reload,
// inspect the new renderer through Electron's webContents instead of that stale Page.
async function renderer(script) {
  return application.evaluate(
    ({ BrowserWindow }, source) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source),
    script,
  );
}
async function waitRenderer(script) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await renderer(script)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Recovered renderer condition timed out: ${script}`);
}
try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  await page
    .locator(".book-card")
    .filter({ hasText: "故障恢复合成验证" })
    .click();
  await page.getByLabel("正文编辑器").waitFor();
  const settings = await page.evaluate(async () => {
    await Promise.all([
      window.novel.request("settings.save", {
        baseURL: "https://example.com/anthropic",
        model: "fixture-one",
        apiKey: "synthetic-recovery-key",
      }),
      window.novel.request("settings.save", {
        baseURL: "https://example.com/anthropic",
        model: "fixture-two",
      }),
    ]);
    return window.novel.request("settings.get");
  });
  assert.equal(settings.hasKey, true);
  assert.equal(settings.credentialMismatch, false);
  assert.equal(settings.model, "fixture-two");
  assert.equal(
    (await readFile(join(data, "model.json"), "utf8")).includes(
      "synthetic-recovery-key",
    ),
    false,
  );
  assert.deepEqual(Object.keys(settings).sort(), [
    "baseURL",
    "budget",
    "credentialMismatch",
    "encryptionAvailable",
    "hasKey",
    "model",
  ]);
  report.checks.push(
    "concurrent same-service settings updates preserve encrypted key; public settings retain an exact six-field whitelist including a false credentialMismatch flag, with no plaintext or encrypted key returned",
  );

  await rename(pending, held);
  await mkdir(pending);
  blocked = true;
  const draft = "尚未落盘、需要从恢复缓存取回的中文稿件🌊。";
  const editor = page.getByLabel("正文编辑器");
  await editor.fill(draft);
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "保存失败",
  );
  assert.equal(await readFile(manuscript, "utf8"), original);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "关闭前尚有未保存内容" })
    .waitFor();
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await page.screenshot({
    path: join(screenshots, "save-failure-retained.png"),
  });
  await rmdir(pending);
  await rename(held, pending);
  blocked = false;
  // The failed timer has run; no document change retriggers it. Crash the real renderer,
  // then automatically choose the application's recovery dialog, not a fake reload route.
  await application.evaluate(async ({ BrowserWindow, dialog }) => {
    globalThis.recoveryMessages = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.recoveryMessages.push(options.title);
      return { response: 0, checkboxChecked: false };
    };
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    await new Promise((resolve) => {
      contents.once("did-finish-load", () => resolve(true));
      contents.forcefullyCrashRenderer();
    });
  });
  await waitRenderer("!!document.querySelector('.book-card')");
  await renderer("document.querySelector('.book-card').click()");
  await waitRenderer(
    "document.querySelector('[role=status]')?.textContent.includes('已恢复上次未保存')",
  );
  assert.equal(
    await renderer(
      "Array.from(document.querySelectorAll('.cm-line')).map(line => line.textContent).join('\\n')",
    ),
    draft,
  );
  await waitRenderer(
    "document.querySelector('.save-state')?.textContent === '已保存'",
  );
  assert.equal(await readFile(manuscript, "utf8"), draft);
  assert.deepEqual(
    await application.evaluate(() => globalThis.recoveryMessages),
    ["写作窗口需要恢复"],
  );
  report.checks.push(
    "real filesystem save failure retains original and blocks close; actual renderer crash recovers cached draft and saves exact bytes",
  );

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Actual stuck renderer; main process remains responsive and owns the close watchdog.
    void window.webContents
      .executeJavaScript("while (true) {}")
      .catch(() => {});
    setTimeout(() => window.close(), 100);
  });
  await new Promise((resolve) => setTimeout(resolve, 9000));
  assert.equal(
    (await application.evaluate(() => globalThis.recoveryMessages)).includes(
      "关闭前保存尚未完成",
    ),
    true,
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await application.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    await new Promise((resolve) => {
      contents.once("did-finish-load", () => resolve(true));
      contents.forcefullyCrashRenderer();
    });
  });
  await waitRenderer("!!document.querySelector('.book-card')");
  assert.equal(await readFile(manuscript, "utf8"), draft);
  report.checks.push(
    "actual blocked renderer triggers host close watchdog; default return keeps window and manuscript, recovery reload remains usable",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  throw error;
} finally {
  if (blocked) {
    await rmdir(pending);
    await rename(held, pending);
  }
  if (application) {
    // Failed recovery test may intentionally leave the renderer hung. Destroy only this test window.
    await application
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
      )
      .catch(() => {});
    await application.close().catch(() => {});
  }
  await writeFile(
    join(screenshots, "recovery-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
