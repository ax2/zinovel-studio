import { _electron as electron } from "playwright";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "publication-host-"));
const store = new NovelStore(join(data, "library"));
const book = await store.importBook(
  "发布捕获宿主合成稿",
  Array.from({ length: 256 }, (_, index) => ({
    title: `第${index + 1}章 合成稿`,
    body:
      index === 0
        ? "\ufeffFIRST_SOURCE_SENTINEL𠮷\r\n第一章结尾。"
        : `第${index + 1}章：${"合成正文。🌊".repeat(40)}`,
  })),
);
await store.materials.save(book.id, {
  kind: "proposition",
  title: "PRIVATE_AUTHOR_SENTINEL",
  notes: "EXCLUDED_WORLD_SECRET",
  status: "planned",
  fields: { claim: "未来作者秘密", truthIntent: "作者设定为真" },
  chapterIds: [],
});
const file = join(
    data,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  ),
  before = await readFile(file);
const shots = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "publication-capture",
);
await mkdir(shots, { recursive: true });
const env = { ...process.env, ZINOVEL_DATA_ROOT: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.ZINOVEL_TEST_EXECUTABLE) {
  for (const name of Object.keys(env))
    if (name.toLowerCase() === "path") delete env[name];
  env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
}
const report = {
  status: "running",
  checks: [],
  errors: [],
  scope:
    "Real desktop IPC capture/persistence only; no author publication dialog or export UI qualification",
};
let app, page, owned;
async function launch() {
  app = await electron.launch({
    executablePath: process.env.ZINOVEL_TEST_EXECUTABLE || electronPath,
    args: process.env.ZINOVEL_TEST_EXECUTABLE ? [] : [root],
    cwd: process.env.ZINOVEL_TEST_EXECUTABLE ? data : root,
    env,
    timeout: 45000,
  });
  owned = await captureOwnedProcesses(app.process().pid);
  page = await app.firstWindow();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      report.errors.push("unexpected network request");
  });
  await page.locator(".book-card").filter({ hasText: book.title }).waitFor();
}
async function request(action, payload = {}) {
  return page.evaluate(
    ({ action, payload }) => window.novel.request(action, payload),
    { action, payload: { bookId: book.id, ...payload } },
  );
}
async function terminal(id) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const status = await request("publication.capture-status", { id });
    if (["completed", "cancelled", "failed"].includes(status.status))
      return status;
    await page.waitForTimeout(20);
  }
  throw new Error("Publication capture did not settle");
}
async function close() {
  await app.close();
  await confirmOwnedProcessesExited(owned);
  app = null;
  owned = null;
}
try {
  await launch();
  const catalog = await request("publication.catalog");
  const metadata = {
    title: "公开选章",
    author: "合成作者",
    synopsis: "公开简介",
    rights: "合成数据",
    aiDisclosure: "测试文本",
  };
  const cancelJob = await request("publication.capture", {
    input: {
      catalogHash: catalog.hash,
      chapterIds: catalog.chapters.map((ch) => ch.id),
      metadata,
    },
  });
  const cancellation = await request("publication.cancel", {
    id: cancelJob.id,
  });
  assert.equal(cancellation.cancelled, true);
  assert.equal((await terminal(cancelJob.id)).status, "cancelled");
  assert.equal((await request("publication.list")).snapshots.length, 0);
  const selected = [book.chapters[1].id, book.chapters[0].id];
  const job = await request("publication.capture", {
    input: { catalogHash: catalog.hash, chapterIds: selected, metadata },
  });
  const status = await terminal(job.id);
  assert.equal(status.status, "completed", status.error || "capture failed");
  const { id, hash } = status.result;
  const preview = await request("publication.preview", { id, hash });
  assert.deepEqual(
    preview.content.chapters.map((ch) => ch.id),
    selected,
  );
  assert.ok(preview.content.chapters.every((ch) => !("body" in ch)));
  assert.doesNotMatch(
    JSON.stringify(preview),
    /PRIVATE_AUTHOR_SENTINEL|EXCLUDED_WORLD_SECRET|FIRST_SOURCE_SENTINEL/,
  );
  const chapter = await request("publication.chapter", {
    id,
    hash,
    chapterId: book.chapters[0].id,
  });
  assert.equal(chapter.body, before.toString("utf8"));
  const originalSnapshot = await store.publication.read(book.id, id, hash);
  await writeFile(file, "作者捕获后明确外部改稿。", "utf8");
  assert.equal(
    (
      await request("publication.chapter", {
        id,
        hash,
        chapterId: book.chapters[0].id,
      })
    ).body,
    before.toString("utf8"),
  );
  const foreignError = await page.evaluate(
    async ({ bookId, id, hash, chapterId }) => {
      try {
        await window.novel.request("publication.chapter", {
          bookId,
          id,
          hash,
          chapterId,
        });
        return null;
      } catch (error) {
        return error.message;
      }
    },
    { bookId: book.id, id, hash, chapterId: book.chapters[2].id },
  );
  assert.match(foreignError, /不属于/);
  await close();
  await launch();
  assert.equal((await request("publication.list")).snapshots.length, 1);
  assert.deepEqual(
    await store.publication.read(book.id, id, hash),
    originalSnapshot,
  );
  assert.equal(
    (
      await request("publication.chapter", {
        id,
        hash,
        chapterId: book.chapters[0].id,
      })
    ).body,
    before.toString("utf8"),
  );
  assert.equal(await readFile(file, "utf8"), "作者捕获后明确外部改稿。");
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "real window-bound IPC cancels a 256-chapter capture before commit without creating a snapshot",
    "explicit reordered two-chapter capture persists; preview metadata excludes body/private author materials, chapter IPC returns exact BOM/CRLF/astral text and rejects out-of-scope chapters",
    "external author edit and full desktop restart preserve the original frozen snapshot; no manuscript conversion, model request or automatic replay",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  await writeFile(
    join(shots, "publication-capture-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
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
      join(shots, "publication-capture-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  }
}
