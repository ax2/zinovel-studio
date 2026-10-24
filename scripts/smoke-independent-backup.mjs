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
  work = await mkdtemp(join(root, ".cache", "independent-backup-")),
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
  join(tmpdir(), "zinovel-independent-backup-"),
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
  "independent-backup",
);
await mkdir(out, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  sourceDisk,
  backupDisk,
  independentDisks,
  browser: "Browser plugin not available; repository Playwright/Electron",
  scope: `Actual host file transactions; Windows disk numbers are ${independentDisks ? "distinct" : "the same"}; picker results instrumented; not a hardware-loss or system-IME simulation`,
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
const request = (action, payload) =>
  page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload },
  );
async function choose(path, canceled = false) {
  await app.evaluate(
    ({ dialog }, { path, canceled }) => {
      dialog.showOpenDialog = async () => ({
        canceled,
        filePaths: canceled ? [] : [path],
      });
    },
    { path, canceled },
  );
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
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
  const editor = page.getByLabel("正文编辑器");
  await editor.waitFor();
  owned = await captureOwnedProcesses(app.process().pid);
  report.version = await app.evaluate(({ app }) => app.getVersion());
  const runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    path: app.getAppPath(),
  }));
  report.packaged = runtime.packaged;
  if (runtime.packaged)
    report.appAsarSha256 = digest(await readFile(runtime.path));
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n备份前作者新增𠮷🌊。");
  await editor.press("Control+s");
  const expected = "冻结时原稿𠮷🌊。\n备份前作者新增𠮷🌊。";
  const until = Date.now() + 10000;
  while (
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body !== expected
  ) {
    assert.ok(Date.now() < until, "Author save did not settle");
    await page.waitForTimeout(30);
  }
  const entries = (await readdir(bookRoot)).sort(),
    libraryEntries = (await readdir(join(data, "library"))).sort(),
    otherEntries = (await readdir(otherRoot)).sort();
  for (const path of [
    alias,
    join(alias, "尚未创建的子目录"),
    join(data, "library"),
    otherRoot,
    join(otherAlias, "尚未创建的子目录"),
  ]) {
    await choose(path);
    await assert.rejects(
      request("book.backup", { bookId: book.id }),
      /别名|内部/,
    );
    assert.deepEqual((await readdir(bookRoot)).sort(), entries);
    assert.deepEqual(
      (await readdir(join(data, "library"))).sort(),
      libraryEntries,
    );
    assert.deepEqual((await readdir(otherRoot)).sort(), otherEntries);
  }
  assert.equal(
    (
      await request("chapter.read", {
        bookId: otherBook.id,
        chapterId: otherBook.chapters[0].id,
      })
    ).body,
    "另一书正文保持独立。",
  );
  await choose(destination, true);
  assert.equal(
    (await request("book.backup", { bookId: book.id })).cancelled,
    true,
  );
  assert.deepEqual(await readdir(destination), []);
  await choose(destination);
  const backup = await request("book.backup", { bookId: book.id });
  const manifest = JSON.parse(
    await readFile(join(backup.path, "backup-manifest.json"), "utf8"),
  );
  assert.equal(manifest.format, "zinovel-backup");
  assert.equal(manifest.bookId, book.id);
  for (const item of manifest.files) {
    const data = await readFile(join(backup.path, item.path));
    assert.equal(data.length, item.bytes);
    assert.equal(digest(data), item.sha256);
  }
  assert.ok(
    manifest.files.some(
      (item) => item.path === `.zinovel/publications/${snapshot.id}.json`,
    ),
  );
  assert.ok(
    manifest.files.some(
      (item) =>
        item.path ===
        `assets/blobs/${snapshot.content.resources[0].image.sha256}.png`,
    ),
  );
  await choose(backup.path);
  const restored = (await request("library.restore", {})).book;
  assert.notEqual(restored.id, book.id);
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
    expected,
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
  const savedManifest = await readFile(
    join(backup.path, "backup-manifest.json"),
  );
  const target = manifest.files.find((item) =>
      item.path.startsWith("manuscript/"),
    ),
    targetFile = join(backup.path, target.path),
    savedBytes = await readFile(targetFile);
  await writeFile(targetFile, "合成损坏备份，不是原稿");
  await assert.rejects(request("library.restore", {}), /校验|备份文件/);
  assert.equal(
    (
      await request("chapter.read", {
        bookId: book.id,
        chapterId: book.chapters[0].id,
      })
    ).body,
    expected,
  );
  await writeFile(targetFile, savedBytes);
  assert.deepEqual(
    await readFile(join(backup.path, "backup-manifest.json")),
    savedManifest,
  );
  await page.reload();
  await page
    .locator(".book-card")
    .filter({ hasText: `${book.title}（恢复）` })
    .click();
  await page.getByLabel("正文编辑器").waitFor();
  assert.ok(
    (await page.getByLabel("正文编辑器").innerText()).includes(
      "备份前作者新增𠮷🌊。",
    ),
  );
  await page.screenshot({ path: join(out, "restored-book-desktop.png") });
  assert.deepEqual(report.errors, []);
  report.backupFiles = manifest.files.length;
  report.snapshotHash = snapshot.hash;
  report.backupManifestSha256 = digest(savedManifest);
  report.checks.push(
    "actual author edit and save precede backup; managed library root, another book and canonical existing/prospective Junction aliases reject before any file creation or other-book change; cancellation leaves the selected destination empty",
    "real host independently hashes every backup file, includes current manuscript and old frozen image/text publication, and restores into a distinct new book without changing originals; disk independence is recorded separately",
    "restored provenance preserves the old publication hash and frozen image; intentionally damaged backup refuses another restore and leaves original manuscript and manifest unchanged; explicit synthetic repair restores original backup bytes",
    "author workspace reload opens the restored book and displays the latest saved Unicode text without renderer errors or network requests",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(out, "independent-backup-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (app) {
    if (report.status === "failed") {
      if (owned) await terminateOwnedProcesses(owned);
      else await app.close();
    } else {
      await app.close();
      await confirmOwnedProcessesExited(owned);
    }
  }
  await writeFile(
    join(out, "independent-backup-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
