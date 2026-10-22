import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "merge-ui-")),
  store = new NovelStore(join(data, "library"));
const base = "🙂旧港的雨停了。\n船还没有靠岸。\n旧信在窗台上。";
const book = await store.importBook("三方合成验证", [
    { title: "旧港", body: base },
  ]),
  chapterId = book.chapters[0].id;
const file = join(data, "library", book.id, "manuscript", `${chapterId}.md`);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002", "merge");
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
  await page.getByRole("button", { name: /三方合成验证/ }).click();
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  const remote = base.replace("旧信", "长信"),
    local = base.replace("旧港", "新港"),
    merged = local.replace("旧信", "长信");
  await writeFile(file, remote);
  await editor.fill(local);
  await editor.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "三方合并正文" });
  await dialog.waitFor();
  assert.equal(
    await page.getByLabel("三方合并稿", { exact: true }).inputValue(),
    merged,
  );
  assert.equal(await readFile(file, "utf8"), remote);
  // Modal focus must not reach the underlying editable manuscript, even with reverse tab.
  await page
    .getByRole("button", { name: "重新读取磁盘稿", exact: true })
    .focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  await page.getByLabel("三方合并稿", { exact: true }).press("Control+s");
  assert.equal(await readFile(file, "utf8"), remote);
  await page.screenshot({ path: join(screenshots, "three-way.png") });
  await page.getByRole("button", { name: "接受合并稿", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), merged);
  report.checks.push(
    "disjoint edits combine against common baseline; modal Ctrl+S cannot save background; explicit acceptance persists exact merge",
  );
  await editor.press("Control+z");
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), local);
  const nextLocal = local + "\n本地新增结尾。",
    nextRemote = local + "\n磁盘新增结尾。";
  await writeFile(file, nextRemote);
  await editor.fill(nextLocal);
  await editor.press("Control+s");
  await dialog.waitFor();
  await page.getByText("双方修改范围相交", { exact: false }).waitFor();
  const latestRemote = nextRemote + "第二次外部修改。";
  await writeFile(file, latestRemote);
  await page.getByRole("button", { name: "使用磁盘稿", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "磁盘稿再次改变" })
    .waitFor();
  assert.equal(await readFile(file, "utf8"), latestRemote);
  await page
    .getByRole("button", { name: "重新读取磁盘稿", exact: true })
    .click();
  await dialog.locator("pre").filter({ hasText: "第二次外部修改" }).waitFor();
  await page.getByRole("button", { name: "使用磁盘稿", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const versions = await page.evaluate(
    (ids) => window.novel.request("chapter.history", ids),
    { bookId: book.id, chapterId },
  );
  for (const text of [base, local, remote, nextLocal, latestRemote])
    assert.ok(versions.some((version) => version.body === text));
  report.checks.push(
    "overlap remains manual; second external edit blocks stale choice; refreshed disk acceptance preserves all discarded sides in history",
  );
  if (!(await page.getByRole("button", { name: "查看历史版本" }).isVisible()))
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: "本地新增结尾。" })
    .getByRole("button", { name: "恢复此版本" })
    .click();
  await editor.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
  assert.equal(await readFile(file, "utf8"), nextLocal);
  report.checks.push(
    "a discarded unsaved local side can be restored through the real history UI",
  );
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  const trigger = page.getByTitle("查找替换预览", { exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  await page.getByLabel("查找内容", { exact: true }).focus();
  await page.getByRole("button", { name: "关闭替换预览", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent === "取消"),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "关闭替换预览",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "查找替换预览" })
    .waitFor({ state: "hidden" });
  assert.equal(
    await trigger.evaluate((element) => document.activeElement === element),
    true,
  );
  report.checks.push(
    "dialog Tab/Shift+Tab wrap inside, Escape closes and restores trigger focus",
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
    join(screenshots, "merge-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
