import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { materialKinds } from "../packages/novel-domain/materials.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "materials-ui-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("创作资料合成验证", [
  {
    title: "抵达旧港",
    body: "林舟走下栈桥，把信收进衣袋。\n🌧️ 旧港的钟响了。",
  },
]);
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    `${book.chapters[0].id}.md`,
  ),
  original = await readFile(manuscript, "utf8");
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "materials",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const report = { status: "running", checks: [], errors: [], viewports: [] };
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_APP_EXE ? [] : [root],
    cwd: root,
    env,
  });
  page = await application.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  if (
    !(await page
      .getByRole("button", { name: "资料卡", exact: true })
      .isVisible())
  )
    await page.getByTitle("打开创作参考").click();
  await page.getByRole("button", { name: "资料卡", exact: true }).click();
}
const panel = () => page.getByRole("region", { name: "创作资料", exact: true });
async function screenshot(name) {
  await page.screenshot({ path: join(screenshots, name) });
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
  await launch();
  assert.match(await page.title(), /ZiNovel/);
  await screenshot("initial-materials.png");
  await writeFile(
    join(data, "initial-dom.txt"),
    await page.locator("body").ariaSnapshot(),
  );
  for (const kind of materialKinds) {
    await panel()
      .getByRole("combobox", { name: "新建类型", exact: true })
      .selectOption(kind.id);
    await panel()
      .getByRole("button", { name: "新建资料", exact: true })
      .click();
    await panel()
      .getByLabel("资料标题", { exact: true })
      .fill(`${kind.label}·旧港`);
    for (const field of kind.fields) {
      const control = field.options
        ? panel().getByRole("combobox", { name: field.label, exact: true })
        : panel().getByLabel(field.label, { exact: true });
      if (field.options) await control.selectOption(field.options[0]);
      else await control.fill(`${field.label}：林舟、旧港与一封未拆的信 🌧️`);
    }
    await panel()
      .getByLabel("资料笔记", { exact: true })
      .fill("计划尚未成为正文事实。\n允许手工修改。");
    if (!(await panel().getByLabel("抵达旧港", { exact: true }).isVisible()))
      await panel().locator("summary").filter({ hasText: "关联章节" }).click();
    await panel().getByLabel("抵达旧港", { exact: true }).check();
    await panel()
      .getByRole("button", { name: "保存资料", exact: true })
      .click();
    await panel()
      .getByRole("status")
      .filter({ hasText: "已保存资料" })
      .waitFor();
  }
  assert.equal((await store.materials.list(book.id)).total, 8);
  assert.equal(await readFile(manuscript, "utf8"), original);
  report.checks.push(
    "real Electron creates all eight typed cards through labeled forms with Unicode and stable chapter links; manuscript bytes unchanged",
  );
  await panel()
    .getByRole("combobox", { name: "资料类型", exact: true })
    .selectOption("character");
  await panel()
    .getByRole("button", { name: /人物·旧港/ })
    .click();
  await panel().getByLabel("别名与称谓", { exact: true }).fill("归舟");
  await panel()
    .getByRole("combobox", { name: "设定状态", exact: true })
    .selectOption("accepted");
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "版本 2" }).waitFor();
  await screenshot("character-light.png");
  await panel()
    .getByLabel("资料笔记", { exact: true })
    .fill("窗口关闭前未保存的调整 🌧️");
  await application.close();
  application = null;
  await launch();
  await panel()
    .getByRole("button", { name: /人物·旧港/ })
    .click();
  assert.equal(
    await panel().getByLabel("资料笔记", { exact: true }).inputValue(),
    "窗口关闭前未保存的调整 🌧️",
  );
  await panel().getByRole("status").filter({ hasText: "找回" }).waitFor();
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "版本 3" }).waitFor();
  await panel().getByLabel("搜索资料", { exact: true }).fill("归舟");
  await panel()
    .getByRole("button", { name: /人物·旧港/ })
    .waitFor();
  report.checks.push(
    "saved cards survive actual desktop restart, unsaved local adjustment is recovered explicitly, aliases search finds the character and author-confirmed status remains distinct from canon",
  );
  const card = (await store.materials.list(book.id, { kind: "character" }))
      .items[0],
    path = join(data, "library", book.id, "materials", `${card.id}.json`);
  const external =
    JSON.stringify(
      { ...JSON.parse(await readFile(path, "utf8")), notes: "外部作者的修改" },
      null,
      2,
    ) + "\n";
  await writeFile(path, external);
  await panel()
    .getByLabel("资料笔记", { exact: true })
    .fill("不能覆盖外部稿的本地调整");
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("alert").filter({ hasText: "外部编辑" }).waitFor();
  assert.equal(await readFile(path, "utf8"), external);
  assert.equal(
    await panel().getByLabel("资料笔记", { exact: true }).inputValue(),
    "不能覆盖外部稿的本地调整",
  );
  await screenshot("external-conflict.png");
  await panel()
    .getByRole("button", { name: "重新读取（放弃调整）", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.materials-panel textarea[rows="5"]')?.value ===
      "外部作者的修改",
  );
  await panel()
    .getByRole("button", { name: "移入资料回收站", exact: true })
    .click();
  await panel()
    .getByRole("status")
    .filter({ hasText: "已移入资料回收站" })
    .waitFor();
  await panel().getByLabel("资料回收站", { exact: true }).check();
  await panel()
    .getByRole("button", { name: /人物·旧港/ })
    .click();
  assert.equal(
    await panel().getByLabel("资料标题", { exact: true }).isDisabled(),
    true,
  );
  await panel().getByRole("button", { name: "恢复资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "资料已恢复" }).waitFor();
  await panel()
    .getByRole("button", { name: "查看资料历史", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "查看版本 1", exact: true })
    .click();
  await panel()
    .getByLabel("资料历史内容")
    .filter({ hasText: "允许手工修改" })
    .waitFor();
  await panel()
    .getByRole("button", { name: "载入历史为待保存草稿", exact: true })
    .click();
  await panel().getByRole("button", { name: "保存资料", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "版本 6" }).waitFor();
  assert.match(
    (await store.materials.read(book.id, card.id)).notes,
    /允许手工修改/,
  );
  await panel()
    .getByRole("button", { name: "抵达旧港 · 打开正文", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("章节标题", { exact: true }).inputValue(),
    "抵达旧港",
  );
  report.checks.push(
    "external same-revision edit blocks stale save and preserves both copies; trash restore retains identity and historical version is loaded only as an explicit new revision",
  );
  await panel().getByLabel("资料回收站", { exact: true }).uncheck();
  await panel().getByLabel("搜索资料", { exact: true }).fill("");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  if (!(await panel().isVisible()))
    await page.getByTitle("打开创作参考").click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await panel()
    .getByLabel("资料标题", { exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("character-dark-narrow.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(await readFile(manuscript, "utf8"), original);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = String(e.stack || e);
  if (page)
    await page
      .screenshot({ path: join(screenshots, "failure.png") })
      .catch(() => {});
  throw e;
} finally {
  if (application) await application.close();
  await writeFile(
    join(screenshots, "materials-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
