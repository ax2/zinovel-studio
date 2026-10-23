import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const root = resolve(import.meta.dirname, ".."),
  count = 5000;
await mkdir(join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(join(root, ".cache", "materials-benchmark-")),
  store = new NovelStore(join(directory, "library"));
const book = await store.importBook("五千资料合成长篇", [
  { title: "正文保存响应", body: "作者写作不应被资料检索长时间阻塞。" },
]);
await mkdir(join(directory, "library", book.id, "materials"));
const fixtureStart = performance.now();
for (let offset = 0; offset < count; offset += 25)
  await Promise.all(
    Array.from({ length: Math.min(25, count - offset) }, async (_, index) => {
      const i = offset + index,
        id = randomUUID();
      const data = {
        schemaVersion: 1,
        id,
        kind: "character",
        title: `人物 ${i}`,
        status: "planned",
        notes:
          "人物设想、目标、动机与后续变化。".repeat(100) +
          (i === count - 1 ? "检索末尾哨兵" : ""),
        fields: { voice: "少用形容词，多用动作表现" },
        chapterIds: [],
        evidence: [],
        revision: 1,
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
      };
      await writeFile(
        join(directory, "library", book.id, "materials", `${id}.json`),
        JSON.stringify(data),
      );
    }),
  );
const report = {
  status: "measured",
  environment: {
    os: release(),
    cpu: cpus()[0]?.model,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.versions.node,
  },
  records: count,
  notesCharactersPerRecord: "人物设想、目标、动机与后续变化。".repeat(100)
    .length,
  fixtureBuildMs: Math.round(performance.now() - fixtureStart),
  metrics: {},
  checks: [],
};
const timings = [];
for (let run = 0; run < 3; run++) {
  const start = performance.now(),
    result = await store.materials.list(book.id, { query: "检索末尾哨兵" });
  timings.push(Math.round(performance.now() - start));
  assert.equal(result.total, 1);
}
report.metrics.searchMs = timings;
let chapter = await store.readChapter(book.id, book.chapters[0].id);
const scan = store.materials.list(book.id);
await new Promise((resolve) => setTimeout(resolve, 20));
const saveStart = performance.now();
await store.saveChapter({
  bookId: book.id,
  chapterId: chapter.id,
  title: chapter.title,
  body: chapter.body + "\n检索时继续写作。",
  expectedRevision: chapter.revision,
  expectedHash: chapter.diskHash,
});
report.metrics.saveWhileScanningMs = Math.round(performance.now() - saveStart);
assert.equal((await scan).total, count);
assert.equal(
  (await store.readChapter(book.id, chapter.id)).body,
  chapter.body + "\n检索时继续写作。",
);
report.checks.push(
  "5,000 synthetic typed records scanned without omissions; unique tail query exact; concurrent requested manuscript save eventually persists exact bytes",
);
report.meetsInitialTargets = {
  searchUnder500ms: Math.max(...timings) < 500,
  saveUnder1000ms: report.metrics.saveWhileScanningMs < 1000,
};
const output =
  process.argv[2] ||
  join(root, "assessments", "stage-004", "materials-benchmark.json");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(report);
