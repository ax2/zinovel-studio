import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "shelf-ui-")),
  store = new NovelStore(join(data, "library"));
let first;
for (let index = 0; index < 100; index++) {
  let book = await store.importBook(
    `合成作品${String(index).padStart(3, "0")}`,
    [
      { title: "第一章 旧港", volume: "第一卷", body: `合成原稿${index}。` },
      ...(index === 0
        ? [{ title: "第二章 远海", volume: "第二卷", body: "正式章原稿。" }]
        : []),
    ],
  );
  book = await store.updateStructure(book.id, book.revision, {
    type: "book-metadata",
    title: book.title,
    genre: index % 2 ? "悬疑" : "幻想",
    series: index % 3 ? "北港" : "南港",
    author: index % 2 ? "甲" : "乙",
  });
  if (index === 0)
    first = await store.updateStructure(book.id, book.revision, {
      type: "chapter-status",
      chapterId: book.chapters[1].id,
      status: "final",
    });
}
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002", "shelf");
await mkdir(screenshots, { recursive: true });
let application, page;
const report = { books: 100, checks: [], errors: [], status: "running" };
async function launch() {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.getByLabel("筛选作品类型").waitFor();
}
try {
  await launch();
  assert.equal(await page.locator(".book-card").count(), 100);
  await page.getByLabel("筛选作品类型").selectOption("幻想");
  await page.getByLabel("筛选作品系列").selectOption("南港");
  assert.equal(await page.locator(".book-card").count(), 17);
  await page.getByLabel("书库排序").selectOption("title");
  assert.equal(
    await page.locator(".book-card h2").first().textContent(),
    "合成作品000",
  );
  await page.screenshot({ path: join(screenshots, "filtered-library.png") });
  await page.getByLabel("查找书名或作者").fill("合成作品006");
  assert.equal(await page.locator(".book-card").count(), 1);
  await page
    .getByRole("button", { name: "归档作品 合成作品006", exact: true })
    .click();
  await page.getByText("没有符合筛选条件的作品", { exact: true }).waitFor();
  await page.getByLabel("书库归档范围").selectOption("archived");
  await page.locator(".book-card").waitFor();
  await application.close();
  await launch();
  assert.equal(await page.getByLabel("筛选作品类型").inputValue(), "幻想");
  assert.equal(await page.getByLabel("书库归档范围").inputValue(), "archived");
  assert.equal(await page.locator(".book-card").count(), 1);
  await page
    .getByRole("button", { name: "取消归档 合成作品006", exact: true })
    .click();
  await page.getByText("没有符合筛选条件的作品", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  assert.equal(await page.locator(".book-card").count(), 100);
  report.checks.push(
    "100 real stored books: intersect genre/series/title filters, title sort, archive/unarchive and restart retain list and preferences",
  );
  await page.locator(".book-card").filter({ hasText: "合成作品000" }).click();
  await page.getByLabel("正文编辑器").waitFor();
  await page.getByLabel("筛选章节状态").selectOption("final");
  assert.equal(await page.locator(".chapter-list button").count(), 1);
  assert.equal(
    await page.locator(".chapter-list button").innerText(),
    "第二章 远海\n正式",
  );
  await page.getByLabel("筛选章节状态").selectOption("draft");
  assert.equal(await page.locator(".chapter-list button").count(), 1);
  await page.getByLabel("筛选章节状态").selectOption("all");
  await page
    .getByRole("button", { name: "管理作品 / 回收站", exact: true })
    .click();
  await page.getByTitle("上移分卷 第二卷", { exact: true }).click();
  await page.getByRole("button", { name: "关闭作品管理", exact: true }).click();
  assert.equal(
    await page.locator(".volume-label").first().textContent(),
    "第二卷",
  );
  const current = await page.evaluate(() =>
    window.novel.request("library.list"),
  );
  const changed = current.books.find((book) => book.id === first.id);
  assert.deepEqual(
    changed.chapters.map((chapter) => chapter.id),
    first.chapters.map((chapter) => chapter.id).reverse(),
  );
  const snapshot = await store.exportSnapshot(first.id);
  assert.deepEqual(
    snapshot.chapters.map((chapter) => chapter.body),
    ["正式章原稿。", "合成原稿0。"],
  );
  await page.screenshot({
    path: join(screenshots, "chapter-state-and-order.png"),
  });
  report.checks.push(
    "draft/final chapter filters and whole-volume reorder preserve chapter IDs, manuscript bytes and export order",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  throw error;
} finally {
  await application?.close();
  await writeFile(
    join(screenshots, "shelf-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
