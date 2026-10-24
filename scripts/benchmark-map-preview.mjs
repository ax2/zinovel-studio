import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";

// Single synthetic boundary observation; not a percentile or whole-book benchmark.
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache/map-boundary-"));
const pixels = Buffer.alloc(5000 * 4000 * 3);
let seed = 123456789;
for (let i = 0; i < pixels.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  pixels[i] = seed & 255;
}
const original = await sharp(pixels, {
  raw: { width: 5000, height: 4000, channels: 3 },
})
  .jpeg({ quality: 85 })
  .toBuffer();
assert.ok(original.length <= 20 * 1024 * 1024);
const store = new NovelStore(join(work, "library"));
const book = await store.importBook("高纹理地图合成边界", [
  { title: "旧信", body: "边界测量原稿。" },
]);
const chapter = await store.readChapter(book.id, book.chapters[0].id);
const startImport = performance.now();
const asset = await store.assets.import(book.id, original, {
  title: "20MP合成纹理",
  purpose: "map",
  source: "固定种子程序合成",
  rights: "本地验收",
  notes: "非成品美术",
  linkedIds: [],
});
const importMs = performance.now() - startImport;
let map = await store.maps.create(book.id, {
  title: "纹理地图",
  notes: "",
  era: "",
  canvas: { width: 1000, height: 700 },
  scale: null,
  elements: [],
});
map = await store.maps.setBackground(book.id, map, asset);
let entered,
  decodeFinished = false,
  peakRss = process.memoryUsage().rss;
const begun = new Promise((resolve) => (entered = resolve)),
  decode = store.assets.decode.bind(store.assets);
store.assets.decode = (...args) => {
  const result = decode(...args);
  entered();
  return result.finally(() => (decodeFinished = true));
};
const sample = setInterval(
  () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
  5,
);
const startPreview = performance.now(),
  pending = store.maps.backgroundPreview(book.id, map);
let report;
try {
  await begun;
  const saveStart = performance.now();
  await store.saveChapter({
    bookId: book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: "真实地图预览解码期间保存原稿。𠮷🌊",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  const saveMs = performance.now() - saveStart,
    saveFinishedBeforeDecode = !decodeFinished;
  const preview = await pending,
    previewMs = performance.now() - startPreview;
  const derived = Buffer.from(preview.dataUrl.split(",")[1], "base64"),
    meta = await sharp(derived).metadata();
  assert.equal(meta.width, 2048);
  assert.equal(meta.height, 1638);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    "真实地图预览解码期间保存原稿。𠮷🌊",
  );
  assert.equal(
    preview.background.record.blob.sha256,
    createHash("sha256").update(original).digest("hex"),
  );
  report = {
    status: "passed",
    node: process.versions.node,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    fixture: {
      width: 5000,
      height: 4000,
      pixels: 20000000,
      format: "jpeg",
      bytes: original.length,
      seed: 123456789,
      quality: 85,
    },
    importMs,
    previewMs,
    saveMs,
    saveFinishedBeforeDecode,
    derived: { width: meta.width, height: meta.height, bytes: derived.length },
    peakRssBytes: peakRss,
    scope:
      "Single actual high-texture 20MP source-module observation using embedded Node; no synthetic decoder delay, no P95, 20MiB capacity or installed GUI performance claim",
  };
} finally {
  clearInterval(sample);
}
const output = join(root, "assessments/stage-006");
await mkdir(output, { recursive: true });
report.sources = {};
for (const file of [
  "packages/novel-storage/maps.mjs",
  "packages/novel-storage/assets.mjs",
  "packages/novel-storage/image-decoder.mjs",
  "scripts/benchmark-map-preview.mjs",
])
  report.sources[file] = createHash("sha256")
    .update(await readFile(join(root, file)))
    .digest("hex");
await writeFile(
  join(output, "maps-boundary.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
