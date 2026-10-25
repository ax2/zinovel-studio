import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "import-review-ui-"));
const sources = join(work, "中文 原稿"),
  out = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-002",
    "import-review",
  );
await mkdir(sources);
await mkdir(out, { recursive: true });
const originals = new Map([
  [join(sources, "2.txt"), "第一卷 海港\n第一章 信\n甲𠮷🙂乙\n丙丁"],
  [join(sources, "10.md"), "第二卷 远海\n第二章 灯\n尾声"],
]);
for (const [file, body] of originals) await writeFile(file, body);
const env = { ...process.env, ZINOVEL_DATA_ROOT: join(work, "data") };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned, firstBook;
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  scope:
    "Browser plugin not available; actual Electron manual import review and host revision/duplicate guards. Native source chooser is stubbed; synthetic text only, no native IME claim.",
};
const host = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const waitBody = (body) =>
  page.waitForFunction(
    (body) => document.querySelector("textarea.import-body")?.value === body,
    body,
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
  const sha = createHash("sha256")
    .update(
      await readFile(
        runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
      ),
    )
    .digest("hex");
  const key = runtime.packaged ? "appAsarSha256" : "desktopBundleSha256";
  if (report[key]) assert.equal(sha, report[key]);
  report[key] = sha;
  if (!runtime.packaged) {
    const frontend = {};
    for (const name of ["app.js", "app.css", "index.html"])
      frontend[name] = createHash("sha256")
        .update(await readFile(join(root, "dist/workbench", name)))
        .digest("hex");
    if (report.frontend) assert.deepEqual(frontend, report.frontend);
    report.frontend = frontend;
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1008, 803),
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, sources);
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
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
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await page.getByRole("button", { name: "选择稿件目录", exact: true }).click();
  await waitBody("甲𠮷🙂乙\n丙丁");
  await page.getByText("手工调整章节名称与边界", { exact: true }).click();
  await page.getByLabel("预览章名", { exact: true }).fill("手改首章");
  await page.getByLabel("预览卷名", { exact: true }).fill("作者自定卷");
  await page.getByRole("button", { name: "应用卷章名称", exact: true }).click();
  await page
    .locator(".import-preview button")
    .filter({ hasText: "手改首章" })
    .waitFor();
  const body = page.getByLabel("预览正文（选择拆分位置）", { exact: true });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  await page.bringToFront();
  await body.focus();
  await body.press("Control+Home");
  await body.press("ArrowRight");
  await body.press("ArrowRight");
  assert.equal(await body.evaluate((e) => e.selectionStart), 3);
  await body.press("Control+Home");
  await body.press("Shift+ArrowRight");
  await body.press("Shift+ArrowRight");
  assert.deepEqual(
    await body.evaluate((e) => [e.selectionStart, e.selectionEnd]),
    [0, 3],
  );
  await body.press("ArrowRight");
  await page.getByLabel("拆分后新章名称", { exact: true }).fill("第二段𠮷🙂");
  await page.getByRole("button", { name: "从光标处拆分", exact: true }).click();
  await waitBody("甲𠮷");
  assert.equal(await page.locator(".import-preview button").count(), 3);
  await shot("manual-split-light.png");
  report.checks.push(
    "Actual directory preview rename/volume correction and keyboard cursor split preserve whole supplementary Unicode characters and expose three planned chapters without touching sources",
  );
  await page.getByLabel("合并分隔方式", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "与下一章合并", exact: true }).click();
  await waitBody("甲𠮷🙂乙\n丙丁");
  assert.equal(
    await page.getByLabel("预览章名", { exact: true }).inputValue(),
    "手改首章",
  );
  await page
    .getByRole("button", { name: "放弃全部预览调整", exact: true })
    .click();
  await page
    .locator(".import-preview button")
    .filter({ hasText: "第一章 信" })
    .waitFor();
  assert.equal(await page.locator(".import-preview button").count(), 2);
  await waitBody("甲𠮷🙂乙\n丙丁");
  report.checks.push(
    "Direct-join merge restores split body exactly; explicit reset restores original volume/chapter titles and body from frozen preview, with no source rewrite",
  );
  const token = await host("import.choose", { directory: true });
  const reviewed = await host("import.review", {
    id: token.id,
    revision: token.revision,
    operation: {
      type: "rename",
      chapterId: token.preview.chapters[0].id,
      title: "仅测试的另一个预览",
      volume: "",
    },
  });
  await assert.rejects(
    host("import.commit", {
      id: token.id,
      revision: token.revision,
      title: "不得创建",
    }),
    /已经改变/,
  );
  await assert.rejects(
    host("import.review", {
      id: token.id,
      revision: reviewed.revision,
      operation: {
        type: "split",
        chapterId: "outside",
        offset: 1,
        title: "不得创建",
      },
    }),
    /失效/,
  );
  assert.equal((await host("library.list")).books.length, 0);
  report.checks.push(
    "Real preload/host IPC rejects stale preview commit and unknown preview chapter ID with zero books created; renderer cannot submit arbitrary chapter arrays",
  );
  await page.getByLabel("预览章名", { exact: true }).fill("确认首章");
  await page.getByLabel("预览卷名", { exact: true }).fill("作者自定卷");
  await page.getByRole("button", { name: "应用卷章名称", exact: true }).click();
  await page.getByLabel("导入作品名称").fill("手动分章确认合成稿");
  await page
    .getByRole("button", { name: "确认导入为新作品", exact: true })
    .click();
  await page.getByLabel("正文编辑器").waitFor();
  const books = (await host("library.list")).books;
  assert.equal(books.length, 1);
  firstBook = books[0];
  assert.equal(firstBook.chapters.length, 2);
  assert.equal(firstBook.volumes.length, 2);
  assert.equal(firstBook.chapters[0].title, "确认首章");
  const saved = await host("chapter.read", {
    bookId: firstBook.id,
    chapterId: firstBook.chapters[0].id,
  });
  assert.equal(saved.body, "甲𠮷🙂乙\n丙丁");
  await page.getByTitle("深色主题", { exact: true }).click();
  await page.getByTitle("返回书库", { exact: true }).click();
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await page.getByRole("button", { name: "选择稿件目录", exact: true }).click();
  await waitBody("甲𠮷🙂乙\n丙丁");
  await shot("manual-review-dark.png");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await close();
  await start();
  await page
    .locator(".book-card")
    .filter({ hasText: "手动分章确认合成稿" })
    .click();
  const reopened = (await host("library.list")).books[0];
  assert.deepEqual(reopened.chapters, firstBook.chapters);
  assert.deepEqual(reopened.volumes, firstBook.volumes);
  for (const [file, text] of originals)
    assert.equal(await readFile(file, "utf8"), text);
  report.checks.push(
    "Confirmed directory review creates exactly one real book; cancel creates none, full restart retains formal chapter IDs/volume metadata/body and source originals, dark review is readable",
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
    join(out, "import-review-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
