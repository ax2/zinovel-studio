import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache/atlas-ui-")),
  data = join(work, "data"),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("地图册界面验收", [
  { title: "雾港旧信", body: "地图册不改变原稿。𠮷🌊" },
]);
const point = (title) => ({
  id: randomUUID(),
  kind: "place",
  title,
  notes: "",
  point: { x: 0.3, y: 0.4 },
  locationId: null,
});
const gate = point("雾港城门"),
  door = point("旅馆门口");
const map = (title, elements = []) =>
  store.maps.create(book.id, {
    title,
    notes: "",
    era: "作者标签",
    canvas: { width: 1000, height: 700 },
    scale: null,
    elements,
  });
const world = await map("世界全图", [gate]),
  city = await map("雾港城市图", [door]),
  room = await map("旅馆室内图");
const originals = new Map();
for (const record of [world, city, room]) {
  const file = join(
    data,
    "library",
    book.id,
    "world/maps",
    record.id + ".json",
  );
  originals.set(file, await readFile(file));
}
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  bodyBefore = await readFile(manuscript);
const output = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-006",
  "atlas-ui",
);
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Real author atlas controls, navigation, modal/host close guards, actual file persistence and restart; backup/restore folder selection is instrumented; no native IME or physical phone claim",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const panel = () =>
    page.getByRole("dialog", { name: "地图年代与层级", exact: true }),
  maps = () => page.getByRole("dialog", { name: "小说世界地图", exact: true }),
  notices = () => panel().locator(".atlas-notices");
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const current = () => request("atlas.read", { bookId: book.id });
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      report.errors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("Unexpected page HTTP request");
  });
  await page.waitForURL(/\/workbench\/index\.html$/);
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器", { exact: true }).waitFor();
}
async function openMaps() {
  await page.getByRole("button", { name: "世界地图", exact: true }).click();
  await maps().waitFor();
  const toggle = maps().getByRole("button", {
    name: "展开地图与对象目录",
    exact: true,
  });
  const narrow = await toggle.isVisible();
  if (narrow) await toggle.click();
  await maps()
    .locator(".map-catalog .asset-list button")
    .filter({ hasText: "世界全图" })
    .click();
  if (narrow)
    await maps()
      .getByRole("button", { name: "收起地图与对象目录", exact: true })
      .click();
}
async function openAtlas() {
  await maps().getByRole("button", { name: "年代与层级", exact: true }).click();
  await panel().getByLabel("地图册说明", { exact: true }).waitFor();
  await panel()
    .getByText("正在读取地图册…", { exact: true })
    .waitFor({ state: "hidden" });
}
async function closeApp() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
async function details(selector) {
  const element = panel().locator(selector);
  if ((await element.getAttribute("open")) === null)
    await element.locator(":scope > summary").click();
  return element;
}
async function choose(label, title) {
  const picker = await details(
    `details.atlas-map-picker[aria-label="${label}"]`,
  );
  await picker.getByRole("button", { name: new RegExp(`^${title} ·`) }).click();
}
async function save() {
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /地图册已保存/ })
    .waitFor();
}
async function shot(name, theme) {
  assert.equal(
    await panel().evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1,
    ),
    false,
  );
  await page.screenshot({ path: join(output, name) });
  report.viewports.push({
    name,
    theme,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
    }))),
    mapView: "independent saved frames; atlas does not scale map coordinates",
  });
}
try {
  await launch();
  await openMaps();
  await openAtlas();
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("世界、城市和室内图独立保存，作者明确组织。𠮷🌊");
  await panel()
    .getByRole("button", { name: "加入地图册", exact: true })
    .click();
  await details(".atlas-epochs");
  await panel()
    .getByRole("button", { name: "新建年代组", exact: true })
    .click();
  await panel().getByLabel("年代组名称 1", { exact: true }).fill("河历三年");
  await panel()
    .getByRole("button", { name: "新建年代组", exact: true })
    .click();
  await panel().getByLabel("年代组名称 2", { exact: true }).fill("河历元年");
  await panel()
    .getByRole("button", { name: "上移年代组 2", exact: true })
    .click();
  assert.equal(
    await panel().getByLabel("年代组名称 1", { exact: true }).inputValue(),
    "河历元年",
  );
  await panel()
    .getByRole("button", { name: "下移年代组 1", exact: true })
    .click();
  await panel()
    .getByLabel("目录地图年代组", { exact: true })
    .selectOption({ label: "河历元年" });
  await panel().getByLabel("地图册说明", { exact: true }).press("Control+s");
  await notices()
    .getByRole("status")
    .filter({ hasText: /地图册已保存/ })
    .waitFor();
  let saved = await current();
  assert.deepEqual(
    saved.epochs.map((epoch) => epoch.title),
    ["河历三年", "河历元年"],
  );
  const firstEpoch = saved.epochs[0].id;
  assert.equal(
    await panel()
      .getByRole("button", { name: "删除年代组 2", exact: true })
      .isDisabled(),
    true,
  );
  await choose("选择目录地图", "雾港城市图");
  await panel()
    .getByRole("button", { name: "加入地图册", exact: true })
    .click();
  await panel()
    .getByLabel("目录地图年代组", { exact: true })
    .selectOption(firstEpoch);
  await choose("选择父图", "世界全图");
  await panel()
    .getByLabel("目录位置说明", { exact: true })
    .fill("从城门进入城市，待补父图锚点。𠮷🌊");
  await panel().getByLabel("年代组名称 2", { exact: true }).fill("");
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /文字为空/ })
    .waitFor();
  assert.equal((await current()).revision, saved.revision);
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  await closeApp();
  await launch();
  await openMaps();
  await openAtlas();
  await details(".atlas-epochs");
  assert.equal(
    await panel().getByLabel("年代组名称 2", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await panel().getByLabel("父图锚点", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await panel().getByLabel("目录位置说明", { exact: true }).inputValue(),
    "从城门进入城市，待补父图锚点。𠮷🌊",
  );
  await panel().getByLabel("年代组名称 2", { exact: true }).fill("河历元年");
  await panel().getByLabel("父图锚点", { exact: true }).selectOption(gate.id);
  await save();
  await choose("选择目录地图", "旅馆室内图");
  await panel()
    .getByRole("button", { name: "加入地图册", exact: true })
    .click();
  await panel()
    .getByLabel("目录地图年代组", { exact: true })
    .selectOption(firstEpoch);
  await choose("选择父图", "雾港城市图");
  await panel().getByLabel("父图锚点", { exact: true }).selectOption(door.id);
  await save();
  saved = await current();
  assert.equal(saved.entries.length, 3);
  assert.equal(
    saved.entries.find((entry) => entry.mapId === room.id).parentId,
    city.id,
  );
  await panel()
    .getByLabel("目录年代组筛选", { exact: true })
    .selectOption(firstEpoch);
  await panel()
    .locator(".atlas-directory")
    .getByText("2项 · 每页40项", { exact: true })
    .waitFor();
  await panel().getByRole("button", { name: "打开父图", exact: true }).click();
  await maps()
    .getByRole("heading", { name: "雾港城市图", exact: true })
    .waitFor();
  await openAtlas();
  await panel().getByRole("button", { name: "打开父图", exact: true }).click();
  await maps()
    .getByRole("heading", { name: "世界全图", exact: true })
    .waitFor();
  await openAtlas();
  await panel()
    .getByLabel("目录层级筛选", { exact: true })
    .selectOption("children");
  const beforeCycle = await current();
  await choose("选择父图", "雾港城市图");
  await panel().getByLabel("父图锚点", { exact: true }).selectOption(door.id);
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /层级不能循环/ })
    .waitFor();
  assert.equal((await current()).diskHash, beforeCycle.diskHash);
  assert.equal(
    await panel().getByLabel("父图锚点", { exact: true }).inputValue(),
    door.id,
  );
  await panel()
    .getByRole("button", { name: "解除父图关系", exact: true })
    .click();
  await save();
  assert.equal((await current()).revision, beforeCycle.revision);
  assert.equal(
    await panel()
      .getByRole("button", { name: "从目录移除此地图", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .locator(".atlas-directory")
    .getByText("1项 · 每页40项", { exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "打开地图 · 雾港城市图", exact: true })
    .click();
  await maps()
    .getByRole("heading", { name: "雾港城市图", exact: true })
    .waitFor();
  await openAtlas();
  await panel().getByLabel("目录层级筛选", { exact: true }).selectOption("all");
  await shot("atlas-desktop.png", "light");
  report.checks.push(
    "actual author controls create manual epoch order and world/city/interior hierarchy with explicit parent anchors; empty epoch name and half-selected anchor reject formal save yet survive modal close and full Electron restart; completing and saving works; filtered directory and open-parent controls navigate exact maps without changing their graph bytes",
  );
  await page.evaluate(() => {
    globalThis.atlasSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("zinovel.atlas-draft."))
        throw new DOMException("synthetic atlas quota", "QuotaExceededError");
      return globalThis.atlasSet.call(this, key, value);
    };
  });
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("配额失败时仍保留的作者说明。𠮷🌊");
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /草稿暂不能保存/ })
    .waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  assert.equal(await panel().isVisible(), true);
  assert.equal(
    await panel().getByLabel("地图册说明", { exact: true }).inputValue(),
    "配额失败时仍保留的作者说明。𠮷🌊",
  );
  await shot("atlas-quota-protected.png", "light");
  await save();
  await page.evaluate(() => {
    Storage.prototype.setItem = globalThis.atlasSet;
  });
  saved = await current();
  const beforeConflict = saved,
    atlasFile = join(data, "library", book.id, "world/map-atlas.json"),
    external = JSON.parse(await readFile(atlasFile, "utf8"));
  external.notes = "真实外部同修订目录说明";
  const externalRaw = JSON.stringify(external, null, 2) + "\n";
  await writeFile(atlasFile, externalRaw);
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("本机目录输入待明确对照");
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /其他操作修改/ })
    .waitFor();
  assert.equal(await readFile(atlasFile, "utf8"), externalRaw);
  await panel()
    .getByRole("button", { name: "读取磁盘目录供对照", exact: true })
    .click();
  await panel()
    .locator(".atlas-comparison")
    .getByText(external.notes, { exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "保留调整并采用磁盘目录基线", exact: true })
    .click();
  await save();
  const afterConflict = await current(),
    history = await request("atlas.history", { bookId: book.id });
  const old = history.items.find(
    (item) => item.revision === beforeConflict.revision,
  );
  assert.equal(old.notes, external.notes);
  await details(".atlas-history");
  await panel()
    .getByRole("button", {
      name: `查看地图册第${old.revision}版 · 2年代组 / 3地图`,
      exact: true,
    })
    .click();
  await panel()
    .locator(".atlas-directory")
    .getByRole("heading", {
      name: `历史目录 · 第${old.revision}版`,
      exact: true,
    })
    .waitFor();
  await panel()
    .getByRole("button", { name: "采用此历史目录为新版本", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /历史目录已采用/ })
    .waitFor();
  saved = await current();
  assert.equal(saved.revision, afterConflict.revision + 1);
  assert.equal(saved.notes, external.notes);
  report.checks.push(
    "synthetic atlas storage quota blocks modal/native window close without losing inputs; explicit formal save still works; actual same-revision external file change rejects stale save, readable comparison and explicit baseline retain true preimage history; read-only history adoption creates a new revision without replacing map geometry",
  );
  const revisionBeforeCleanup = saved.revision;
  await page.evaluate(() => {
    globalThis.atlasRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (String(key).startsWith("zinovel.atlas-draft."))
        throw new DOMException("synthetic cleanup", "SecurityError");
      return globalThis.atlasRemove.call(this, key);
    };
  });
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("正式保存后清理失败的说明");
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /本机草稿尚未清理/ })
    .waitFor();
  assert.equal((await current()).revision, revisionBeforeCleanup + 1);
  assert.equal(
    await panel()
      .getByRole("button", { name: "保存地图册", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  assert.equal(await panel().isVisible(), true);
  await page.evaluate(() => {
    Storage.prototype.removeItem = globalThis.atlasRemove;
  });
  await panel()
    .getByRole("button", { name: "重试清理地图册草稿", exact: true })
    .click();
  assert.equal((await current()).revision, revisionBeforeCleanup + 1);
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  const draftKey = `zinovel.atlas-draft.${book.id}`,
    future = JSON.stringify({
      schemaVersion: 99,
      synthetic: "保留未来地图册草稿𠮷",
    });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: draftKey,
    value: future,
  });
  await openAtlas();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /草稿无法识别/ })
    .waitFor();
  assert.equal(
    await panel().getByLabel("地图册说明", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  await closeApp();
  await launch();
  await openMaps();
  await openAtlas();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await panel()
    .getByRole("button", { name: "放弃本机地图册草稿并重读", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /已明确放弃/ })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  report.checks.push(
    "formal atlas save with synthetic local cleanup failure blocks duplicate saving/close until retry; cleanup retry does not create another revision; future local schema remains byte-identical and read-only across modal reopen until explicit discard",
  );
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("当前作者窗口待保存的说明");
  await page.waitForFunction(
    (key) => localStorage.getItem(key)?.includes("当前作者窗口待保存的说明"),
    draftKey,
  );
  const competing = await page.evaluate((key) => {
    const draft = JSON.parse(localStorage.getItem(key));
    draft.input.notes = "另一份本机目录草稿";
    const raw = JSON.stringify(draft);
    localStorage.setItem(key, raw);
    return raw;
  }, draftKey);
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /本机另一份草稿仍保留/ })
    .waitFor();
  assert.equal((await current()).notes, "当前作者窗口待保存的说明");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    competing,
  );
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  await openAtlas();
  assert.equal(
    await panel().getByLabel("地图册说明", { exact: true }).inputValue(),
    "另一份本机目录草稿",
  );
  await panel()
    .getByRole("button", { name: "保存地图册", exact: true })
    .click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /基线已过期/ })
    .waitFor();
  await panel()
    .getByRole("button", { name: "读取磁盘目录供对照", exact: true })
    .click();
  await panel()
    .locator(".atlas-comparison")
    .getByText("当前作者窗口待保存的说明", { exact: true })
    .waitFor();
  await panel()
    .getByRole("button", { name: "保留调整并采用磁盘目录基线", exact: true })
    .click();
  await save();
  assert.equal((await current()).notes, "另一份本机目录草稿");
  assert.ok(
    (await request("atlas.history", { bookId: book.id })).items.some(
      (record) => record.notes === "当前作者窗口待保存的说明",
    ),
  );
  report.checks.push(
    "synthetic competing local cache is retained while the current author explicitly saves formal data; reopen restores the competing draft without silently rebasing, stale baseline blocks save until readable comparison and explicit adoption; both author versions remain in saved history",
  );
  await page.setViewportSize({ width: 806, height: 803 });
  await shot("atlas-narrow.png", "light");
  await panel()
    .getByRole("button", { name: "关闭地图册", exact: true })
    .click();
  await maps().getByRole("button", { name: "关闭地图", exact: true }).click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await openMaps();
  await openAtlas();
  await shot("atlas-dark-narrow.png", "dark");
  await panel()
    .getByRole("button", { name: "展开地图目录", exact: true })
    .click();
  await shot("atlas-dark-narrow-directory.png", "dark");
  await panel()
    .getByRole("button", { name: "打开地图 · 旅馆室内图", exact: true })
    .click();
  await maps()
    .getByRole("heading", { name: "旅馆室内图", exact: true })
    .waitFor();
  await openAtlas();
  assert.equal(
    await panel().getByLabel("目录地图年代组", { exact: true }).inputValue(),
    firstEpoch,
  );
  const savedBeforeBackup = await current();
  await panel()
    .getByLabel("地图册说明", { exact: true })
    .fill("本机未保存目录说明，不进入备份");
  const backups = join(work, "中文 空格 备份");
  await mkdir(backups);
  await app.evaluate(({ dialog }, path) => {
    globalThis.atlasDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backups);
  const backup = await request("book.backup", { bookId: book.id });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backup.path);
  const restored = await request("library.restore", {});
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.atlasDialog;
  });
  const restoredAtlas = await request("atlas.read", {
      bookId: restored.book.id,
    }),
    restoredRows = await request("atlas.inspect", { bookId: restored.book.id });
  assert.notEqual(restored.book.id, book.id);
  assert.equal(restoredAtlas.notes, savedBeforeBackup.notes);
  assert.equal(restoredRows.rows.length, 3);
  assert.equal(
    restoredRows.rows.find((row) => row.entry.mapId === room.id).anchorState,
    "ready",
  );
  for (const [file, before] of originals)
    assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(manuscript), bodyBefore);
  assert.deepEqual(report.errors, []);
  await closeApp();
  report.checks.push(
    "desktop and 806px light/dark atlas render without horizontal dialog overflow; actual whole-book backup/restore retains saved epochs and three-level references under source lineage, excludes unsaved local notes; original three map files and formal manuscript remain exact, zero renderer errors/HTTP; native folder results are instrumented",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (app?.process()?.exitCode === null) {
    if (report.status === "failed") await terminateOwnedProcesses(owned);
    else await closeApp();
  }
  await writeFile(
    join(output, "atlas-ui-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
