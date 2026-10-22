import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "library-ui-"));
const source = join(work, "合成多卷稿.txt"),
  backups = join(work, "backups");
const original =
  "第一卷 旧港\n第一章 旧信\n林舟在雨中收到了一封旧信。\n第二章 灯塔\n信中约定了灯塔的熄灭时刻。\n第二卷 远海\n第三章 出航\n船离岸时，他终于读懂了那行字。";
await writeFile(source, original, "utf8");
await mkdir(backups);
const env = { ...process.env, ZINOVEL_DATA_ROOT: join(work, "data") };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002");
await mkdir(screenshots, { recursive: true });
let application, page;
const report = {
  checks: [],
  errors: [],
  status: "running",
  nativeDialogSelection:
    "programmatically selects fixture paths; all application IPC/storage operations are real",
};
try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1008, 681),
  );
  page.on("pageerror", (error) => report.errors.push(error.message));
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, source);
  await page.getByRole("button", { name: "导入作品", exact: true }).click();
  await page
    .getByRole("button", { name: "选择 TXT / Markdown", exact: true })
    .click();
  await page.getByText("1 个源文件 · 3 章", { exact: false }).waitFor();
  await page.getByLabel("导入作品名称").fill("雾港来信·导入验证");
  await page.screenshot({ path: join(screenshots, "import-preview.png") });
  await page.getByRole("button", { name: "确认导入为新作品" }).click();
  await page.getByLabel("正文编辑器").waitFor();
  assert.equal(await readFile(source, "utf8"), original);
  const initial = await page.evaluate(() =>
    window.novel.request("library.list"),
  );
  const book = initial.books[0];
  assert.equal(book.chapters.length, 3);
  assert.equal(book.volumes.length, 2);
  report.checks.push(
    "native file selection -> multi-volume preview -> new book; source bytes unchanged",
  );
  await page
    .getByRole("button", { name: "管理作品 / 回收站", exact: true })
    .click();
  await page.getByLabel("第一章 旧信 状态").selectOption("final");
  await page.getByTitle("移入回收站 第二章 灯塔", { exact: true }).click();
  await page.getByTitle("恢复 第二章 灯塔", { exact: true }).click();
  await page.getByLabel("新分卷名称").fill("第三卷 归航");
  await page.getByRole("button", { name: "新建分卷", exact: true }).click();
  await page
    .getByLabel("第三章 出航 所属分卷")
    .selectOption({ label: "第三卷 归航" });
  await page.screenshot({ path: join(screenshots, "structure.png") });
  await page.getByRole("button", { name: "关闭作品管理" }).click();
  const updated = await page.evaluate(() =>
    window.novel.request("library.list"),
  );
  assert.deepEqual(
    updated.books[0].chapters.map((ch) => ch.id).sort(),
    book.chapters.map((ch) => ch.id).sort(),
  );
  assert.equal(updated.books[0].chapters[0].status, "final");
  assert.equal(updated.books[0].chapters[1].deletedAt, undefined);
  report.checks.push(
    "chapter state, trash/restore, new volume and chapter reassignment preserve IDs",
  );
  await page.getByTitle("书内全文搜索", { exact: true }).click();
  await page.getByLabel("全文检索词").fill("终于读懂");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.locator(".search-results button").click();
  await page.waitForFunction(
    () => window.getSelection()?.toString() === "终于读懂",
  );
  assert.equal(
    await page
      .getByLabel("正文编辑器")
      .evaluate((element) => window.getSelection().toString()),
    "终于读懂",
  );
  report.checks.push(
    "full-text hit opens correct chapter and selects exact UTF-16 range",
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backups);
  if (!(await page.getByRole("button", { name: "备份整部作品" }).isVisible()))
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "备份整部作品" }).click();
  await page.getByRole("status").filter({ hasText: "备份完成" }).waitFor();
  const backup = join(
    backups,
    (await readdir(backups)).find((name) => name.startsWith("zinovel-backup-")),
  );
  const manifest = JSON.parse(
    await readFile(join(backup, "backup-manifest.json"), "utf8"),
  );
  assert.ok(manifest.files.length > 4);
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  await page.getByTitle("返回书库").click();
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backup);
  await page.getByRole("button", { name: "恢复备份", exact: true }).click();
  await page.getByLabel("正文编辑器").waitFor();
  const restored = await page.evaluate(() =>
    window.novel.request("library.list"),
  );
  assert.equal(restored.books.length, 2);
  assert.notEqual(restored.books[0].id, book.id);
  report.checks.push(
    "complete directory backup verified and restored as separate book, original retained",
  );
  await page.screenshot({ path: join(screenshots, "restored-book.png") });
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  if (page) {
    await page
      .screenshot({ path: join(screenshots, "failure.png") })
      .catch(() => {});
    report.selectionAtFailure = await page
      .evaluate(() => ({
        text: window.getSelection()?.toString(),
        active: document.activeElement?.outerHTML.slice(0, 500),
        cursors: Object.entries(localStorage).filter(([key]) =>
          key.startsWith("zinovel.cursor."),
        ),
      }))
      .catch(() => null);
  }
  throw error;
} finally {
  if (application) await application.close();
  await writeFile(
    join(screenshots, "library-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
