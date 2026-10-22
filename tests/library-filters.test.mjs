import test from "node:test";
import assert from "node:assert/strict";
import { selectBooks } from "../packages/novel-domain/library.mjs";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("100-book filtering intersects genre/series/archive and deterministically sorts without mutating source", () => {
  const books = Array.from({ length: 100 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    title: `合成${i}`,
    author: i % 2 ? "甲" : "乙",
    genre: i % 2 ? "悬疑" : "幻想",
    series: i % 3 ? "北港" : "南港",
    archivedAt: i < 10 ? "2026-01-01" : undefined,
    updatedAt: String(i).padStart(3, "0"),
  }));
  const original = JSON.stringify(books);
  assert.equal(selectBooks(books).length, 90);
  assert.equal(selectBooks(books, { archived: "archived" }).length, 10);
  const selected = selectBooks(books, {
    genre: "悬疑",
    series: "南港",
    query: "甲",
  });
  assert.deepEqual(
    selected.map((book) => Number(book.id)),
    [99, 93, 87, 81, 75, 69, 63, 57, 51, 45, 39, 33, 27, 21, 15],
  );
  assert.equal(JSON.stringify(books), original);
});

test("whole-book archival and volume reordering preserve text and IDs across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new NovelStore(root);
  let book = await store.importBook("归档合成", [
    { title: "前章", body: "原稿一", volume: "卷一" },
    { title: "后章", body: "原稿二", volume: "卷二" },
  ]);
  const ids = book.chapters.map((chapter) => chapter.id),
    volumes = book.volumes.map((volume) => volume.id);
  book = await store.updateStructure(book.id, book.revision, {
    type: "volume-move",
    volumeId: volumes[1],
    beforeId: volumes[0],
  });
  assert.deepEqual(
    (await store.exportSnapshot(book.id)).chapters.map((chapter) => chapter.id),
    ids.toReversed(),
  );
  book = await store.updateStructure(book.id, book.revision, {
    type: "book-archive",
    archived: true,
  });
  assert.ok((await new NovelStore(root).listBooks()).books[0].archivedAt);
  book = await store.updateStructure(book.id, book.revision, {
    type: "book-archive",
    archived: false,
  });
  assert.equal(book.archivedAt, undefined);
  assert.equal(
    await readFile(join(root, book.id, "manuscript", `${ids[0]}.md`), "utf8"),
    "原稿一",
  );
  assert.deepEqual(
    book.volumes.map((volume) => volume.id),
    volumes.toReversed(),
  );
});
