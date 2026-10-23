import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cpus, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { validateMaterialInput } from "../packages/novel-domain/materials.mjs";

const root = resolve(import.meta.dirname, ".."),
  label = process.argv[2] || "current",
  runs = Number(process.argv[3] || 3);
if (
  !/^[a-z0-9-]+$/.test(label) ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 5
)
  throw new Error("Invalid benchmark arguments");
await mkdir(join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(join(root, ".cache", "continuity-benchmark-"));
const store = new NovelStore(join(directory, "library"));
const body = "长篇正文依然可以独立修改。\n".repeat(5000);
const book = await store.importBook("全书证据合成基准", [
  { title: "正文保存响应", body },
]);
let chapter = await store.readChapter(book.id, book.chapters[0].id);
const input = {
  kind: "character",
  title: "角色模板",
  status: "accepted",
  fields: {},
  notes: "合成角色计划",
  chapterIds: [],
};
let a = await store.materials.save(book.id, input),
  b = await store.materials.save(book.id, { ...input, title: "关联模板" });
a = await store.materials.mutateEvidence(book.id, a, {
  action: "add",
  kind: "relation",
  scope: "world",
  statement: "原始关系",
  storyTime: "故事的过去",
  relatedIds: [b.id],
  source: {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 10,
  },
});
const template = JSON.parse(JSON.stringify(a));
delete template.diskHash;
delete template.chapters;
const ids = [a.id, b.id, ...Array.from({ length: 498 }, () => randomUUID())];
const cards = ids.map((id, index) => ({
  ...template,
  id,
  title: `角色${String(index).padStart(4, "0")}`,
  evidence: [],
}));
const definitionHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(validateMaterialInput(value)))
    .digest("hex");
const startFixture = performance.now();
for (let offset = 0; offset < cards.length; offset += 25)
  await Promise.all(
    cards.slice(offset, offset + 25).map(async (card, localIndex) => {
      const index = offset + localIndex,
        targets = [
          cards[(index + 1) % cards.length],
          cards[(index + 2) % cards.length],
        ];
      card.evidence = Array.from({ length: 10 }, (_, eventIndex) => ({
        ...a.evidence[0],
        id: randomUUID(),
        statement: `关系变化 ${index}/${eventIndex}`,
        relatedIds: targets.map((item) => item.id),
        dependencies: targets.map((item) => ({
          id: item.id,
          revision: item.revision,
          definitionHash: definitionHash(item),
        })),
      }));
      await writeFile(
        join(directory, "library", book.id, "materials", `${card.id}.json`),
        JSON.stringify(card),
      );
    }),
  );
const report = {
  status: "measured",
  label,
  environment: {
    os: release(),
    cpu: cpus()[0]?.model,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
  },
  sourceCards: 500,
  evidenceEvents: 5000,
  relatedTargetsPerEvent: 2,
  manuscriptCharacters: body.length,
  fixtureMs: Math.round(performance.now() - startFixture),
  metrics: [],
  checks: [],
};
const originalRecord = store.materials.record.bind(store.materials),
  originalView = store.materials.view.bind(store.materials);
try {
  for (let iteration = 0; iteration < runs; iteration++) {
    let records = 0,
      resolveStarted,
      notified = false;
    const durations = [];
    const viewStarted = new Promise((resolve) => (resolveStarted = resolve));
    store.materials.record = async (...args) => {
      records++;
      return originalRecord(...args);
    };
    store.materials.view = async (...args) => {
      const start = performance.now();
      if (!notified) {
        notified = true;
        resolveStarted();
      }
      const result = await originalView(...args);
      durations.push(performance.now() - start);
      return result;
    };
    const queryStart = performance.now();
    const query = store.continuity.query(book.id, {
      kind: "relation",
      includeRelations: true,
    });
    await viewStarted;
    const saveStart = performance.now();
    const saved = await store.saveChapter({
      bookId: book.id,
      chapterId: chapter.id,
      title: chapter.title,
      body: `第 ${iteration + 1} 次并发保存。\n` + chapter.body,
      expectedRevision: chapter.revision,
      expectedHash: chapter.diskHash,
    });
    const saveMs = Math.round(performance.now() - saveStart);
    assert.equal(saved.status, "saved");
    chapter = saved.chapter;
    const result = await query,
      queryMs = Math.round(performance.now() - queryStart);
    assert.equal(result.total, 5000);
    assert.equal(result.relationships.totalEvents, 5000);
    assert.equal(result.errors.length, 0);
    assert.equal(
      result.relationships.events.length + result.relationships.omittedEvents,
      5000,
    );
    assert.ok(result.relationships.nodes.length <= 24);
    assert.equal(result.items.length, 40);
    durations.sort((x, y) => x - y);
    const metric = {
      queryMs,
      saveWhileReadingCardMs: saveMs,
      materialRecordReads: records,
      cardViewP95Ms: Math.round(durations[Math.floor(durations.length * 0.95)]),
      cardViewMaxMs: Math.round(durations.at(-1)),
    };
    const focusedStart = performance.now(),
      focusedReads = records;
    const focused = await store.continuity.query(book.id, {
      kind: "relation",
      includeRelations: true,
      participantId: ids[0],
    });
    metric.focusedQueryMs = Math.round(performance.now() - focusedStart);
    metric.focusedMaterialReads = records - focusedReads;
    assert.equal(
      focused.total,
      30,
      "focus includes ten owned and twenty incoming events",
    );
    assert.equal(focused.relationships.totalEvents, 30);
    report.metrics.push(metric);
    console.log({ iteration: iteration + 1, ...metric });
  }
  report.checks.push(
    "all 5000 relationship events counted with no errors; graph caps do not hide table total; per-card concurrent manuscript save completed with CAS and exact source identity",
  );
  report.initialTargets = {
    searchMs: 500,
    saveMs: 1000,
    metSearch: report.metrics.every((item) => item.queryMs < 500),
    metSave: report.metrics.every((item) => item.saveWhileReadingCardMs < 1000),
  };
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  throw error;
} finally {
  store.materials.record = originalRecord;
  store.materials.view = originalView;
  await mkdir(join(root, "assessments/stage-004"), { recursive: true });
  await writeFile(
    join(root, `assessments/stage-004/continuity-benchmark-${label}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
