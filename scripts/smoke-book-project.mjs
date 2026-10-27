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
  work = await mkdtemp(join(root, ".cache", "book-project-ui-")),
  data = join(work, "data"),
  source = join(work, "harbor");
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-002",
  "book-project",
);
await mkdir(out, { recursive: true });
const inputs = new Map([
  ["README.md", "# 工程验证雾港\n合成小说工程，不含真实稿件。\n"],
  ["outline/master-plan.md", "\uFEFF# 总纲\r\n主角要送达旧信。𠮷🌊\r\n"],
  [
    "outline/volume-01-chapters-detail.md",
    "# 细纲\n渡口受阻，主人公必须作出选择。",
  ],
  ["worldbuilding/world.md", "# 世界\n雾城、渡口与旧船。"],
  ["worldbuilding/characters/anning.md", "# 安宁\n有独立目标的配角。"],
  ["production/state/current-state.md", "# 当前状态\n旧信仍未送达。"],
  [
    "manuscript/volume-01/chapter-001.md",
    "# 第001章 渡口\r\n合成正文保持原字节𠮷。\r\n",
  ],
]);
for (const [path, text] of inputs) {
  const absolute = join(source, ...path.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, text);
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  scope:
    "Browser plugin not available; actual Electron renderer/host with synthetic novel project. Native chooser instrumented; no native IME, installer or literature quality claim.",
};
const host = (action, payload = {}) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function start() {
  const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
  delete env.ELECTRON_RUN_AS_NODE;
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
    hash = createHash("sha256")
      .update(
        await readFile(
          runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
        ),
      )
      .digest("hex");
  if (report[key]) assert.equal(report[key], hash);
  report[key] = hash;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1200, 900),
  );
  assert.match(await page.title(), /ZiNovel/);
  await page.getByRole("button", { name: "导入作品", exact: true }).waitFor();
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
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    });
  }, source);
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await page
    .getByRole("button", { name: "导入小说站 / 创作工程", exact: true })
    .click();
  await page
    .getByRole("button", { name: "选择写作工程目录", exact: true })
    .click();
  await page.getByText("1 章正文 · 6 份创作资产", { exact: true }).waitFor();
  await shot("project-import-preview.png");
  await page
    .getByRole("button", { name: "确认新建小说工程", exact: true })
    .click();
  await page.getByRole("button", { name: "创作工程", exact: true }).waitFor();
  const book = (await host("library.list")).books[0];
  assert.equal(book.chapters.length, 1);
  const chapter = await host("chapter.read", {
    bookId: book.id,
    chapterId: book.chapters[0].id,
  });
  assert.equal(chapter.body, inputs.get("manuscript/volume-01/chapter-001.md"));
  await page.getByRole("button", { name: "创作工程", exact: true }).click();
  const d = (await host("project.list", { bookId: book.id })).documents.find(
    (d) => d.path === "outline/master-plan.md",
  );
  await page.getByLabel("创作资产", { exact: true }).selectOption(d.id);
  const editor = page.getByLabel("资产正文", { exact: true });
  await editor.waitFor();
  assert.equal(
    await editor.inputValue(),
    inputs.get(d.path).replace(/\r\n/g, "\n"),
  );
  await editor.press("End");
  await page.keyboard.insertText("作者补充𠮷：代价来自一次选择。");
  const edited = await editor.inputValue();
  await editor.press("Control+z");
  assert.equal(await editor.inputValue(), inputs.get(d.path).replace(/\r\n/g, "\n"));
  await editor.press("Control+y");
  assert.equal(await editor.inputValue(), edited);
  await page.getByRole("button", { name: "保存创作资产", exact: true }).click();
  await page
    .getByText("创作资产已保存，历史版本已保留。", { exact: true })
    .waitFor();
  assert.equal(
    (await host("project.read", { bookId: book.id, id: d.id })).text,
    edited,
  );
  report.checks.push(
    "actual import preview distinguishes six planning documents from one chapter; exact imported BOM/CRLF source preserved on disk; author Unicode editing and versioned save persist",
  );
  await shot("project-editor-desktop.png");
  // A stale editor must retain its own buffer and the competing disk bytes.
  const external = "# 外部总纲\r\n外部编辑不可被静默覆盖𠮷\r\n";
  await writeFile(
    join(data, "library", book.id, ...d.path.split("/")),
    external,
  );
  await editor.fill("我的未存冲突草稿𠮷");
  await page.getByRole("button", { name: "保存创作资产", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "创作资产已改变" }).waitFor();
  assert.equal(await editor.inputValue(), "我的未存冲突草稿𠮷");
  assert.equal(
    await readFile(
      join(data, "library", book.id, ...d.path.split("/")),
      "utf8",
    ),
    external,
  );
  await page.getByRole("button", { name: "关闭创作工程", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "有未保存的创作资产" })
    .waitFor();
  await shot("project-conflict-buffer-retained.png");
  await page
    .getByRole("button", { name: "放弃本次资产编辑", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭创作工程", exact: true }).click();
  await close();
  await start();
  await page
    .getByRole("button", { name: /工程验证雾港/ })
    .first()
    .click();
  await page.getByRole("button", { name: "创作工程", exact: true }).click();
  await page.getByLabel("创作资产", { exact: true }).selectOption(d.id);
  await page.getByText("检测到外部修改", { exact: false }).waitFor();
  const reloaded = page.getByLabel("资产正文", { exact: true });
  assert.equal(await reloaded.inputValue(), external.replace(/\r\n/g, "\n"));
  await reloaded.fill("# 外部版本复核后的新总纲\n作者保留了外部版本的历史。𠮷");
  await page.getByRole("button", { name: "保存创作资产", exact: true }).click();
  await page
    .getByText("创作资产已保存，历史版本已保留。", { exact: true })
    .waitFor();
  const saved = await host("project.read", { bookId: book.id, id: d.id });
  assert.equal(
    (
      await host("project.history", {
        bookId: book.id,
        id: d.id,
        revision: saved.revision,
      })
    ).before.text,
    external,
  );
  await page.getByLabel("资产历史版本", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "载入历史到编辑区", exact: true })
    .click();
  await page
    .getByText("已载入 v1 到编辑区；保存后才成为新版本。", { exact: true })
    .waitFor();
  assert.equal(
    await reloaded.inputValue(),
    inputs.get(d.path).replace(/\r\n/g, "\n"),
  );
  assert.equal(
    (await host("project.read", { bookId: book.id, id: d.id })).text,
    saved.text,
  );
  await page
    .getByRole("button", { name: "放弃本次资产编辑", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭创作工程", exact: true }).click();
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(806, 803),
  );
  await page.getByRole("button", { name: "创作工程", exact: true }).click();
  await page.getByLabel("创作资产", { exact: true }).selectOption(d.id);
  await shot("project-editor-dark-narrow.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  report.checks.push(
    "stale save preserves author buffer and external disk version; dirty close is blocked; full desktop restart reads external version; explicit save archives it; historical text loads only into review buffer; dark narrow layout fits",
  );
  await page.getByText("新建人物、分卷或其他资产", { exact: true }).click();
  await page
    .getByLabel("新资产相对路径", { exact: true })
    .fill("outline/volume-02-chapters-detail.md");
  await page.getByRole("button", { name: "新建空白资产", exact: true }).click();
  await page
    .locator(".project-modal p")
    .filter({ hasText: "outline/volume-02-chapters-detail.md · v1" })
    .waitFor();
  assert.equal(
    (await host("project.list", { bookId: book.id })).documents.length,
    7,
  );
  for (const [path, text] of inputs)
    assert.equal(
      await readFile(join(source, ...path.split("/")), "utf8"),
      text,
    );
  assert.equal(
    (
      await host("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    chapter.body,
  );
  report.checks.push(
    "author creates a second-volume detail asset through UI; all source files and imported manuscript remain byte-for-byte unchanged; no model/network request needed",
  );
  assert.deepEqual(report.errors, []);
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
    else await close();
  }
  await writeFile(
    join(out, "book-project-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
