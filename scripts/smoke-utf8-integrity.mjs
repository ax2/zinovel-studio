import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "utf8-ui-"));
const store = new NovelStore(join(data, "library"));
const book = await store.importBook("编码保护合成稿", [
  { title: "第一章 正常", body: "正常正文。🌊" },
  { title: "第二章 损坏", body: "等待外部损坏的合成正文。" },
]);
const damaged = await store.createBook("损坏元数据合成稿");
const manuscript = join(
  data,
  "library",
  book.id,
  "manuscript",
  `${book.chapters[1].id}.md`,
);
const malformed = Buffer.concat([
  Buffer.from("原始开头"),
  Buffer.from([255]),
  Buffer.from("原始结尾"),
]);
await writeFile(manuscript, malformed);
const backupParent = join(data, "backups");
await mkdir(backupParent);
const backup = await store.createBackup(book.id, backupParent);
const backupMetadataPath = join(backup.path, "book.json");
const backupMetadata = await readFile(backupMetadataPath);
const backupTitleOffset = backupMetadata.indexOf(Buffer.from(book.title));
assert.ok(backupTitleOffset > 0);
backupMetadata[backupTitleOffset] = 255;
await writeFile(backupMetadataPath, backupMetadata);
const backupManifestPath = join(backup.path, "backup-manifest.json");
const backupManifest = JSON.parse(await readFile(backupManifestPath, "utf8"));
backupManifest.files.find((file) => file.path === "book.json").sha256 =
  createHash("sha256").update(backupMetadata).digest("hex");
await writeFile(backupManifestPath, JSON.stringify(backupManifest));
const metadataPath = join(data, "library", damaged.id, "book.json");
const metadata = await readFile(metadataPath);
const offset = metadata.indexOf(Buffer.from("损坏元数据合成稿"));
assert.ok(offset > 0);
metadata[offset] = 255;
await writeFile(metadataPath, metadata);
const validManifest = await readFile(
  join(data, "library", book.id, "book.json"),
);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "utf8-integrity",
);
await mkdir(shots, { recursive: true });
const report = {
  status: "running",
  checks: [],
  errors: [],
  syntheticDataRoot: data,
};
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const name of Object.keys(env))
    if (name.toLowerCase() === "path") delete env[name];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
let app, page, owned;
try {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow({ timeout: 45000 });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("unexpected network request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).waitFor();
  assert.equal(await page.locator(".book-card").count(), 1);
  await page.locator(".book-card").filter({ hasText: book.title }).click();
  const editor = page.getByLabel("正文编辑器", { exact: true });
  await editor.waitFor();
  await page
    .locator(".chapter-list .chapter-entry")
    .filter({ hasText: "第二章 损坏" })
    .click();
  await page
    .getByText(/文件 UTF-8 编码无法读取/)
    .first()
    .waitFor();
  assert.match(await editor.innerText(), /正常正文/);
  await page.keyboard.press("Control+s");
  assert.deepEqual(await readFile(manuscript), malformed);
  assert.deepEqual(await readFile(metadataPath), metadata);
  assert.deepEqual(
    await readFile(join(data, "library", book.id, "book.json")),
    validManifest,
  );
  await page.screenshot({ path: join(shots, "editor-rejects-malformed.png") });
  // IPC negative-path integration: an unreadable source must fail before opening a save dialog.
  await app.evaluate(({ dialog }) => {
    globalThis.encodingDialogCalls = 0;
    dialog.showSaveDialog = async () => {
      globalThis.encodingDialogCalls++;
      return { canceled: true };
    };
  });
  const exportError = await page.evaluate(async (bookId) => {
    try {
      await window.novel.request("book.export", { bookId });
      return null;
    } catch (error) {
      return error.message;
    }
  }, book.id);
  assert.match(exportError, /UTF-8/);
  assert.equal(await app.evaluate(() => globalThis.encodingDialogCalls), 0);
  assert.deepEqual(await readFile(manuscript), malformed);
  // Instrument only folder selection; restoration itself runs the actual desktop host code.
  const libraryBeforeRestore = await readdir(join(data, "library"));
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, backup.path);
  const restoreError = await page.evaluate(async () => {
    try {
      await window.novel.request("library.restore");
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert.match(restoreError, /UTF-8/);
  assert.deepEqual(await readdir(join(data, "library")), libraryBeforeRestore);
  assert.deepEqual(await readFile(backupMetadataPath), backupMetadata);
  assert.deepEqual(await readFile(manuscript), malformed);
  report.checks.push(
    "Real desktop restore IPC rejects hash-valid malformed backup metadata before creating a new book or staging directory; folder selection is instrumented, source and backup bytes are unchanged",
  );
  report.checks.push(
    "Actual chapter navigation reports malformed UTF-8, retains the prior editor, and Ctrl+S preserves raw source and metadata bytes",
    "Malformed metadata book is excluded from the usable library without rewriting it; export IPC fails before the instrumented save dialog",
  );
  // External repair is deliberate; the app must recover on the next explicit open.
  const repaired =
    "\ufeff外部修复后的正文。\r\n真实替换字符：\ufffd；生僻字：𠮷";
  await writeFile(manuscript, repaired, "utf8");
  await page
    .locator(".chapter-list .chapter-entry")
    .filter({ hasText: "第二章 损坏" })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="正文编辑器"]')
      ?.textContent?.includes("外部修复后的正文"),
  );
  await page.keyboard.press("Control+s");
  assert.deepEqual(await readFile(manuscript), Buffer.from(repaired));
  assert.deepEqual(await readFile(metadataPath), metadata);
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "Explicit reopen after external UTF-8 repair succeeds and preserves BOM, CRLF, a legitimate replacement character and astral Unicode",
  );
  report.preservedMalformedSha256 = createHash("sha256")
    .update(malformed)
    .digest("hex");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(shots, "utf8-integrity-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (owned) {
      if (report.status === "failed") await terminateOwnedProcesses(owned);
      else {
        await app.close();
        await confirmOwnedProcessesExited(owned);
      }
      report.ownedProcessesConfirmedExited = owned.size;
    }
  } catch (error) {
    report.status = "failed";
    report.cleanupFailure = String(error);
    throw error;
  } finally {
    await writeFile(
      join(shots, "utf8-integrity-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
