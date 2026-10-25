import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "scene-tree-"));
const store = new NovelStore(join(data, "library"));
let book = await store.importBook("场景树合成验证", [
  {
    title: "抵达旧港",
    body: "作者原稿𠮷🌊\r\n场景计划不改正文。",
    volume: "卷一",
  },
  { title: "未拆的信", body: "另一章保持原始字节。", volume: "卷二" },
  { title: "回收的章", body: "回收后仍保留这份稿件。", volume: "卷二" },
]);
const scenes = [];
for (let i = 0; i < 26; i++)
  scenes.push(
    await store.materials.save(book.id, {
      kind: "scene",
      title: i === 0 ? "开场𠮷🌊" : `场景${String(i).padStart(2, "0")}`,
      status: "planned",
      notes: "计划笔记",
      fields: { goal: "寻找旧信" },
      chapterIds: [],
    }),
  );
await store.materials.setDeleted(book.id, scenes[21], true);
book = await store.updateStructure(book.id, book.revision, {
  type: "chapter-trash",
  chapterId: book.chapters[2].id,
});
// Explicit offline lost-reference fixtures, before the desktop owns this book.
const planning = {
  schemaVersion: 1,
  revision: 1,
  placements: [
    ...scenes.slice(0, 23).map((s, order) => ({
      sceneId: s.id,
      chapterId: book.chapters[0].id,
      order,
    })),
    { sceneId: randomUUID(), chapterId: book.chapters[0].id, order: 23 },
    { sceneId: scenes[23].id, chapterId: null, order: 24 },
    { sceneId: scenes[24].id, chapterId: book.chapters[2].id, order: 25 },
    { sceneId: scenes[25].id, chapterId: randomUUID(), order: 26 },
  ],
};
await writeFile(
  join(data, "library", book.id, "planning.json"),
  JSON.stringify(planning) + "\n",
);
const original = await Promise.all(
  book.chapters.map((c) =>
    readFile(join(data, "library", book.id, "manuscript", `${c.id}.md`)),
  ),
);
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-002",
  "scene-tree",
);
await mkdir(out, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let application, page, owned;
const report = { status: "running", checks: [], errors: [], viewports: [] };
const tree = () => page.locator(".chapters");
const material = () =>
  page.getByRole("region", { name: "创作资料", exact: true });
const host = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
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
  application = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
  });
  owned = await captureOwnedProcesses(application.process().pid);
  page = await application.firstWindow();
  const identity = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  assert.equal(
    identity.version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  const hash = createHash("sha256")
    .update(
      await readFile(
        identity.packaged ? identity.path : join(root, "dist/desktop/main.cjs"),
      ),
    )
    .digest("hex");
  if (report.version) assert.equal(report.version, identity.version);
  if (!identity.packaged) {
    const frontend = Object.fromEntries(
      await Promise.all(
        ["app.js", "app.css", "index.html"].map(async (name) => {
          const bytes = await readFile(join(root, "dist/workbench", name));
          return [
            name,
            {
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ];
        }),
      ),
    );
    if (report.frontend) assert.deepEqual(frontend, report.frontend);
    report.frontend = frontend;
  }
  report.version = identity.version;
  report.packaged = identity.packaged;
  report[identity.packaged ? "appAsarSha256" : "desktopBundleSha256"] = hash;
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  const first = tree().getByLabel("抵达旧港的计划场景", { exact: true });
  await first.waitFor();
  if (!(await first.evaluate((element) => element.parentElement.open)))
    await first.click();
  await tree()
    .getByRole("group", { name: "抵达旧港的场景列表", exact: true })
    .getByRole("button")
    .first()
    .waitFor();
}
async function close() {
  await application.close();
  await confirmOwnedProcessesExited(owned);
  application = null;
  owned = null;
}
try {
  await launch();
  const group = tree().getByRole("group", {
    name: "抵达旧港的场景列表",
    exact: true,
  });
  assert.equal(await group.getByRole("button").count(), 20);
  await tree()
    .getByRole("button", { name: "抵达旧港下一页场景", exact: true })
    .click();
  assert.equal(await group.getByRole("button").count(), 4);
  assert.equal(
    await group
      .getByRole("button", { name: "场景不可读取 不可读取", exact: true })
      .isDisabled(),
    true,
  );
  const recycled = group.getByRole("button").filter({ hasText: "场景21" });
  assert.match(await recycled.textContent(), /已回收/);
  await recycled.click();
  await material()
    .getByText("此资料在回收站中，恢复后可编辑。", { exact: true })
    .waitFor();
  await material()
    .getByRole("button", { name: "恢复资料", exact: true })
    .click();
  await material()
    .getByRole("status")
    .filter({ hasText: "资料已恢复" })
    .waitFor();
  await group.getByRole("button", { name: "场景21", exact: true }).waitFor();
  const restoredPlanning = await host("planning.read", { bookId: book.id });
  assert.equal(
    restoredPlanning.columns.find((column) =>
      column.scenes.some((scene) => scene.id === scenes[21].id),
    ).id,
    book.chapters[0].id,
  );
  await tree()
    .getByRole("button", { name: "抵达旧港上一页场景", exact: true })
    .click();
  await tree()
    .getByRole("group", { name: "未安排的场景列表", exact: true })
    .waitFor();
  await tree()
    .getByRole("group", {
      name: "回收的章 · 章节已回收的场景列表",
      exact: true,
    })
    .waitFor();
  await tree()
    .getByRole("group", {
      name: "章节不存在 · 章节缺失的场景列表",
      exact: true,
    })
    .waitFor();
  await screenshot("tree-light.png");
  await page.getByLabel("搜索章节", { exact: true }).fill("场景22");
  assert.equal(await tree().locator(".scene-tree-item").count(), 1);
  await tree().getByRole("button", { name: "场景22", exact: true }).waitFor();
  assert.equal(
    await tree()
      .getByRole("button", { name: /未拆的信/ })
      .count(),
    0,
  );
  await page.getByLabel("搜索章节", { exact: true }).fill("");
  report.checks.push(
    "Actual chapter/scene tree preserves stable planning order, pages 24 entries as 20/4, keeps unassigned/deleted/missing identities visible and missing records disabled; explicit scene recovery retains identity/placement; scene-title search retains chapter context",
  );

  await tree().getByRole("button", { name: "开场𠮷🌊", exact: true }).focus();
  await page.keyboard.press("Enter");
  await material().getByLabel("资料标题", { exact: true }).waitFor();
  assert.equal(
    await material().getByLabel("资料标题", { exact: true }).inputValue(),
    scenes[0].title,
  );
  const cached = "仅本机草稿𠮷🌊，切换场景后找回。";
  await material().getByLabel("资料笔记", { exact: true }).fill(cached);
  await tree().getByRole("button", { name: "场景01", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="资料标题"]')?.value === "场景01",
  );
  await tree().getByRole("button", { name: "开场𠮷🌊", exact: true }).click();
  await page.waitForFunction(
    (value) =>
      document.querySelector('[aria-label="资料笔记"]')?.value === value,
    cached,
  );
  assert.equal(
    (await host("materials.read", { bookId: book.id, id: scenes[0].id })).notes,
    "计划笔记",
  );
  report.checks.push(
    "Keyboard scene navigation opens the existing semantic form; switching scenes restores the exact local draft without silently saving it as formal material",
  );

  await page.evaluate(() => {
    window.sceneTreeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zinovel.material-draft."))
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      return window.sceneTreeSetItem.call(this, key, value);
    };
  });
  const unsaved = "暂存失败仍须保留𠮷🌊";
  await material().getByLabel("资料笔记", { exact: true }).fill(unsaved);
  await tree().getByRole("button", { name: "场景01", exact: true }).click();
  assert.equal(
    await material().getByLabel("资料标题", { exact: true }).inputValue(),
    scenes[0].title,
  );
  await page.getByTitle("书库", { exact: true }).click();
  assert.equal(
    await material().getByLabel("资料笔记", { exact: true }).inputValue(),
    unsaved,
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes("再关闭窗口"),
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  assert.equal(
    await material().getByLabel("资料笔记", { exact: true }).inputValue(),
    unsaved,
  );
  await screenshot("quota-protected.png");
  await material()
    .getByRole("button", { name: "保存资料", exact: true })
    .click();
  await material()
    .getByRole("status")
    .filter({ hasText: "已保存资料" })
    .waitFor();
  assert.equal(
    (await host("materials.read", { bookId: book.id, id: scenes[0].id })).notes,
    unsaved,
  );
  await material()
    .getByLabel("资料笔记", { exact: true })
    .fill("明确放弃的未存草稿𠮷🌊");
  await material()
    .getByRole("button", { name: "新建资料", exact: true })
    .click();
  assert.equal(
    await material().getByLabel("资料标题", { exact: true }).inputValue(),
    scenes[0].title,
  );
  await material()
    .getByRole("button", { name: "重新读取（放弃调整）", exact: true })
    .click();
  await page.waitForFunction(
    (value) =>
      document.querySelector('[aria-label="资料笔记"]')?.value === value,
    unsaved,
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = window.sceneTreeSetItem;
    delete window.sceneTreeSetItem;
  });
  report.checks.push(
    "Controlled local quota failure blocks another scene, book navigation and an actual native-window close while retaining typed notes; explicit formal save succeeds and releases the guard",
  );

  await tree()
    .getByRole("button", { name: "编排场景位置", exact: true })
    .click();
  const board = page.getByRole("dialog", { name: "场景编排", exact: true });
  await board
    .getByLabel(`移动 ${scenes[0].title} 到章节`, { exact: true })
    .selectOption(book.chapters[1].id);
  await board
    .getByRole("status")
    .filter({ hasText: "已保存场景位置" })
    .waitFor();
  await board
    .getByRole("button", { name: "关闭场景编排", exact: true })
    .click();
  await tree().getByLabel("未拆的信的计划场景", { exact: true }).click();
  await tree()
    .getByRole("group", { name: "未拆的信的场景列表", exact: true })
    .getByRole("button", { name: scenes[0].title, exact: true })
    .waitFor();
  await close();
  await launch();
  await tree().getByLabel("未拆的信的计划场景", { exact: true }).click();
  await tree()
    .getByRole("group", { name: "未拆的信的场景列表", exact: true })
    .getByRole("button", { name: scenes[0].title, exact: true })
    .waitFor();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(820, 840),
  );
  await page.waitForFunction(() => innerWidth <= 850);
  await page.getByTitle("深色主题", { exact: true }).click();
  const closeReference = page.getByRole("button", {
    name: "关闭创作参考",
    exact: true,
  });
  if (await closeReference.isVisible()) await closeReference.click();
  await tree()
    .getByRole("button", { name: scenes[0].title, exact: true })
    .waitFor();
  await tree().getByLabel("抵达旧港的计划场景", { exact: true }).click();
  await tree()
    .locator(".chapter-list")
    .evaluate((element) => (element.scrollTop = 0));
  await screenshot("tree-dark-narrow.png");
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
      original[i],
    );
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Actual board move refreshes the tree through the shared planning event and survives full restart; dark compact tree remains reachable through existing reference controls; all manuscript bytes are unchanged",
  );
  report.status = "passed";
  report.scope =
    "Synthetic scene tree, fixed planning identity/order and material draft navigation; no automatic manuscript splitting, native IME, huge-book performance or complete product qualification";
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
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(out, "scene-tree-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report);
  }
}
