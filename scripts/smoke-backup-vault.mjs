import { _electron as electron } from "playwright";
import electronPath from "electron";
import {
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  writeFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, parse } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "incremental-backup-")),
  data = join(work, "data");
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("独立备份合成原稿", [
  { title: "旧信", body: "冻结时原稿𠮷🌊。" },
]);
const otherBook = await store.importBook("独立保留的另一合成作品", [
  { title: "另一书", body: "另一书正文保持独立。" },
]);
const bytes = await sharp({
  create: {
    width: 96,
    height: 64,
    channels: 4,
    background: { r: 18, g: 107, b: 131, alpha: 0.6 },
  },
})
  .png()
  .toBuffer();
const asset = await store.assets.import(book.id, bytes, {
  title: "合成封面",
  purpose: "cover",
  source: "程序合成",
  rights: "合成验收",
  notes: "备份应包含的作者私有说明",
  linkedIds: [],
});
const snapshot = await store.publication.capture(book.id, {
  catalogHash: (await store.publication.catalog(book.id)).hash,
  chapterIds: [book.chapters[0].id],
  metadata: {
    title: "独立备份公开书名",
    author: "合成作者",
    synopsis: "",
    rights: "合成",
    aiDisclosure: "测试",
  },
  resources: [
    {
      asset: {
        id: asset.id,
        revision: asset.revision,
        diskHash: asset.diskHash,
      },
      placement: "cover",
      chapterId: null,
      alt: "合成封面𠮷🌊",
      caption: "公开图注",
      credit: "合成",
    },
  ],
});
const bookRoot = join(data, "library", book.id),
  alias = join(work, "看似外部的原书别名");
await symlink(
  bookRoot,
  alias,
  process.platform === "win32" ? "junction" : "dir",
);
const otherRoot = join(data, "library", otherBook.id),
  otherAlias = join(work, "另一作品别名");
await symlink(
  otherRoot,
  otherAlias,
  process.platform === "win32" ? "junction" : "dir",
);
const destination = await mkdtemp(
  join(tmpdir(), "zinovel-incremental-backup-"),
);
const physical = (path) => {
  const letter = parse(path).root[0].toUpperCase();
  assert.match(letter, /^[A-Z]$/);
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; Get-Partition -DriveLetter '${letter}' | Select-Object DriveLetter,DiskNumber,PartitionNumber | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
};
const sourceDisk = physical(await realpath(bookRoot)),
  backupDisk = physical(await realpath(destination));
