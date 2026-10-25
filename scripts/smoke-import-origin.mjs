import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "origin-ui-"));
const data = join(work, "data"),
  sources = join(work, "PRIVATE_SOURCE_DIRECTORY_SENTINEL"),
  backups = join(work, "backups");
await mkdir(sources);
await mkdir(backups);
const originals = new Map();
for (let i = 1; i <= 21; i++) {
  const file = join(
      sources,
      `源稿${String(i).padStart(2, "0")}_PRIVATE_ORIGIN_SENTINEL.md`,
    ),
    body = `第${i}章 合成${i}\n来源正文𠮷🙂${i}`;
  originals.set(file, body);
  await writeFile(file, body);
}
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-002",
  "import-origin",
);
await mkdir(out, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  scope:
    "Browser plugin not available; actual Electron import-origin viewer and host storage/backup. Native chooser returns synthetic fixture paths; no user manuscript, native IME or arbitrary external-write atomicity claim.",
};
const host = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function start() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: root,
    env,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  const key = runtime.packaged ? "appAsarSha256" : "desktopBundleSha256",
    digest = createHash("sha256")
      .update(
        await readFile(
          runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
        ),
      )
      .digest("hex");
  if (report[key]) assert.equal(report[key], digest);
  report[key] = digest;
  if (!runtime.packaged) {
    const frontend = {};
    for (const name of ["app.js", "app.css", "index.html"])
      frontend[name] = createHash("sha256")
        .update(await readFile(join(root, "dist/workbench", name)))
        .digest("hex");
    if (report.frontend) assert.deepEqual(report.frontend, frontend);
    report.frontend = frontend;
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1008, 803),
  );
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
async function select(path) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
}
async function origin() {
  await page
    .getByRole("button", { name: "管理作品 / 回收站", exact: true })
    .click();
  await page.getByText("导入来源与确认记录", { exact: true }).click();
  return page.getByRole("region", { name: "导入来源说明", exact: true });
}
async function shot(name) {
  await page.screenshot({ path: join(out, name) });
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
  await start();
  await select(sources);
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await page.getByRole("button", { name: "选择稿件目录", exact: true }).click();
  await page.getByText("21 个源文件 · 21 章", { exact: false }).waitFor();
  await page.getByText("手工调整章节名称与边界", { exact: true }).click();
  await page.getByLabel("预览章名", { exact: true }).fill("确认时的首章名");
  await page.getByRole("button", { name: "应用卷章名称", exact: true }).click();
  await page
    .locator(".import-preview button")
    .filter({ hasText: "确认时的首章名" })
    .waitFor();
  await page.getByLabel("导入作品名称").fill("来源追溯合成书");
  await page
    .getByRole("button", { name: "确认导入为新作品", exact: true })
    .click();
  await page.getByLabel("正文编辑器").waitFor();
  const book = (await host("library.list")).books[0],
    result = await host("book.import-origin", { bookId: book.id });
  assert.equal(result.origin.manualAdjustmentCount, 1);
  assert.equal(result.origin.originalChapterCount, 21);
  assert.equal(result.origin.chapters[0].title, "确认时的首章名");
  assert.equal(result.origin.applicationVersion, report.version);
  report.originSchemaVersion = result.origin.schemaVersion;
  report.sourceCount = result.origin.sources.length;
  report.chapterCount = result.origin.chapters.length;
  assert.equal(
    JSON.stringify(result).includes("PRIVATE_SOURCE_DIRECTORY_SENTINEL"),
    false,
  );
  report.absolutePathsExcluded = true;
  let view = await origin();
  await view.getByText("初始 21 章", { exact: false }).waitFor();
  assert.equal(await view.locator(".import-origin-files li").count(), 20);
  await view.getByRole("button", { name: "下一页来源", exact: true }).click();
  await view
    .getByText("源稿21_PRIVATE_ORIGIN_SENTINEL.md", { exact: true })
    .waitFor();
  assert.equal(await view.locator(".import-origin-files li").count(), 1);
  await view.getByText("导入时的章节与内容指纹（21）", { exact: true }).click();
  await view
    .getByRole("button", { name: "下一页导入章节", exact: true })
    .click();
  await view.getByText("第21章 合成21", { exact: false }).waitFor();
  await shot("origin-light-pagination.png");
  report.checks.push(
    "Actual 21-file manual-reviewed import atomically creates private provenance; UI pages through every source and original chapter, with exact encoding/version/count/hash fields and no absolute source directory",
  );
  await page.getByRole("button", { name: "关闭作品管理", exact: true }).click();
  await page.getByLabel("正文编辑器").fill("编辑后保留来源记录𠮷🙂");
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.deepEqual(
    (await host("book.import-origin", { bookId: book.id })).origin,
    result.origin,
  );
  const receipt = join(data, "library", book.id, ".zinovel/import-origin.json"),
    raw = await readFile(receipt);
  report.receiptSha256 = createHash("sha256").update(raw).digest("hex");
  await select(backups);
  const backup = await host("book.backup", { bookId: book.id });
  await page.getByTitle("返回书库", { exact: true }).click();
  await select(backup.path);
  await page.getByRole("button", { name: "恢复备份", exact: true }).click();
  await page.getByLabel("正文编辑器").waitFor();
  const restored = (await host("library.list")).books.find(
    (candidate) => candidate.id !== book.id,
  );
  assert.ok(restored);
  assert.equal(
    (await host("book.import-origin", { bookId: restored.id })).restoredCopy,
    true,
  );
  const restoredReceipt = join(
    data,
    "library",
    restored.id,
    ".zinovel/import-origin.json",
  );
  assert.deepEqual(await readFile(restoredReceipt), raw);
  report.restoredRecordBytesPreserved = true;
  await page.getByTitle("深色主题", { exact: true }).click();
  view = await origin();
  await view
    .getByRole("status")
    .filter({ hasText: "恢复前的原作品" })
    .waitFor();
  await shot("origin-restored-dark.png");
  await page.getByRole("button", { name: "关闭作品管理", exact: true }).click();
  await close();
  await start();
  await page
    .locator(".book-card")
    .filter({
      has: page.getByRole("heading", { name: restored.title, exact: true }),
    })
    .click();
  view = await origin();
  await view
    .getByRole("status")
    .filter({ hasText: "恢复前的原作品" })
    .waitFor();
  assert.deepEqual(
    (await host("book.import-origin", { bookId: restored.id })).origin,
    result.origin,
  );
  report.checks.push(
    "Manual manuscript edits preserve the original import snapshot; actual host backup and UI restore keep exact receipt bytes/IDs, explain restored lineage, and remain readable after full desktop restart",
  );
  await page.getByRole("button", { name: "关闭作品管理", exact: true }).click();
  await page.getByTitle("返回书库", { exact: true }).click();
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("直接新建无来源");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  view = await origin();
  await view
    .getByText("此作品没有保留导入来源说明。", { exact: false })
    .waitFor();
  report.checks.push(
    "A directly created/legacy book explicitly reports missing provenance rather than inventing an import or inferring missing manuscript",
  );
  await page.getByRole("button", { name: "关闭作品管理", exact: true }).click();
  await close();
  const unknown = JSON.stringify({
    ...result.origin,
    schemaVersion: 99,
    futureField: "FUTURE_ORIGIN_SENTINEL",
  });
  await writeFile(restoredReceipt, unknown);
  await start();
  await page
    .locator(".book-card")
    .filter({
      has: page.getByRole("heading", { name: restored.title, exact: true }),
    })
    .click();
  view = await origin();
  await view.getByRole("alert").filter({ hasText: "版本不支持" }).waitFor();
  assert.equal(
    await view
      .getByText("此作品没有保留导入来源说明。", { exact: false })
      .count(),
    0,
  );
  await shot("origin-unknown-preserved.png");
  assert.equal(await readFile(restoredReceipt, "utf8"), unknown);
  report.unknownRecordPreserved = true;
  for (const [file, text] of originals)
    assert.equal(await readFile(file, "utf8"), text);
  report.checks.push(
    "Unknown future provenance displays an explicit retained-original error and never an empty legacy state; exact bytes and all 21 source originals remain untouched",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed" && owned)
      await terminateOwnedProcesses(owned);
    await app.close().catch(() => {});
    if (owned) await confirmOwnedProcessesExited(owned);
  }
  await writeFile(
    join(out, "import-origin-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
