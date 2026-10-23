import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, ".."),
  label = process.argv[2] || "current",
  count = Number(process.argv[3] || 1000);
if (
  !/^[a-z0-9-]+$/.test(label) ||
  !Number.isInteger(count) ||
  count < 40 ||
  count > 5000
)
  throw new Error("Invalid benchmark arguments");
await mkdir(join(root, ".cache"), { recursive: true });
const data = await mkdtemp(join(root, ".cache", "knowledge-benchmark-")),
  store = new NovelStore(join(data, "library"));
const book = await store.importBook("认知扫描合成基准", [
  { title: "港口", body: "旧信有一道蓝印。\n".repeat(1000) },
]);
let chapter = await store.readChapter(book.id, book.chapters[0].id);
const make = (kind, title, fields = {}) =>
  store.materials.save(book.id, {
    kind,
    title,
    fields,
    notes: "合成性能数据",
    status: "planned",
    chapterIds: [],
  });
const p = await make("proposition", "寄信人", { claim: "船主寄信" }),
  person = await make("character", "林舟");
const event = await store.knowledge.save(
  book.id,
  {
    propositionId: p.id,
    scope: "character",
    characterId: person.id,
    state: "believes",
    statement: "人物尚未证实寄信人",
    storyTime: "抵港日",
  },
  null,
  {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  },
);
await store.knowledge.choices.select(book.id, event, null);
const eventsRoot = join(data, "library", book.id, "knowledge/events"),
  record = JSON.parse(
    await readFile(join(eventsRoot, `${event.id}.json`), "utf8"),
  );
const fixtureStart = performance.now();
// Seed valid independent primary files in small batches; no fabricated history.
for (let offset = 1; offset < count; offset += 32)
  await Promise.all(
    Array.from({ length: Math.min(32, count - offset) }, (_, n) => {
      const id = randomUUID();
      return writeFile(
        join(eventsRoot, `${id}.json`),
        JSON.stringify({ ...record, id, statement: `合成认知 ${offset + n}` }),
      );
    }),
  );
const report = {
  status: "measuring",
  label,
  version: JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    .version,
  environment: {
    os: release(),
    cpu: cpus()[0]?.model,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
  },
  fixture: {
    events: count,
    propositions: 1,
    characters: 1,
    authorChoices: 1,
    chapters: 1,
    manuscriptCharacters: chapter.body.length,
    setupMs: Math.round(performance.now() - fixtureStart),
  },
  metrics: {},
  checks: [],
  limitations: [
    "Storage service measurements only; no rendered DOM, cold disk, low-end hardware or real model literary evaluation",
    "One proposition and character; not a full 1000-chapter or many-definition acceptance dataset",
    "Source fixture is synthetic; warm-cache effects and host background load are not controlled",
  ],
};
const originalView = store.knowledge.view.bind(store.knowledge);
let notify,
  viewCalls = 0;
store.knowledge.view = async (...args) => {
  viewCalls++;
  notify?.();
  notify = null;
  return originalView(...args);
};
try {
  let started = new Promise((resolve) => {
    notify = resolve;
  });
  const queryStart = performance.now(),
    query = store.context.choices(book.id, { kind: "knowledge" });
  await started;
  const saveStart = performance.now();
  const saved = await store.saveChapter({
    bookId: book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: "明确作者改稿。\n" + chapter.body,
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  assert.equal(saved.status, "saved");
  chapter = saved.chapter;
  report.metrics.saveWhileScanningMs = Math.round(
    performance.now() - saveStart,
  );
  const options = await query;
  report.metrics.contextQueryMs = Math.round(performance.now() - queryStart);
  report.metrics.contextEventViews = viewCalls;
  assert.equal(options.total, count);
  assert.equal(options.items.length, 40);
  assert.deepEqual(options.errors, []);
  const matrixStart = performance.now(),
    matrix = await store.knowledge.matrix(book.id, {
      characterIds: [person.id],
    });
  report.metrics.matrixMs = Math.round(performance.now() - matrixStart);
  assert.equal(matrix.rows[0].cells[person.id].total, count);
  assert.equal(matrix.rows[0].cells[person.id].events.length, 5);
  assert.deepEqual(matrix.errors, []);
  const controller = new AbortController();
  started = new Promise((resolve) => {
    notify = resolve;
  });
  const beforeCancelViews = viewCalls,
    pending = store.context.choices(
      book.id,
      { kind: "knowledge" },
      controller.signal,
    );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started;
  const cancelStart = performance.now();
  controller.abort();
  await rejected;
  report.metrics.cancelMs = Math.round(performance.now() - cancelStart);
  report.metrics.cancelEventViews = viewCalls - beforeCancelViews;
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  report.initialTargets = {
    queryMs: 500,
    saveMs: 1000,
    cancelMs: 500,
    metQuery:
      report.metrics.contextQueryMs < 500 && report.metrics.matrixMs < 500,
    metSave: report.metrics.saveWhileScanningMs < 1000,
    metCancel: report.metrics.cancelMs < 500,
  };
  report.checks.push(
    "all records counted; options bounded to 40 and matrix cell preview to 5; source edit queued during a real event view saved with CAS; cancellation aborted remaining scan and preserved author bytes",
  );
  report.status = "measured";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  throw error;
} finally {
  store.knowledge.view = originalView;
  await mkdir(join(root, "assessments/stage-004"), { recursive: true });
  await writeFile(
    join(root, `assessments/stage-004/knowledge-benchmark-${label}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
