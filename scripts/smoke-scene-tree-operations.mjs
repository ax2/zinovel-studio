import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "tree-operations-")),
  store = new NovelStore(join(data, "library"));
let book = await store.importBook("树内移动合成验收", [
  { title: "第一章", body: "手工原稿𠮷🌊\r\n只移动计划。", volume: "卷一" },
  { title: "第二章", body: "另一卷完整原稿。", volume: "卷二" },
  { title: "回收章", body: "回收章原稿仍保存。", volume: "卷二" },
]);
const names = ["甲场·桥畔", "乙场·旧信", "丙场·暗灯", "丁场·远海", "戊场·失联"];
const scenes = [];
for (const title of names)
  scenes.push(
    await store.materials.save(book.id, {
      kind: "scene",
      title,
      status: "planned",
      fields: { goal: "找到送信人" },
      notes: "合成计划",
      chapterIds: [],
    }),
  );
book = await store.updateStructure(book.id, book.revision, {
  type: "chapter-trash",
  chapterId: book.chapters[2].id,
});
const file = join(data, "library", book.id, "planning.json");
await writeFile(
  file,
  JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    placements: scenes.map((s, order) => ({
      sceneId: s.id,
      chapterId: book.chapters[order < 3 ? 0 : order === 3 ? 1 : 2].id,
      order,
    })),
  }) + "\n",
);
const bodies = await Promise.all(
  book.chapters.map((c) =>
    readFile(join(data, "library", book.id, "manuscript", `${c.id}.md`)),
  ),
);
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-002",
  "scene-tree-operations",
);
await mkdir(out, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
const report = {
  status: "running",
  checks: [],
  errors: [],
  viewports: [],
  scope:
    "Actual planned-scene pointer/keyboard operations, stale-CAS refusal and draft guard; no manuscript rearrangement, native IME or large-book performance qualification",
};
const tree = () => page.locator(".chapters");
const host = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const nav = (name) => tree().getByRole("button", { name, exact: true });
async function showTree() {
  if (!(await tree().isVisible()))
    await page
      .getByRole("button", { name: "关闭创作参考", exact: true })
      .click();
}
async function controls(name) {
  const button = nav(`调整 ${name} 位置`);
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  return tree().getByRole("group", { name: `${name}的位置操作`, exact: true });
}
async function waitOrder(chapter, ids) {
  for (let i = 0; i < 100; i++) {
    const value = await host("planning.read", { bookId: book.id }),
      list = value.columns
        .find((c) => c.id === chapter)
        ?.scenes.map((s) => s.id);
    if (JSON.stringify(list) === JSON.stringify(ids)) {
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent === "刷新场景树",
          )?.disabled,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Expected planning identity/order not observed");
}
async function screenshot(name) {
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
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  if (process.env.ZINOVEL_TREE_START_COMPACT === "1")
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1008, 681),
    );
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  if (report.version) assert.equal(runtime.version, report.version);
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  report[runtime.packaged ? "appAsarSha256" : "desktopBundleSha256"] =
    createHash("sha256")
      .update(
        await readFile(
          runtime.packaged ? runtime.path : join(root, "dist/desktop/main.cjs"),
        ),
      )
      .digest("hex");
  if (!runtime.packaged) {
    const files = {};
    for (const name of ["app.js", "app.css", "index.html"])
      files[name] = createHash("sha256")
        .update(await readFile(join(root, "dist/workbench", name)))
        .digest("hex");
    if (report.frontend) assert.deepEqual(files, report.frontend);
    report.frontend = files;
  }
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await tree().getByLabel("第一章的计划场景", { exact: true }).waitFor();
  await tree()
    .getByRole("group", { name: "第一章的场景列表", exact: true })
    .locator(".scene-tree-item")
    .first()
    .waitFor();
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
try {
  await launch();
  const [a, b, c, d, e] = scenes.map((s) => s.id),
    first = book.chapters[0].id,
    second = book.chapters[1].id;
  await nav(names[2]).dragTo(nav(names[0]));
  await waitOrder(first, [c, a, b]);
  await page.getByLabel("搜索章节", { exact: true }).fill("桥畔");
  assert.equal(await tree().locator(".scene-tree-item").count(), 1);
  await controls(names[0]);
  await nav(`${names[0]}上移`).focus();
  await page.keyboard.press("Enter");
  await waitOrder(first, [a, c, b]);
  await nav(`${names[0]}下移`).click();
  await waitOrder(first, [c, a, b]);
  await screenshot("filtered-neighbor-order.png");
  report.checks.push(
    "Real pointer drag reorders scene IDs within the chapter; filtered keyboard up/down uses the full unfiltered neighbor order without dropping hidden scenes or changing manuscript",
  );

  await (await controls(names[0]))
    .getByLabel(`树中移动 ${names[0]} 到章节`, { exact: true })
    .selectOption(second);
  await waitOrder(first, [c, b]);
  await waitOrder(second, [d, a]);
  await page.getByLabel("搜索章节", { exact: true }).fill("");
  const firstSummary = tree().getByLabel("第一章的计划场景", { exact: true });
  assert.equal(await firstSummary.evaluate((s) => s.parentElement.open), true);
  await nav(names[4]).waitFor();
  const lost = await controls(names[4]);
  assert.equal(
    await lost
      .getByRole("button", { name: `${names[4]}上移`, exact: true })
      .isDisabled(),
    true,
  );
  await lost
    .getByLabel(`树中移动 ${names[4]} 到章节`, { exact: true })
    .selectOption(first);
  await waitOrder(first, [c, b, e]);
  report.checks.push(
    "Tree chapter selector moves across volumes and rescues a scene from a deleted chapter; source/destination retain all stable IDs, orphan reorder is disabled and positions survive restart",
  );

  await nav(names[0]).waitFor();
  await nav(names[0]).click();
  const material = page.getByRole("region", { name: "创作资料", exact: true });
  await material.getByLabel("资料笔记", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.treeOperationsSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.material-draft."))
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      return window.treeOperationsSetItem.call(this, key, value);
    };
  });
  const input = "未暂存的作者笔记𠮷🌊";
  await material.getByLabel("资料笔记", { exact: true }).fill(input);
  await showTree();
  const beforeBlocked = await readFile(file);
  await (await controls(names[0]))
    .getByLabel(`树中移动 ${names[0]} 到章节`, { exact: true })
    .selectOption(first);
  await page.getByRole("alert").filter({ hasText: "再移动场景" }).waitFor();
  assert.deepEqual(await readFile(file), beforeBlocked);
  if (!(await material.isVisible()))
    await page.getByTitle("打开创作参考", { exact: true }).click();
  assert.equal(
    await material.getByLabel("资料笔记", { exact: true }).inputValue(),
    input,
  );
  if (!(await material.isVisible()))
    await page.getByTitle("打开创作参考", { exact: true }).click();
  await material.getByRole("button", { name: "保存资料", exact: true }).click();
  await material
    .getByRole("status")
    .filter({ hasText: "已保存资料" })
    .waitFor();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.treeOperationsSetItem;
    delete window.treeOperationsSetItem;
  });
  report.checks.push(
    "Tree movement honors an actual material-cache quota failure: no planning bytes change and author input remains; explicit formal save resolves the guard",
  );
  await showTree();

  const refresh = nav("刷新场景树");
  await refresh.click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "刷新场景树",
      )?.disabled,
  );
  await controls(names[4]);
  const external = (await readFile(file, "utf8")) + "\n";
  await writeFile(file, external);
  await nav(`${names[4]}上移`).click();
  await tree().getByRole("alert").filter({ hasText: "外部编辑" }).waitFor();
  assert.equal(await readFile(file, "utf8"), external);
  await screenshot("stale-planning-preserved.png");
  await refresh.click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "刷新场景树",
      )?.disabled,
  );
  await nav(`${names[4]}上移`).click();
  await waitOrder(first, [c, e, b]);
  await close();
  await launch();
  await waitOrder(first, [c, e, b]);
  await waitOrder(second, [d, a]);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await page.waitForFunction(() => innerWidth <= 850);
  await page.getByTitle("深色主题", { exact: true }).click();
  const closeReference = page.getByRole("button", {
    name: "关闭创作参考",
    exact: true,
  });
  if (await closeReference.isVisible()) await closeReference.click();
  await controls(names[4]);
  await screenshot("tree-operations-dark-narrow.png");
  const draftKey = `zinovel.material-draft.${book.id}.new`;
  const legacy = JSON.stringify({
    input: {
      kind: "character",
      title: "旧版未存人物𠮷",
      status: "planned",
      notes: "不得被新场景覆盖🌊",
      fields: { desire: "找回旧信" },
      chapterIds: [],
    },
    expected: null,
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key: draftKey,
    raw: legacy,
  });
  await nav("新建场景资料").click();
  let creation = page.getByRole("region", { name: "创作资料", exact: true });
  await creation
    .getByRole("status")
    .filter({ hasText: "已有未保存的人物草稿" })
    .waitFor();
  assert.equal(
    await creation.getByLabel("资料标题", { exact: true }).inputValue(),
    "旧版未存人物𠮷",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    legacy,
  );
  assert.equal(
    (
      await host("materials.list", {
        bookId: book.id,
        options: { kind: "character" },
      })
    ).total,
    0,
  );
  await creation
    .getByRole("button", { name: "清空新建草稿", exact: true })
    .click();
  const future = JSON.stringify({
    schemaVersion: 98,
    input: { title: "未来草稿𠮷🌊" },
    future: "保留全部原字节",
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key: draftKey,
    raw: future,
  });
  await showTree();
  await nav("新建场景资料").click();
  await creation
    .getByRole("alert")
    .filter({ hasText: "不支持的资料草稿格式" })
    .waitFor();
  assert.equal(
    await creation.getByLabel("资料标题", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await creation
      .getByRole("button", { name: "保存资料", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await screenshot("unknown-draft-preserved.png");
  await close();
  await launch();
  creation = page.getByRole("region", { name: "创作资料", exact: true });
  await nav("新建场景资料").click();
  await creation
    .getByRole("alert")
    .filter({ hasText: "不支持的资料草稿格式" })
    .waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
    future,
  );
  await creation
    .getByRole("button", { name: "清空新建草稿", exact: true })
    .click();
  await creation
    .getByLabel("资料标题", { exact: true })
    .fill("树中新建场景𠮷🌊");
  await creation.getByLabel("场景目标", { exact: true }).fill("找到新的送信人");
  await creation
    .getByLabel("资料笔记", { exact: true })
    .fill("明确保存后再安排位置。");
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).schemaVersion,
      draftKey,
    ),
    1,
  );
  await creation.getByRole("button", { name: "保存资料", exact: true }).click();
  await creation
    .getByRole("status")
    .filter({ hasText: "已保存资料" })
    .waitFor();
  const created = await host("materials.list", {
    bookId: book.id,
    options: { kind: "scene", query: "树中新建场景𠮷🌊" },
  });
  assert.equal(created.items.length, 1);
  const createdId = created.items[0].id;
  assert.equal(
    (await host("planning.read", { bookId: book.id })).columns
      .find((column) => column.id === null)
      .scenes.some((scene) => scene.id === createdId),
    true,
  );
  await showTree();
  await nav("树中新建场景𠮷🌊").waitFor();
  await (await controls("树中新建场景𠮷🌊"))
    .getByLabel("树中移动 树中新建场景𠮷🌊 到章节", { exact: true })
    .selectOption(second);
  await waitOrder(second, [d, a, createdId]);
  await close();
  await launch();
  await waitOrder(second, [d, a, createdId]);
  assert.equal(
    (await host("materials.read", { bookId: book.id, id: createdId })).fields
      .goal,
    "找到新的送信人",
  );
  for (let i = 0; i < book.chapters.length; i++)
    assert.deepEqual(
      await readFile(
        join(
          data,
          "library",
          book.id,
          "manuscript",
          `${book.chapters[i].id}.md`,
        ),
      ),
      bodies[i],
    );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Same-revision external planning edit rejects a stale tree action and preserves exact bytes; explicit refresh permits a new move, actual restart retains both columns and compact dark controls remain reachable with every manuscript byte unchanged",
  );
  report.checks.push(
    "Tree creation restores a legacy unsaved character draft without overwriting or formally saving it; unknown future draft remains read-only and byte-identical across actual restart until explicit discard; author saves a schema1 scene, sees it unassigned, then moves the same stable ID and reads it after restart",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  if (page)
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else await close();
    }
  } catch (e) {
    report.status = "failed";
    report.cleanupFailure = String(e);
    throw e;
  } finally {
    await writeFile(
      join(out, "scene-tree-operations-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report);
  }
}
