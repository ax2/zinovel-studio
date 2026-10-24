import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache/maps-ui-")),
  data = join(work, "data"),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("地图界面验收", [
  { title: "雾港来信", body: "进入地图前的原稿。𠮷🌊" },
]);
const location = await store.materials.save(book.id, {
  kind: "location",
  title: "雾港地点设定",
  notes: "合成地点资料",
  status: "planned",
  fields: {},
  chapterIds: [],
});
const background = await sharp({
  create: { width: 2400, height: 1600, channels: 3, background: "#f2ead6" },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="2400" height="1600"><path fill="#a3c6d0" d="M1400 0H2400V1600H1200Q1800 1100 1300 700T1400 0"/><path fill="#c8d3ab" d="M0 0H900L1100 300 700 900 0 1100Z"/></svg>',
      ),
    },
  ])
  .png()
  .toBuffer();
const source = join(work, "中文 空格 地图.png");
await writeFile(source, background);
const asset = await store.assets.import(book.id, background, {
  title: "合成雾港底图",
  purpose: "map",
  source: "程序合成底图",
  rights: "本地验收，无真人素材",
  notes: "非小说成品美术",
  linkedIds: [],
});
const manuscript = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  output = join(
    root,
    "screenshots",
    process.env.ZINOVEL_QA_STAGE || "stage-006",
    "maps-ui",
  );
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope:
    "Real author map UI and host persistence; native folder selection for backup/restore is instrumented, no native IME or physical phone claim",
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
      delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned, mapId;
const panel = () =>
  page.getByRole("dialog", { name: "小说世界地图", exact: true });
const svg = () =>
  panel().getByRole("group", { name: "世界地图画布", exact: true });
