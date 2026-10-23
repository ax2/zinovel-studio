import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  parseReadingState,
  resumeReading,
} from "../packages/novel-domain/reading.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-reader-")),
    store = new NovelStore(root);
  const book = await store.importBook("只读合成小说", [
    {
      title: "旧信",
      body: "林舟拆信。🌊\n<script>NOT_EXECUTABLE</script>",
      volume: "卷一",
    },
    { title: "渡口", body: "船离开了渡口。", volume: "卷一" },
    { title: "远海", body: "新的地址。", volume: "卷二" },
  ]);
  return { root, store, book };
}
test("reader projects only public book/chapter metadata, preserves volume order and scopes body reads without touching any primary bytes", async () => {
  const { root, store, book } = await setup(),
    path = join(root, book.id, "book.json"),
    raw = JSON.parse(await readFile(path, "utf8"));
  raw.authorNotes = "UNSELECTED_WORLD_SECRET";
  raw.chapters[0].internalNotes = "INTERNAL_CHAPTER_SECRET";
  await writeFile(path, JSON.stringify(raw));
  const before = await readFile(path),
    catalog = await store.reader.catalog(book.id);
  const chapterPaths = book.chapters.map((item) =>
      join(root, book.id, "manuscript", `${item.id}.md`),
    ),
    manuscriptBytes = await Promise.all(
      chapterPaths.map((path) => readFile(path)),
    );
  assert.deepEqual(
    catalog.chapters.map((item) => item.title),
    ["旧信", "渡口", "远海"],
  );
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET|"body"/);
  assert.equal(catalog.chapters[0].volumeTitle, "卷一");
  const chapter = await store.reader.chapter(
    book.id,
    book.chapters[0].id,
    catalog.hash,
  );
  assert.equal(chapter.body, "林舟拆信。🌊\n<script>NOT_EXECUTABLE</script>");
  assert.equal(chapter.externalChange, false);
  assert.doesNotMatch(
    JSON.stringify(chapter),
    /UNSELECTED_WORLD_SECRET|INTERNAL_CHAPTER_SECRET/,
  );
  await rename(chapterPaths[2], chapterPaths[2] + ".retained");
  assert.equal((await store.reader.catalog(book.id)).chapters.length, 3);
  assert.equal(
    (await store.reader.chapter(book.id, book.chapters[0].id, catalog.hash))
      .body,
    chapter.body,
  );
  await assert.rejects(
    store.reader.chapter(book.id, book.chapters[2].id, catalog.hash),
    /文件失联/,
  );
  await rename(chapterPaths[2] + ".retained", chapterPaths[2]);
  const scoped = await store.reader.catalog(book.id, {
    volumeId: book.volumes[0].id,
  });
  assert.equal(scoped.chapters.length, 2);
  await assert.rejects(
    store.reader.chapter(
      book.id,
      book.chapters[2].id,
      scoped.hash,
      scoped.options,
    ),
    /范围/,
  );
  const other = await store.importBook("他书", [
    { title: "旧信", body: "OTHER_BOOK_PRIVATE" },
  ]);
  await assert.rejects(
    store.reader.chapter(book.id, other.chapters[0].id, catalog.hash),
    /范围/,
  );
  await assert.rejects(
    store.reader.chapter(other.id, other.chapters[0].id, catalog.hash),
    /目录或章节版本/,
  );
  await assert.rejects(
    store.reader.catalog(book.id, { path: "../outside" }),
    /范围/,
  );
  assert.throws(
    () => store.reader.chapter(book.id, "../outside", catalog.hash),
    /目录/,
  );
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(
    await Promise.all(chapterPaths.map((path) => readFile(path))),
    manuscriptBytes,
  );
});
test("directory baseline rejects rename/reorder/deletion and final-only scope follows explicit author status", async () => {
  const { store, book } = await setup();
  let catalog = await store.reader.catalog(book.id);
  const current = await store.readChapter(book.id, book.chapters[0].id);
  const renamed = await store.saveChapter({
    bookId: book.id,
    chapterId: current.id,
    title: "更名旧信",
    body: current.body,
    expectedRevision: current.revision,
    expectedHash: current.diskHash,
  });
  assert.equal(renamed.status, "saved");
  await assert.rejects(
    store.reader.chapter(book.id, current.id, catalog.hash),
    /刷新/,
  );
  catalog = await store.reader.catalog(book.id);
  assert.equal(catalog.chapters[0].title, "更名旧信");
  const moved = await store.updateStructure(book.id, renamed.book.revision, {
    type: "chapter-move",
    chapterId: book.chapters[1].id,
    volumeId: book.volumes[0].id,
    beforeId: current.id,
  });
  await assert.rejects(
    store.reader.chapter(book.id, current.id, catalog.hash),
    /刷新/,
  );
  catalog = await store.reader.catalog(book.id);
  assert.deepEqual(
    catalog.chapters.slice(0, 2).map((item) => item.id),
    [book.chapters[1].id, current.id],
  );
  const next = await store.updateStructure(book.id, moved.revision, {
    type: "chapter-status",
    chapterId: book.chapters[1].id,
    status: "final",
  });
  await assert.rejects(
    store.reader.chapter(book.id, book.chapters[0].id, catalog.hash),
    /刷新/,
  );
  const final = await store.reader.catalog(book.id, { status: "final" });
  assert.deepEqual(
    final.chapters.map((item) => item.id),
    [book.chapters[1].id],
  );
  await store.updateStructure(book.id, next.revision, {
    type: "chapter-trash",
    chapterId: book.chapters[1].id,
  });
  await assert.rejects(
    store.reader.chapter(
      book.id,
      book.chapters[1].id,
      final.hash,
      final.options,
    ),
    /刷新/,
  );
  assert.equal(
    (await store.reader.catalog(book.id, { status: "final" })).chapters.length,
    0,
  );
  catalog = await store.reader.catalog(book.id);
  assert.equal(catalog.chapters.length, 2);
});
test("external text is read at exact current hash, while malformed UTF-8 and missing primary files reject without repair", async () => {
  const { root, store, book } = await setup(),
    catalog = await store.reader.catalog(book.id),
    path = join(root, book.id, "manuscript", `${book.chapters[0].id}.md`);
  await writeFile(path, "外部修改。\n重复段。\n重复段。");
  const chapter = await store.reader.chapter(
    book.id,
    book.chapters[0].id,
    catalog.hash,
  );
  assert.equal(chapter.externalChange, true);
  assert.equal(chapter.body, "外部修改。\n重复段。\n重复段。");
  const bad = Buffer.from([0xff, 0xfe, 0x61]);
  await writeFile(path, bad);
  await assert.rejects(
    store.reader.chapter(book.id, book.chapters[0].id, catalog.hash),
    /UTF-8/,
  );
  assert.deepEqual(await readFile(path), bad);
  await rename(path, path + ".retained");
  await assert.rejects(
    store.reader.chapter(book.id, book.chapters[0].id, catalog.hash),
    /文件失联/,
  );
});
test("reader refuses corrupt/foreign/duplicate directory identities, preserving unsupported primary data", async () => {
  const { root, store, book } = await setup(),
    path = join(root, book.id, "book.json"),
    original = JSON.parse(await readFile(path, "utf8"));
  for (const changed of [
    { ...original, id: randomUUID() },
    { ...original, chapters: [original.chapters[0], original.chapters[0]] },
    { ...original, chapters: [{ ...original.chapters[0], id: "../outside" }] },
  ]) {
    const raw = JSON.stringify(changed);
    await writeFile(path, raw);
    await assert.rejects(store.reader.catalog(book.id), /身份/);
    assert.equal(await readFile(path, "utf8"), raw);
  }
});
test("reading progress never borrows another book or guesses a location after source changes; future state remains unreadable", () => {
  const bookId = randomUUID(),
    chapterId = randomUUID(),
    bodyHash = "a".repeat(64),
    defaults = parseReadingState(null, bookId);
  const state = {
    ...defaults,
    progress: { chapterId, bodyHash, paragraph: 12 },
  };
  assert.deepEqual(parseReadingState(JSON.stringify(state), bookId), state);
  assert.deepEqual(
    resumeReading(state.progress, { id: chapterId, bodyHash }, 8),
    { paragraph: 7, changed: false },
  );
  assert.deepEqual(
    resumeReading(
      state.progress,
      { id: chapterId, bodyHash: "b".repeat(64) },
      30,
    ),
    { paragraph: 0, changed: true },
  );
  for (const changed of [
    { ...state, bookId: randomUUID() },
    { ...state, futureFlag: true },
    { ...state, schemaVersion: 2 },
    { ...state, progress: { ...state.progress, paragraph: -1 } },
  ])
    assert.throws(() => parseReadingState(JSON.stringify(changed), bookId));
});
