import { _electron as electron } from "playwright";
import electronPath from "electron";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "diagnostics-ui-")),
  data = join(work, "data"),
  out = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-008",
    "diagnostics",
  );
await mkdir(out, { recursive: true });
const secret = "合成诊断原稿私有标记𠮷🌊",
  key = "synthetic-credential-never-log-7281";
const store = new NovelStore(join(data, "library")),
  book = await store.importBook("合成诊断作品名称", [
    { title: "原稿", body: secret },
  ]);
const alias = join(work, "数据别名"),
  target = join(work, "diagnostics.json");
await symlink(data, alias, process.platform === "win32" ? "junction" : "dir");
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Synthetic desktop host and author controls; save-dialog results instrumented, not native dialog clicks, system IME, upstream session-log audit or complete product qualification; packaged field identifies actual EXE execution",
};
let app, page, owned;
const request = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const panel = () => page.getByRole("dialog", { name: "故障诊断", exact: true });
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    env,
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  owned = await captureOwnedProcesses(app.process().pid);
}
async function closeApp() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
async function choose(path, canceled = false) {
  await app.evaluate(
    ({ dialog }, { path, canceled }) => {
      globalThis.__diagnosticPickCount = 0;
      dialog.showSaveDialog = async () => {
        globalThis.__diagnosticPickCount++;
        return { canceled, filePath: canceled ? undefined : path };
      };
    },
    { path, canceled },
  );
}
async function idle() {
  const end = Date.now() + 10000;
  while (
    !(await panel()
      .getByRole("button", { name: "刷新诊断", exact: true })
      .isEnabled())
  ) {
    assert.ok(Date.now() < end, "Diagnostic operation did not settle");
    await page.waitForTimeout(30);
  }
}
async function open() {
  await page.getByTitle("故障诊断", { exact: true }).click();
  await panel().getByLabel("诊断内容预览").waitFor();
  await idle();
}
async function exportClick() {
  await panel()
    .getByRole("button", { name: "导出为新文件", exact: true })
    .click();
  await idle();
}
try {
  await launch();
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = createHash("sha256")
      .update(await readFile(runtime.path))
      .digest("hex");
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n作者实际保存的新段落。");
  await editor.press("Control+s");
  const expected = secret + "\n作者实际保存的新段落。";
  const deadline = Date.now() + 10000;
  while (
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body !== expected
  ) {
    assert.ok(Date.now() < deadline);
    await page.waitForTimeout(30);
  }
  await assert.rejects(
    request("settings.save", {
      baseURL: `https://user:${key}@localhost/anthropic`,
      apiKey: key,
      model: "synthetic",
    }),
    /凭据/,
  );
  await open();
  const snapshot = await request("diagnostics.get");
  assert.ok(
    snapshot.events.some(
      (e) => e.operation === "chapter.save" && e.outcome === "ok",
    ),
  );
  assert.ok(
    snapshot.events.some(
      (e) => e.operation === "settings.save" && e.outcome === "error",
    ),
  );
  for (const marker of [
    secret,
    key,
    book.title,
    book.id,
    book.chapters[0].id,
    data,
  ])
    assert.ok(!JSON.stringify(snapshot).includes(marker));
  await page.screenshot({ path: join(out, "desktop-preview.png") });
  await choose(target);
  await assert.rejects(
    request("diagnostics.export", { path: target, body: secret }),
    /不接受/,
  );
  assert.equal(await app.evaluate(() => globalThis.__diagnosticPickCount), 0);
  await choose(target, true);
  await exportClick();
  assert.match(await panel().getByRole("status").innerText(), /已取消/);
  assert.ok(!(await readdir(work)).includes("diagnostics.json"));
  await choose(target);
  await app.evaluate(() => {
    const fs = process.getBuiltinModule("node:fs/promises"),
      original = fs.writeFile;
    globalThis.__diagnosticWriteHit = false;
    fs.writeFile = async (...args) => {
      if (
        String(args[0]).endsWith("diagnostics.json") &&
        !globalThis.__diagnosticWriteHit
      ) {
        globalThis.__diagnosticWriteHit = true;
        await new Promise((resolve) => {
          globalThis.__diagnosticWriteRelease = resolve;
        });
      }
      return original(...args);
    };
    globalThis.__diagnosticWriteRestore = () => {
      fs.writeFile = original;
    };
  });
  await panel()
    .getByRole("button", { name: "导出为新文件", exact: true })
    .click();
  const barrierDeadline = Date.now() + 10000;
  while (!(await app.evaluate(() => globalThis.__diagnosticWriteHit))) {
    assert.ok(Date.now() < barrierDeadline);
    await page.waitForTimeout(30);
  }
  await panel()
    .getByRole("button", { name: "关闭故障诊断", exact: true })
    .click();
  assert.ok(await panel().isVisible());
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  while (
    !(await panel().getByRole("status").innerText()).includes("关闭程序")
  ) {
    assert.ok(Date.now() < barrierDeadline);
    await page.waitForTimeout(30);
  }
  await app.evaluate(() => {
    globalThis.__diagnosticWriteRelease();
    globalThis.__diagnosticWriteRestore();
  });
  await idle();
  const exported = await readFile(target),
    parsed = JSON.parse(exported);
  assert.equal(parsed.format, "zinovel-diagnostics");
  for (const marker of [
    secret,
    key,
    book.title,
    book.id,
    book.chapters[0].id,
    data,
    target,
  ])
    assert.ok(!exported.includes(Buffer.from(marker)));
  await exportClick();
  assert.match(await panel().getByRole("alert").innerText(), /EEXIST/);
  assert.deepEqual(await readFile(target), exported);
  await choose(join(alias, "not-created", "report.json"));
  await exportClick();
  assert.match(await panel().getByRole("alert").innerText(), /数据目录/);
  assert.ok(!(await readdir(data)).includes("not-created"));
  assert.ok(!(await readdir(data)).includes("diagnostics"));
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    expected,
  );
  report.checks.push(
    "Actual author save and failed synthetic settings produce fixed metadata only; unique manuscript/title/IDs/path/credential absent from preview and export; injected path refused before native chooser and cancelled choice writes nothing",
    "Explicit native-selected JSON created once; actual delayed write guards panel and native-window close until completion; repeat refuses overwrite byte-for-byte; prospective data-root Junction child refused before creation; manuscript and private task/settings storage never gathered or changed",
  );
  await panel()
    .getByRole("button", { name: "关闭故障诊断", exact: true })
    .click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
  );
  await open();
  const r = await panel().evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
      client: node.clientWidth,
      scroll: node.scrollWidth,
      scale: devicePixelRatio,
    };
  });
  assert.ok(
    r.left >= 0 &&
      r.right <= r.width &&
      r.top >= 0 &&
      r.bottom <= r.height &&
      r.scroll <= r.client + 1,
  );
  report.geometry = r;
  await page.screenshot({ path: join(out, "dark-narrow-preview.png") });
  const before = (await request("diagnostics.get")).events.length;
  await panel()
    .getByRole("button", { name: "清空会话记录", exact: true })
    .click();
  await panel().getByRole("button", { name: "保留诊断", exact: true }).click();
  assert.equal((await request("diagnostics.get")).events.length, before);
  await panel()
    .getByRole("button", { name: "清空会话记录", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "确认清空诊断", exact: true })
    .click();
  await idle();
  assert.equal((await request("diagnostics.get")).events.length, 0);
  await panel()
    .getByRole("button", { name: "关闭故障诊断", exact: true })
    .click();
  await assert.rejects(
    request("chapter.read", {
      bookId: "invalid",
      chapterId: book.chapters[0].id,
    }),
  );
  assert.ok(
    (await request("diagnostics.get")).events.some(
      (e) => e.outcome === "error",
    ),
  );
  await closeApp();
  await launch();
  const restarted = await request("diagnostics.get");
  assert.ok(
    restarted.events.length > 0 &&
      restarted.events.every((e) => e.operation === "app.ready"),
  );
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    expected,
  );
  assert.ok(!(await readdir(data)).includes("diagnostics"));
  report.checks.push(
    "Desktop and dark narrow previews fit; clear is explicitly confirmed and cancellation preserves events; clear removes metadata alone; complete process restart discards prior errors and metadata while author manuscript persists without automatic diagnostic storage",
  );
  assert.deepEqual(report.errors, []);
  report.exportBytes = exported.length;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed" && owned)
      await terminateOwnedProcesses(owned);
    else await closeApp();
  }
  await writeFile(
    join(out, "diagnostics-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