const independentDisks = sourceDisk.DiskNumber !== backupDisk.DiskNumber;
if (!process.argv.includes("--allow-same-disk"))
  assert.ok(
    independentDisks,
    "This probe requires two distinct Windows disks, not merely different drive letters",
  );
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-008",
  "incremental-backup",
);
await mkdir(out, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  sourceDisk,
  backupDisk,
  independentDisks,
  browser: "Browser plugin unavailable; repository Playwright/Electron",
  scope:
    "Synthetic books; actual desktop host and author controls; native picker results and one object-write barrier instrumented. Not physical disk-loss, native-picker clicks or system-IME qualification.",
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
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
const panel = () =>
  page.getByRole("dialog", { name: "增量备份与恢复", exact: true });
async function until(read, accept, message) {
  const end = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < end, message);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function choose(path, canceled = false) {
  await app.evaluate(
    ({ dialog }, { path, canceled }) => {
      globalThis.__vaultPickCount = 0;
      dialog.showOpenDialog = async () => {
        globalThis.__vaultPickCount++;
        return { canceled, filePaths: canceled ? [] : [path] };
      };
    },
    { path, canceled },
  );
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    env,
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? work : root,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (item) => {
    if (/^https?:/.test(item.url()))
      report.errors.push("Unexpected renderer network request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  await page.getByLabel("正文编辑器").waitFor();
  owned = await captureOwnedProcesses(app.process().pid);
}
async function closeApp() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
}
async function openPanel() {
  await page.getByRole("button", { name: "增量备份", exact: true }).click();
  await panel().waitFor();
}
async function waitPanelIdle() {
  await panel()
    .getByRole("button", { name: "打开已有备份库", exact: true })
    .waitFor();
  await until(
    () =>
      panel()
        .getByRole("button", { name: "打开已有备份库", exact: true })
        .isEnabled(),
    Boolean,
    "Backup panel did not settle",
  );
}
async function save(text) {
  const editor = page.getByLabel("正文编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText(text);
  await editor.press("Control+s");
  await until(
    () =>
      request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      }),
    (value) => value.body.endsWith(text),
    "Author save did not settle",
  );
}
async function selected(path) {
  await choose(path);
  return request("backup.open", { bookId: book.id });
}
async function checkedManifests(path, count) {
  const names = (await readdir(join(path, "snapshots"))).filter((name) =>
    name.endsWith(".json"),
  );
  assert.equal(names.length, count);
  const manifests = [];
  for (const name of names) {
    const manifest = JSON.parse(
      await readFile(join(path, "snapshots", name), "utf8"),
    );
    for (const item of manifest.files) {
      const bytes = await readFile(join(path, "objects", item.sha256));
      assert.equal(bytes.length, item.bytes);
      assert.equal(digest(bytes), item.sha256);
    }
    manifests.push(manifest);
  }
  return manifests;
}
try {
  await launch();
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.version = runtime.version;
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = digest(await readFile(runtime.path));
  await save("\n备份前作者新增𠮷🌊。");
  const expected = "冻结时原稿𠮷🌊。\n备份前作者新增𠮷🌊。";
  await openPanel();
  await choose(destination, true);
  await panel()
    .getByRole("button", { name: "选择位置并备份当前作品", exact: true })
    .click();
  await waitPanelIdle();
  assert.deepEqual(await readdir(destination), []);
  await assert.rejects(
    request("backup.choose", { bookId: book.id, path: destination }),
    /原生选择器/,
  );
  assert.equal(await app.evaluate(() => globalThis.__vaultPickCount), 1);
  await choose(alias);
  const rejected = await request("backup.choose", { bookId: book.id });
  const rejectedJob = await until(
    () => request("backup.status", { bookId: book.id, id: rejected.id }),
    (value) => value.status === "failed",
    "Managed path was not rejected",
  );
  assert.match(rejectedJob.error, /内部|别名/);
  assert.ok(
    !(await readdir(bookRoot)).some((name) =>
      name.startsWith("zinovel-vault-"),
    ),
  );
  report.checks.push(
    "Native chooser cancellation creates nothing; injected renderer path rejected before picker; source Junction destination fails before adoption",
  );

  await choose(destination);
  await panel()
    .getByRole("button", { name: "选择位置并备份当前作品", exact: true })
    .click();
  await waitPanelIdle();
  assert.match(await panel().innerText(), /已保存完整备份版本/);
  const vault = join(await realpath(destination), `zinovel-vault-${book.id}`);
  const first = (await checkedManifests(vault, 1))[0];
  assert.ok(
    first.files.some(
      (item) => item.path === `.zinovel/publications/${snapshot.id}.json`,
    ),
  );
  assert.ok(
    first.files.some(
      (item) =>
        item.path ===
        `assets/blobs/${snapshot.content.resources[0].image.sha256}.png`,
    ),
  );
  await panel().getByRole("button", { name: "追加备份", exact: true }).click();
  await waitPanelIdle();
  assert.match(await panel().innerText(), /本次新增内容0 B/);
  await checkedManifests(vault, 2);
  const capability = await selected(vault);
  await assert.rejects(
    request("backup.append", { bookId: otherBook.id, token: capability.token }),
    /不属于/,
  );
  await assert.rejects(
    request("backup.status", { bookId: otherBook.id, id: rejected.id }),
    /不属于/,
  );
  report.checks.push(
    "Actual author save backed up to chosen disk; every object independently hashed; publication/image included; unchanged repeat adds zero content bytes and a complete second logical version; cross-book capabilities denied",
  );

  await panel()
    .getByRole("button", { name: "关闭增量备份", exact: true })
    .click();
  await save("\n取消与重试的作者新段落𠮷🌊。");
  await openPanel();
  await choose(vault);
  await panel()
    .getByRole("button", { name: "打开已有备份库", exact: true })
    .click();
  await waitPanelIdle();
  await app.evaluate(() => {
    const fs = process.getBuiltinModule("node:fs/promises"),
      original = fs.link;
    globalThis.__vaultBarrierHit = false;
    fs.link = async (...args) => {
      if (
        /[\\/]objects[\\/]/.test(String(args[1])) &&
        !globalThis.__vaultBarrierHit
      ) {
        globalThis.__vaultBarrierHit = true;
        await new Promise((resolve) => {
          globalThis.__vaultBarrierRelease = resolve;
        });
      }
      return original(...args);
    };
    globalThis.__vaultBarrierRestore = () => {
      fs.link = original;
    };
  });
  await panel().getByRole("button", { name: "追加备份", exact: true }).click();
  await until(
    () => app.evaluate(() => globalThis.__vaultBarrierHit),
    Boolean,
    "Object-write barrier not reached",
  );
  await panel()
    .getByRole("button", { name: "关闭增量备份", exact: true })
    .click();
  assert.ok(await panel().isVisible());
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await until(
    () => panel().innerText(),
    (text) => text.includes("退出程序"),
    "Native close guard did not retain active job",
  );
  assert.ok(await panel().isVisible());
  await panel()
    .getByRole("button", { name: "取消本次备份", exact: true })
    .click();
  await app.evaluate(() => {
    globalThis.__vaultBarrierRelease();
    globalThis.__vaultBarrierRestore();
  });
  await waitPanelIdle();
  assert.match(await panel().innerText(), /本次已取消/);
  await checkedManifests(vault, 2);
  await panel().getByRole("button", { name: "追加备份", exact: true }).click();
  await waitPanelIdle();
  const all = await checkedManifests(vault, 3);
  report.checks.push(
    "Deterministic mid-object capture: modal and native window close guarded; author cancels; zero new committed versions; old objects remain valid; subsequent retry commits third complete version",
  );

  await panel()
    .getByRole("button", { name: "关闭增量备份", exact: true })
    .click();
  await closeApp();
  await launch();
  await assert.rejects(
    request("backup.page", {
      bookId: book.id,
      token: capability.token,
      page: 0,
    }),
    /不属于/,
  );
  await openPanel();
  await choose(vault);
  await panel()
    .getByRole("button", { name: "打开已有备份库", exact: true })
    .click();
  await waitPanelIdle();
  await page.screenshot({ path: join(out, "desktop-versions.png") });
  await panel()
    .getByRole("button", { name: "关闭增量备份", exact: true })
    .click();
  await page
    .getByLabel("主导航")
    .getByTitle("深色主题", { exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 820, height: 840 }),
  );
  await openPanel();
  await choose(vault);
  await panel()
    .getByRole("button", { name: "打开已有备份库", exact: true })
    .click();
  await waitPanelIdle();
  report.geometry = await panel().evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scale: devicePixelRatio,
    };
  });
  assert.ok(
    report.geometry.left >= 0 &&
      report.geometry.right <= report.geometry.width &&
      report.geometry.top >= 0 &&
      report.geometry.bottom <= report.geometry.height,
  );
  assert.ok(report.geometry.scrollWidth <= report.geometry.clientWidth + 1);
  await page.screenshot({ path: join(out, "dark-narrow-versions.png") });
  const libraryBefore = (await request("library.list", {})).books.length;
  await panel().getByRole("radio").last().check();
  await panel()
    .getByRole("button", { name: "恢复所选版本", exact: true })
    .click();
  assert.equal((await request("library.list", {})).books.length, libraryBefore);
  await panel()
    .getByRole("button", { name: "返回版本列表", exact: true })
    .click();
  assert.equal((await request("library.list", {})).books.length, libraryBefore);
  await panel()
    .getByRole("button", { name: "恢复所选版本", exact: true })
    .click();
  await panel()
    .getByRole("button", { name: "确认恢复为新作品", exact: true })
    .click();
  await panel().waitFor({ state: "hidden" });
  await until(
    () => page.getByLabel("正文编辑器").innerText(),
    (text) => text.includes("备份前作者新增𠮷🌊。"),
    "Restored book was not opened",
  );
  assert.ok(
    !(await page.getByLabel("正文编辑器").innerText()).includes("取消与重试"),
  );
  const library = (await request("library.list", {})).books;
  const restored = library.find(
    (item) => ![book.id, otherBook.id].includes(item.id),
  );
  assert.ok(restored);
  assert.equal(
    (
      await request("chapter.read", {
        bookId: restored.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    expected,
  );
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    expected + "\n取消与重试的作者新段落𠮷🌊。",
  );
  const frozen = await request("publication.preview", {
    bookId: restored.id,
    id: snapshot.id,
    hash: snapshot.hash,
  });
  assert.equal(frozen.hash, snapshot.hash);
  assert.equal(frozen.content.bookId, book.id);
  const picture = await request("publication.image", {
    bookId: restored.id,
    id: snapshot.id,
    hash: snapshot.hash,
    index: 0,
  });
  assert.equal(picture.sha256, snapshot.content.resources[0].image.sha256);
  await checkedManifests(vault, 3);
  await page.screenshot({ path: join(out, "restored-old-version.png") });
  report.checks.push(
    "Application restart invalidates old capability; author reopens vault; desktop and dark narrow view fit; restore requires final explicit confirmation; oldest version opens as distinct book retaining frozen publication hash/image and original provenance; newer original manuscript unchanged",
  );
  report.manifests = all.map((item) => ({
    id: item.id,
    hash: item.hash,
    files: item.files.length,
  }));
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed" && owned)
      await terminateOwnedProcesses(owned);
    else await closeApp();
  }
  await writeFile(
    join(out, "incremental-backup-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