const notices = () => panel().locator(".maps-notices");
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const currentMap = () => request("maps.read", { bookId: book.id, id: mapId });
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
  await page.getByLabel("正文编辑器").waitFor();
}
async function open() {
  await page.getByRole("button", { name: "世界地图", exact: true }).click();
  await panel().waitFor();
  const toggle = panel().getByRole("button", {
    name: "展开地图与对象目录",
    exact: true,
  });
  const narrow = await toggle.isVisible();
  if (narrow) await toggle.click();
  if (mapId)
    await panel()
      .locator(".map-catalog .asset-list button")
      .filter({ hasText: "雾港世界" })
      .click();
  await (
    mapId
      ? svg()
      : panel().getByRole("button", { name: "新建地图", exact: true })
  ).waitFor();
  if (narrow)
    await panel()
      .getByRole("button", { name: "收起地图与对象目录", exact: true })
      .click();
}
async function closeApp() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
async function saveMap() {
  await panel().getByRole("button", { name: "保存地图", exact: true }).click();
  await notices()
    .getByRole("status")
    .filter({ hasText: "地图已保存" })
    .waitFor();
}
async function at(x, y) {
  await svg().scrollIntoViewIfNeeded();
  const point = await svg().evaluate(
    (node, p) => {
      const value = node.createSVGPoint(),
        frame = node.viewBox.baseVal;
      value.x = p.x * frame.width;
      value.y = p.y * frame.height;
      const result = value.matrixTransform(
        node.querySelector("[data-map-world]").getScreenCTM(),
      );
      return { x: result.x, y: result.y };
    },
    { x, y },
  );
  await page.mouse.click(point.x, point.y);
}
async function shot(name) {
  assert.equal(
    await panel().evaluate((node) => node.scrollWidth > node.clientWidth + 1),
    false,
  );
  await page.screenshot({ path: join(output, name) });
  report.viewports.push({
    name,
    ...(await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))),
  });
}
try {
  await launch();
  const formalBody = "未保存正文进入地图时先保存。𠮷🌊\n第二行保持原样。";
  await page.getByLabel("正文编辑器", { exact: true }).fill(formalBody);
  await open();
  assert.equal(await readFile(manuscript, "utf8"), formalBody);
  await panel().getByRole("button", { name: "新建地图", exact: true }).click();
  await svg().waitFor();
  mapId = (await request("maps.list", { bookId: book.id })).items[0].id;
  await panel().locator(".map-metadata > summary").click();
  await panel()
    .getByLabel("地图标题", { exact: true })
    .fill("雾港世界 · 河历三年𠮷🌊");
  await panel()
    .getByLabel("地图年代标签", { exact: true })
    .fill("河历三年，非自动推演");
  await panel().getByLabel("地图标题", { exact: true }).press("Control+s");
  await notices()
    .getByRole("status")
    .filter({ hasText: "地图已保存" })
    .waitFor();
  await panel().locator(".map-metadata > summary").click();
  await panel()
    .getByRole("button", { name: "图上添加地点", exact: true })
    .click();
  await at(0.2, 0.3);
  await panel().getByLabel("地图对象名称", { exact: true }).fill("雾港");
  await panel()
    .getByRole("button", { name: "表单添加地点", exact: true })
    .click();
  await panel().getByLabel("地图对象名称", { exact: true }).fill("石桥");
  await panel().getByLabel("地图对象坐标", { exact: true }).fill("80,65");
  await saveMap();
  let saved = await currentMap(),
    a = saved.elements.find((e) => e.title === "雾港"),
    b = saved.elements.find((e) => e.title === "石桥");
  assert.ok(a && b);
  assert.equal(b.point.x, 0.8);
  assert.equal(b.point.y, 0.65);
  await panel()
    .locator(".map-catalog .asset-list button")
    .filter({ hasText: "雾港" })
    .click();
  await panel().getByText("关联本书地点资料", { exact: true }).click();
  await panel()
    .getByRole("button", { name: location.title, exact: true })
    .click();
  await saveMap();
  await panel().getByRole("button", { name: "绘制区域", exact: true }).click();
  await panel().getByLabel("地图对象名称", { exact: true }).fill("旧城湾");
  await at(0.1, 0.1);
  await at(0.5, 0.1);
  await at(0.45, 0.45);
  await panel()
    .getByRole("button", { name: "结束区域绘制", exact: true })
    .click();
  const region = svg().locator(".map-region.selected"),
    regionBefore = await region.getAttribute("points"),
    vertex = svg().locator('[data-map-vertex="2"]');
  await vertex.scrollIntoViewIfNeeded();
  const box = await vertex.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 12,
    { steps: 5 },
  );
  await page.mouse.up();
  assert.notEqual(await region.getAttribute("points"), regionBefore);
  await panel()
    .getByRole("button", { name: "撤销未保存调整", exact: true })
    .click();
  assert.equal(await region.getAttribute("points"), regionBefore);
  await panel().getByRole("button", { name: "新建路线", exact: true }).click();
  await panel().getByLabel("地图对象名称", { exact: true }).fill("渡口旧路");
  await panel()
    .getByLabel("路线行程说明", { exact: true })
    .fill("夜航风险由作者记录，不自动推断耗时。");
  await panel()
    .getByLabel("地图对象坐标", { exact: true })
    .fill("40,30\n70,50");
  await saveMap();
  saved = await currentMap();
  assert.equal(saved.elements.length, 4);
  assert.equal(
    saved.elements.find((e) => e.id === a.id).locationId,
    location.id,
  );
  assert.equal(saved.elements.find((e) => e.kind === "route").via.length, 2);
  await panel().locator(".map-scale > summary").click();
  await panel().getByLabel("比例尺起点", { exact: true }).fill("0,0");
  await panel().getByLabel("比例尺终点", { exact: true }).fill("100,0");
  await panel().getByLabel("比例尺距离", { exact: true }).fill("100");
  await panel().getByLabel("比例尺单位", { exact: true }).fill("里");
  await panel()
    .getByRole("button", { name: "应用作者比例尺", exact: true })
    .click();
  await panel()
    .locator(".map-object-form")
    .getByText(/按作者比例尺/)
    .waitFor();
  await saveMap();
  await panel().locator(".map-scale > summary").click();
  await panel()
    .locator("summary")
    .filter({ hasText: /^冻结地图底图/ })
    .click();
  await panel()
    .getByRole("button", { name: /合成雾港底图/ })
    .click();
  await svg().locator('image[data-map-image-state="ready"]').waitFor();
  saved = await currentMap();
  assert.equal(saved.background.record.blob.sha256, asset.blob.sha256);
  assert.equal(saved.scale, null);
  await panel()
    .locator("summary")
    .filter({ hasText: /^冻结地图底图/ })
    .click();
  await svg().scrollIntoViewIfNeeded();
  await shot("map-desktop.png");
  report.checks.push(
    "actual map controls create two stable places by pointer/form, same-book location association, three-vertex region, real vertex drag and undo, routed bends and author calibration; Ctrl+S/save applies raw coordinates; explicit background selection freezes bytes and clears prior scale; manuscript unchanged after entry flush",
  );
  await panel()
    .locator(".map-catalog .asset-list button")
    .filter({ hasText: "石桥" })
    .click();
  await panel().getByLabel("地图对象坐标", { exact: true }).fill("80,");
  await panel().getByRole("button", { name: "关闭地图", exact: true }).click();
  await open();
  assert.equal(
    await panel().getByLabel("地图对象坐标", { exact: true }).inputValue(),
    "80,",
  );
  await closeApp();
  await launch();
  await open();
  assert.equal(
    await panel().getByLabel("地图对象坐标", { exact: true }).inputValue(),
    "80,",
  );
  await page.evaluate(() => {
    globalThis.mapUiOriginalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("zinovel.map-draft."))
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return globalThis.mapUiOriginalSet.call(this, key, value);
    };
  });
  await panel().getByLabel("地图对象坐标", { exact: true }).fill("82,");
  await panel().getByRole("button", { name: "关闭地图", exact: true }).click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /本机地图草稿暂不能保存/ })
    .waitFor();
  assert.equal(await panel().isVisible(), true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await notices()
    .getByRole("alert")
    .filter({ hasText: /本机地图草稿暂不能保存/ })
    .waitFor();
  assert.equal(
    await panel().getByLabel("地图对象坐标", { exact: true }).inputValue(),
    "82,",
  );
  await shot("map-quota-protected.png");
  await panel().getByLabel("地图对象坐标", { exact: true }).fill("82,66");
  await saveMap();
  await page.evaluate(() => {
    Storage.prototype.setItem = globalThis.mapUiOriginalSet;
  });
  saved = await currentMap();
  assert.equal(saved.elements.find((e) => e.id === b.id).point.x, 0.82);
  report.checks.push(
    "unfinished coordinate input survives modal close and full Electron restart; synthetic localStorage quota blocks modal and native window close without losing raw input; completing coordinates and explicitly saving still writes the formal map and clears the close guard",
  );
  const preConflict = saved;
  await panel().locator(".map-metadata > summary").click();
  await panel()
    .getByLabel("地图标题", { exact: true })
    .fill("雾港世界 · 本机调整待对照");
  const mapFile = join(data, "library", book.id, "world/maps", mapId + ".json");
  const external = JSON.parse(await readFile(mapFile, "utf8"));
  external.notes = "外部同修订编辑，必须保留真实前像";
  const externalRaw = JSON.stringify(external, null, 2) + "\n";
  await writeFile(mapFile, externalRaw);
  await panel().getByRole("button", { name: "保存地图", exact: true }).click();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /地图已被其他/ })
    .waitFor();
  assert.equal(await readFile(mapFile, "utf8"), externalRaw);
  assert.equal(
    await panel().getByLabel("地图标题", { exact: true }).inputValue(),
    "雾港世界 · 本机调整待对照",
  );
  await panel()
    .getByRole("button", { name: "读取磁盘地图供对照", exact: true })
    .click();
  await panel().locator("pre").filter({ hasText: external.notes }).waitFor();
  await panel()
    .getByRole("button", { name: "保留调整并采用磁盘地图基线", exact: true })
    .click();
  await saveMap();
  const conflictSaved = await currentMap();
  assert.equal(conflictSaved.title, "雾港世界 · 本机调整待对照");
  const history = await request("maps.history", { bookId: book.id, id: mapId });
  const previous = history.items.find(
    (item) => item.revision === preConflict.revision,
  );
  assert.equal(previous.notes, external.notes);
  await panel().locator(".map-history > summary").click();
  await panel()
    .getByRole("button", {
      name: `查看地图第${previous.revision}版 · ${previous.title}`,
      exact: true,
    })
    .click();
  await panel()
    .getByRole("button", { name: "采用此历史地图为新版本", exact: true })
    .waitFor();
  await svg().locator('image[data-map-image-state="ready"]').waitFor();
  await panel()
    .getByRole("button", { name: "采用此历史地图为新版本", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /新版本已保存/ })
    .waitFor();
  saved = await currentMap();
  assert.equal(saved.revision, conflictSaved.revision + 1);
  assert.equal(saved.notes, external.notes);
  assert.equal(saved.title, previous.title);
  await panel()
    .locator(".map-catalog .asset-list button")
    .filter({ hasText: "石桥" })
    .click();
  await svg().locator(`[data-map-element="${b.id}"]`).press("Enter");
  await svg().locator(`[data-map-element="${b.id}"]`).press("ArrowRight");
  assert.equal(
    await panel().getByLabel("地图对象坐标", { exact: true }).inputValue(),
    "83,66",
  );
  await panel()
    .getByRole("button", { name: "撤销未保存调整", exact: true })
    .click();
  assert.equal(
    await panel().getByLabel("地图对象坐标", { exact: true }).inputValue(),
    "82,66",
  );
  const beforeView = await readFile(mapFile, "utf8");
  await panel().getByLabel("地图缩放", { exact: true }).fill("2");
  await svg().press("+");
  await panel().getByRole("button", { name: "适合地图", exact: true }).click();
  assert.equal(await readFile(mapFile, "utf8"), beforeView);
  report.checks.push(
    "same-revision external edits reject stale saves and retain disk bytes/local input; author explicitly compares and adopts the baseline; exact external preimage survives in history; actual read-only historical background loads and author adopts it as a new revision; keyboard point movement/undo and view-only zoom do not silently write the map",
  );
  await page.setViewportSize({ width: 806, height: 803 });
  await svg().scrollIntoViewIfNeeded();
  await shot("map-narrow.png");
  await panel().getByRole("button", { name: "关闭地图", exact: true }).click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await open();
  await svg().locator('image[data-map-image-state="ready"]').waitFor();
  await svg().scrollIntoViewIfNeeded();
  await shot("map-dark-narrow.png");
  await panel()
    .getByRole("button", { name: "展开地图与对象目录", exact: true })
    .click();
  await panel()
    .locator(".map-catalog .asset-list button")
    .filter({ hasText: "石桥" })
    .click();
  await panel().getByLabel("地图对象坐标", { exact: true }).fill("未完成坐标");
  const backups = join(work, "中文 空格 备份");
  await mkdir(backups);
  await app.evaluate(({ dialog }, path) => {
    globalThis.mapUiDialog = dialog.showOpenDialog;
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
    dialog.showOpenDialog = globalThis.mapUiDialog;
  });
  const restoredMap = await request("maps.read", {
    bookId: restored.book.id,
    id: mapId,
  });
  assert.equal(restoredMap.elements.find((e) => e.id === b.id).point.x, 0.82);
  assert.equal(restoredMap.background.record.blob.sha256, asset.blob.sha256);
  assert.match(
    (
      await request("maps.preview", {
        bookId: restored.book.id,
        expected: restoredMap,
      })
    ).dataUrl,
    /^data:image\/png;base64,/,
  );
  assert.notEqual(restored.book.id, book.id);
  await panel().getByRole("button", { name: "关闭地图", exact: true }).click();
  const draftKey = `zinovel.map-draft.${book.id}.${mapId}`;
  const futureDraft = JSON.stringify({
    schemaVersion: 99,
    synthetic: "保留未知草稿𠮷🌊",
  });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: draftKey,
    value: futureDraft,
  });
  await open();
  await notices()
    .getByRole("alert")
    .filter({ hasText: /草稿无法识别/ })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    futureDraft,
  );
  assert.equal(
    await panel()
      .getByRole("button", { name: "保存地图", exact: true })
      .isDisabled(),
    true,
  );
  await panel()
    .getByRole("button", { name: "放弃本机地图草稿并重读", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /已明确放弃/ })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    null,
  );
  await panel()
    .getByRole("button", { name: "回收这张地图", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "恢复这张地图", exact: true })
    .waitFor();
  const retired = await currentMap();
  assert.ok(retired.deletedAt);
  await panel()
    .getByRole("button", { name: "恢复这张地图", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /地图新版本已保存/ })
    .waitFor();
  saved = await currentMap();
  assert.equal(saved.deletedAt, undefined);
  assert.equal(saved.revision, retired.revision + 1);
  await panel().getByRole("button", { name: "关闭地图", exact: true }).click();
  const intentKey = `zinovel.map-create.${book.id}`;
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    {
      key: intentKey,
      value: {
        schemaVersion: 1,
        bookId: book.id,
        id: mapId,
        input: {
          title: "新地图",
          notes: "",
          era: "",
          canvas: { width: 1000, height: 700 },
          scale: null,
          elements: [],
        },
      },
    },
  );
  await open();
  await panel()
    .getByRole("button", { name: "检查这次地图创建", exact: true })
    .click();
  await notices()
    .getByRole("status")
    .filter({ hasText: /地图已在当前作品中保存/ })
    .waitFor();
  assert.equal((await currentMap()).revision, saved.revision);
  assert.equal((await request("maps.list", { bookId: book.id })).total, 1);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), intentKey),
    null,
  );
  report.checks.push(
    "future local draft remains byte-identical and read-only until explicit discard; map recycle and restore preserve identity; a synthetic checkpoint representing an already committed creation with an unconfirmed result reconciles the later revision without duplicate or rewind; not a simulated IPC transport loss",
  );
  assert.equal(await readFile(manuscript, "utf8"), formalBody);
  assert.deepEqual(await readFile(source), background);
  await closeApp();
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "desktop and 806px dark/narrow map render without dialog overflow; actual host backup/restore to a new book preserves saved map IDs, original image and frozen background while excluding unfinished local coordinate input; folder chooser results are instrumented",
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
    join(output, "maps-ui-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
