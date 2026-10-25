import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { createHash } from "node:crypto";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "planning-ui-")),
  store = new NovelStore(join(data, "library"));
let book = await store.importBook("场景编排合成验证", [
  {
    title: "抵达旧港",
    body: "林舟走下栈桥。\n🌧️ 原稿不会因规划移动改变。",
    volume: "卷一",
  },
  { title: "未拆的信", body: "他把信收进衣袋。", volume: "卷二" },
]);
const scenes = [];
for (const [title, goal, choice] of [
  ["寻找信使", "追上信使", "绕过市场"],
  ["船边争执", "拿回旧信", "拒绝交易"],
  ["旧钟重响", "确认日期", "敲响旧钟"],
])
  scenes.push(
    await store.materials.save(book.id, {
      kind: "scene",
      title,
      status: "planned",
      chapterIds: [],
      notes: "合成资料",
      fields: {
        goal,
        obstacle: "渡船即将离港",
        choice,
        result: "得到新的线索",
        pov: "林舟",
        location: "码头",
        time: "雨夜",
      },
    }),
  );
for (let index = 1; index <= 2; index++)
  await store.planning.move(
    book.id,
    {
      sceneId: scenes[index].id,
      chapterId: book.chapters[index - 1].id,
      beforeId: null,
    },
    await store.planning.read(book.id),
  );
const original = await Promise.all(
  book.chapters.map((chapter) =>
    readFile(
      join(data, "library", book.id, "manuscript", `${chapter.id}.md`),
      "utf8",
    ),
  ),
);
const screenshots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-004",
  "planning",
);
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page, owned;
const hostRequest = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const report = { status: "running", checks: [], errors: [], viewports: [] };
const dialog = () =>
  page.getByRole("dialog", { name: "场景编排", exact: true });
const column = (title) =>
  dialog().getByRole("region", { name: `规划列：${title}`, exact: true });
const card = (title, parent = dialog()) =>
  parent.getByRole("article", { name: `场景：${title}`, exact: true });
