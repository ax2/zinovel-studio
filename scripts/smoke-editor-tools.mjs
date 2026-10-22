import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "editor-tools-"));
const store = new NovelStore(join(data, "library"));
const body = "𠮷" + "甲乙。".repeat(120);
const book = await store.importBook("编辑工具合成验证", [
  { title: "旧港", body },
]);
const chapterId = book.chapters[0].id,
  file = join(data, "library", book.id, "manuscript", `${chapterId}.md`);
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
const screenshots = join(root, "screenshots", "stage-002", "annotations");
await mkdir(screenshots, { recursive: true });
const report = { checks: [], errors: [], status: "running" };
let application, page;
async function save() {
  await page.getByLabel("正文编辑器").press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "已保存",
  );
}
async function openMarkers() {
  if (
    !(await page
      .getByRole("button", { name: "批注与书签", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "批注与书签", exact: true }).click();
  await page.getByRole("dialog", { name: "批注书签与场景" }).waitFor();
}
try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1008, 750),
  );
  await page.getByRole("button", { name: /编辑工具合成验证/ }).click();
  let editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  await page.getByTitle("查找替换预览", { exact: true }).click();
  await page.getByLabel("查找内容", { exact: true }).fill("甲乙");
  await page.getByLabel("替换为", { exact: true }).fill("丙");
  await page.getByRole("button", { name: "预览替换位置", exact: true }).click();
  await page.getByRole("button", { name: "取消全部选择", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "应用本章替换", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("替换位置 3", { exact: true }).check();
  await page.getByRole("button", { name: "下一页匹配", exact: true }).click();
  await page.getByLabel("替换位置 156", { exact: true }).check();
  await page.getByRole("button", { name: "上一页匹配", exact: true }).click();
  assert.equal(
    await page.getByLabel("替换位置 3", { exact: true }).isChecked(),
    true,
  );
  await page.screenshot({ path: join(screenshots, "individual-replace.png") });
  await page.getByRole("button", { name: "应用本章替换", exact: true }).click();
  await page
    .getByRole("dialog", { name: "查找替换预览" })
    .waitFor({ state: "hidden" });
  await save();
  assert.equal(
    await readFile(file, "utf8"),
    "𠮷" +
      Array.from({ length: 120 }, (_, i) =>
        i === 0 || i === 51 ? "丙。" : "甲乙。",
      ).join(""),
  );
  await editor.press("Control+z");
  await save();
  assert.equal(await readFile(file, "utf8"), body);
  report.checks.push(
    "120 matches: select two across pages, retain 118 exact originals, one-step undo",
  );

  const original = "旧信放在窗台。\n林舟关上了门。";
  await editor.fill(original);
  await save();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
  await openMarkers();
  await page.getByLabel("标记标题", { exact: true }).fill("追踪旧信");
  await page
    .getByLabel("标记说明", { exact: true })
    .fill("这一细节将在后文回应。\n保留物件的来历。");
  await page.getByRole("button", { name: "添加标记", exact: true }).click();
  const card = page
    .locator(".annotation-card")
    .filter({
      has: page.getByRole("heading", { name: "追踪旧信", exact: true }),
    });
  await card.getByText("原位有效", { exact: false }).waitFor();
  await page.getByLabel("标记类型", { exact: true }).selectOption("bookmark");
  await page.getByLabel("标记标题", { exact: true }).fill("回访开头");
  await page.getByRole("button", { name: "添加标记", exact: true }).click();
  await page.getByRole("heading", { name: "回访开头", exact: true }).waitFor();
  await page.getByLabel("标记类型", { exact: true }).selectOption("scene");
  await page.getByLabel("标记标题", { exact: true }).fill("旧信场景");
  await page.getByRole("button", { name: "添加标记", exact: true }).click();
  await page.getByRole("heading", { name: "旧信场景", exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "markers.png") });
  await page.getByRole("button", { name: "关闭批注", exact: true }).click();
  assert.equal(await readFile(file, "utf8"), original);
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  await editor.fill("序章。\n" + original);
  await save();
  await openMarkers();
  await card.getByText("已重新定位", { exact: false }).waitFor();
  await card.getByRole("button", { name: "定位正文", exact: true }).click();
  await page.waitForFunction(
    () => window.getSelection()?.toString() === "旧信放在窗台。",
  );
  report.checks.push(
    "note/bookmark/scene persist separately; insertion relocates quote and UI selects exact original",
  );
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  await editor.fill("信已烧毁。\n林舟关上了门。");
  await save();
  await openMarkers();
  await card.getByText("原文已改变，需重新绑定", { exact: false }).waitFor();
  assert.equal(
    await card
      .getByRole("button", { name: "定位正文", exact: true })
      .isEnabled(),
    false,
  );
  await page.screenshot({ path: join(screenshots, "invalid-anchor.png") });
  await page.getByRole("button", { name: "关闭批注", exact: true }).click();
  if (await page.getByRole("button", { name: "关闭创作参考" }).isVisible())
    await page.getByRole("button", { name: "关闭创作参考" }).click();
  await editor.press("Control+Home");
  await editor.press("Shift+End");
  await openMarkers();
  await card.getByRole("button", { name: "绑定当前选区", exact: true }).click();
  await card.getByText("原位有效", { exact: false }).waitFor();
  await card.getByRole("button", { name: "标为已处理", exact: true }).click();
  await card
    .getByRole("button", { name: "重新打开批注", exact: true })
    .waitFor();
  await card.getByRole("button", { name: "回收标记", exact: true }).click();
  await card.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "标记回收站", exact: true }).click();
  await card.getByRole("button", { name: "恢复标记", exact: true }).click();
  await card.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "显示有效标记", exact: true }).click();
  await card
    .getByRole("button", { name: "重新打开批注", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "关闭批注", exact: true }).click();
  await application.close();
  application = await electron.launch({
    executablePath: electronPath,
    args: [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  await page.getByRole("button", { name: /编辑工具合成验证/ }).click();
  await openMarkers();
  const recovered = await page.evaluate(
    (ids) => window.novel.request("annotations.read", ids),
    { bookId: book.id, chapterId },
  );
  assert.equal(recovered.items.length, 3);
  assert.equal(recovered.items[0].resolved, true);
  assert.equal(recovered.items[0].anchor.quote, "信已烧毁。");
  report.checks.push(
    "deleted anchor disables navigation; explicit rebind, resolve, recycle, restore and process restart retain state",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await page
    ?.screenshot({ path: join(screenshots, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await application?.close();
  await writeFile(
    join(screenshots, "editor-tools-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
