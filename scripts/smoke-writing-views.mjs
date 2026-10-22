import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "writing-view-")),
  store = new NovelStore(join(data, "library"));
const body = Array.from(
  { length: 80 },
  (_, i) => `第${i + 1}段：雨水沿着旧港的屋檐落下，林舟把信放在桌上。`,
).join("\n\n");
const book = await store.importBook("参考视图合成验证", [
  { title: "正在写的章", body },
  { title: "参考章", body: "旧版本参考：林舟还没有读信。" },
]);
const other = await store.readChapter(book.id, book.chapters[1].id);
await store.saveChapter({
  bookId: book.id,
  chapterId: other.id,
  title: other.title,
  body: "新版本参考：林舟读完了信。",
  expectedRevision: other.revision,
  expectedHash: other.diskHash,
});
const older = (await store.history(book.id, other.id)).find((version) =>
  version.body.startsWith("旧版本参考"),
);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002", "reference");
await mkdir(screenshots, { recursive: true });
let application, page;
const report = { checks: [], errors: [], status: "running" };
try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page
    .locator(".book-card")
    .filter({ hasText: "参考视图合成验证" })
    .click();
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  if (
    !(await page
      .getByRole("button", { name: "旧稿参考", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "旧稿参考", exact: true }).click();
  await page.getByLabel("参考章节", { exact: true }).selectOption(other.id);
  await page.getByLabel("参考版本", { exact: true }).selectOption(older.id);
  const reference = page.getByLabel("只读参考正文");
  assert.equal(await reference.textContent(), older.body);
  await editor.press("Control+End");
  await page.keyboard.insertText("\n正文的新句子。");
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await reference.textContent(), older.body);
  await writeFile(
    join(data, "library", book.id, "manuscript", `${other.id}.md`),
    "外部更新参考稿。",
  );
  assert.equal(await reference.textContent(), older.body);
  await page
    .getByRole("button", { name: "重新读取参考稿", exact: true })
    .click();
  await reference.filter({ hasText: "外部更新参考稿。" }).waitFor();
  await page.screenshot({ path: join(screenshots, "side-reference.png") });
  report.checks.push(
    "another chapter's historical snapshot stays read-only during manuscript editing and external changes; explicit reload updates reference only",
  );
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  await page.getByRole("button", { name: "专注", exact: true }).click();
  assert.equal(await page.locator(".chapters").isVisible(), false);
  assert.equal(
    await editor.evaluate((element) => document.activeElement === element),
    true,
  );
  await page.getByTitle("打字机模式", { exact: true }).click();
  await editor.press("Control+End");
  await page.keyboard.insertText("光标居中验证。");
  await page.waitForFunction(() => {
    const scroller = document
      .querySelector(".cm-scroller")
      .getBoundingClientRect();
    const cursor = document
      .querySelector(".cm-cursor")
      ?.getBoundingClientRect();
    return (
      cursor &&
      Math.abs(
        cursor.top + cursor.height / 2 - (scroller.top + scroller.height / 2),
      ) < 55
    );
  });
  report.caret = await page.evaluate(() => {
    const scroller = document
        .querySelector(".cm-scroller")
        .getBoundingClientRect(),
      cursor = document.querySelector(".cm-cursor").getBoundingClientRect();
    return {
      editorHeight: scroller.height,
      centerDistancePx: Math.round(
        Math.abs(
          cursor.top + cursor.height / 2 - (scroller.top + scroller.height / 2),
        ),
      ),
    };
  });
  await page.screenshot({ path: join(screenshots, "typewriter-focus.png") });
  await page.getByTitle("打字机模式", { exact: true }).click();
  await page.getByRole("button", { name: "退出专注", exact: true }).click();
  assert.equal(await page.locator(".chapters").isVisible(), true);
  assert.equal(
    await editor.evaluate((element) => document.activeElement === element),
    true,
  );
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  const expected = body + "\n正文的新句子。光标居中验证。";
  assert.equal(
    await readFile(
      join(data, "library", book.id, "manuscript", `${book.chapters[0].id}.md`),
      "utf8",
    ),
    expected,
  );
  report.checks.push(
    "focus hides sidebars and restores input focus; typewriter mode centers actual caret; toggles retain exact manuscript bytes",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await page
    ?.screenshot({ path: join(screenshots, "views-failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await application?.close();
  await writeFile(
    join(screenshots, "writing-views-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