async function launch() {
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  owned = await captureOwnedProcesses(application.process().pid);
  page = await application.firstWindow();
  const runtime = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  if (report.version) assert.equal(report.version, runtime.version);
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  const identity = createHash("sha256")
    .update(
      await readFile(
        runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
      ),
    )
    .digest("hex");
  report[runtime.packaged ? "appAsarSha256" : "desktopBundleSha256"] = identity;
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  await page.getByRole("button", { name: "场景编排", exact: true }).click();
  await card("寻找信使").waitFor();
}
async function close() {
  await application.close();
  await confirmOwnedProcessesExited(owned);
  application = null;
  owned = null;
}
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
async function refresh() {
  await dialog().getByRole("button", { name: "刷新规划", exact: true }).click();
}
try {
  await launch();
  // Playwright dispatches real pointer drag events; no synthetic DOM drop or IPC mutation.
  await card("寻找信使").dragTo(card("船边争执"));
  await card("寻找信使", column("抵达旧港")).waitFor();
  assert.deepEqual(
    await column("抵达旧港").locator(".scene-card h4").allTextContents(),
    ["寻找信使", "船边争执"],
  );
  await dialog().getByRole("button", { name: "章纲", exact: true }).click();
  await card("寻找信使").getByText("绕过市场", { exact: true }).waitFor();
  assert.deepEqual(
    await column("抵达旧港").locator(".scene-card h4").allTextContents(),
    ["寻找信使", "船边争执"],
  );
  await screenshot("outline-light.png");
  await card("寻找信使")
    .getByRole("button", { name: "下移", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="规划列：抵达旧港"] .scene-card h4')
        ?.textContent === "船边争执",
  );
  await dialog().getByRole("button", { name: "看板", exact: true }).click();
  await screenshot("board-light.png");
  report.checks.push(
    "actual pointer drag moves one scene across chapters before a neighbor; board and outline share the order and semantic fields; keyboard Enter reorders without changing manuscript",
  );

  await close();
  await launch();
  assert.deepEqual(
    await column("抵达旧港").locator(".scene-card h4").allTextContents(),
    ["船边争执", "寻找信使"],
  );
  const planningFile = join(data, "library", book.id, "planning.json"),
    raw = await readFile(planningFile, "utf8");
  await writeFile(planningFile, raw + "\n");
  await card("寻找信使")
    .getByRole("button", { name: "上移", exact: true })
    .click();
  await dialog().getByRole("alert").filter({ hasText: "外部编辑" }).waitFor();
  assert.equal(await readFile(planningFile, "utf8"), raw + "\n");
  await screenshot("external-conflict.png");
  await refresh();
  await dialog().getByRole("alert").waitFor({ state: "hidden" });

  book = await hostRequest("book.structure", {
    bookId: book.id,
    expectedRevision: book.revision,
    mutation: { type: "chapter-trash", chapterId: book.chapters[0].id },
  });
  await refresh();
  await column("抵达旧港")
    .getByText(/章节已删除/)
    .waitFor();
  await card("寻找信使")
    .getByRole("combobox")
    .selectOption(book.chapters[1].id);
  await card("寻找信使", column("未拆的信")).waitFor();
  const deleted = await hostRequest("materials.delete", {
    bookId: book.id,
    expected: scenes[2],
    deleted: true,
  });
  await refresh();
  await card("旧钟重响")
    .getByText(/场景已删除/)
    .waitFor();
  await hostRequest("materials.delete", {
    bookId: book.id,
    expected: deleted,
    deleted: false,
  });
  await refresh();
  await card("旧钟重响")
    .getByRole("button", { name: "编辑场景完整资料" })
    .waitFor();
  report.checks.push(
    "real restart retains order; external same-revision edit blocks stale move without overwrite; deleted chapter remains visible and scene can be reassigned; deleted scene restores at its original position",
  );

  await card("寻找信使")
    .getByRole("button", { name: "编辑场景完整资料" })
    .click();
  const materials = page.getByRole("region", { name: "创作资料", exact: true });
  await materials.getByLabel("资料标题", { exact: true }).waitFor();
  assert.equal(
    await materials.getByLabel("资料标题", { exact: true }).inputValue(),
    "寻找信使",
  );
  await materials
    .getByLabel("人物选择", { exact: true })
    .fill("改走桥下的暗道");
  await materials
    .getByRole("button", { name: "保存资料", exact: true })
    .click();
  await materials
    .getByRole("status")
    .filter({ hasText: "已保存资料" })
    .waitFor();
  const drawerClose = page.getByLabel("关闭创作参考", { exact: true });
  if (await drawerClose.isVisible()) await drawerClose.click();
  await page.getByTitle("深色主题", { exact: true }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await page.getByRole("button", { name: "场景编排", exact: true }).click();
  await dialog().getByRole("button", { name: "章纲", exact: true }).click();
  await dialog()
    .getByLabel("显示规划章节", { exact: true })
    .selectOption(book.chapters[1].id);
  await card("寻找信使").getByText("改走桥下的暗道", { exact: true }).waitFor();
  await card("寻找信使").scrollIntoViewIfNeeded();
  await screenshot("outline-dark-narrow.png");
  const bounds = await dialog().boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await column("未拆的信")
    .getByRole("button", { name: "打开本章正文", exact: true })
    .click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(
    await page.getByLabel("章节标题", { exact: true }).inputValue(),
    "未拆的信",
  );
  assert.deepEqual(
    await Promise.all(
      book.chapters.map((chapter) =>
        readFile(
          join(data, "library", book.id, "manuscript", `${chapter.id}.md`),
          "utf8",
        ),
      ),
    ),
    original,
  );
  // Stop the actual host before the offline backup/restore fixture uses its own kernel.
  await close();
  const backup = await store.createBackup(book.id, join(data, "backup")),
    restored = await store.restoreBackup(backup.path);
  assert.deepEqual(
    await store.planning.read(restored.id),
    await store.planning.read(book.id),
  );
  report.checks.push(
    "open original scene form and edit choice; refreshed outline shows same field; dark narrow viewport supports chapter filtering and exact chapter navigation; backup restores placement under new book identity; manuscript bytes unchanged",
  );
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
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else await close();
    }
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(screenshots, "planning-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
