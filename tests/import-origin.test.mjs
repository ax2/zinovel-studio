import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rename,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { ImportSessions } from "../packages/novel-storage/import-session.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-origin-")),
    source = join(root, "原稿𠮷.txt");
  const original = "第一卷 雨港\n第一章 信\n甲𠮷🙂乙\n第二章 灯\n尾声";
  await writeFile(source, original);
  const store = new NovelStore(join(root, "library"));
  await store.initialize();
  const sessions = new ImportSessions({
    applicationVersion: "0.1.0-alpha.38",
    createBook: (title, chapters, metadata) =>
      store.importBook(title, chapters, metadata),
  });
  const selected = await sessions.choose([source]);
  return { root, source, original, store, sessions, selected };
}

test("confirmed source metadata is in the same creation transaction and contains no absolute source path or duplicated manuscript", async () => {
  const { root, source, original, store, sessions, selected } = await fixture();
  const edited = sessions.edit(selected.id, selected.revision, {
    type: "split",
    chapterId: selected.preview.chapters[0].id,
    offset: 3,
    title: "后半",
  });
  const book = await sessions.commit(
    edited.id,
    edited.revision,
    "导入确认合成书",
  );
  const result = await store.importOrigins.read(book.id),
    origin = result.origin;
  assert.equal(result.restoredCopy, false);
  assert.equal(origin.importedBookId, book.id);
  assert.equal(origin.originalChapterCount, 2);
  assert.equal(origin.chapters.length, 3);
  assert.equal(origin.manualAdjustmentCount, 1);
  assert.equal(origin.applicationVersion, "0.1.0-alpha.38");
  assert.equal(origin.encoding, "utf-8");
  assert.equal(origin.automaticSplit, true);
  assert.deepEqual(origin.sources, [
    {
      name: "原稿𠮷.txt",
      bytes: Buffer.byteLength(original),
      sha256: hash(original),
    },
  ]);
  assert.deepEqual(
    origin.chapters.map((x) => x.id),
    book.chapters.map((x) => x.id),
  );
  assert.deepEqual(
    origin.chapters.map((x) => x.sha256),
    book.chapters.map((x) => x.hash),
  );
  const dir = join(store.root, book.id),
    raw = await readFile(join(dir, ".zinovel/import-origin.json"), "utf8");
  assert.equal(raw.includes(root), false);
  assert.equal(raw.includes(source), false);
  assert.equal(raw.includes("甲𠮷🙂乙"), false);
  const names = await readdir(join(dir, ".zinovel/transactions"));
  assert.equal(names.length, 1);
  const transaction = JSON.parse(
    await readFile(join(dir, ".zinovel/transactions", names[0]), "utf8"),
  );
  assert.equal(
    transaction.entries.find((x) => x.path === ".zinovel/import-origin.json")
      .after,
    raw,
  );
  assert.equal(
    transaction.entries.some((x) => x.path === "book.json"),
    true,
  );
  assert.equal(
    transaction.entries.filter((x) => x.path.startsWith("manuscript/")).length,
    3,
  );
  assert.equal(await readFile(source, "utf8"), original);
});

test("backup restore keeps exact import record and chapter IDs while recognizing the restored book lineage", async () => {
  const { root, store, sessions, selected } = await fixture();
  const book = await sessions.commit(
    selected.id,
    selected.revision,
    "来源恢复合成书",
  );
  const before = await readFile(
    join(store.root, book.id, ".zinovel/import-origin.json"),
  );
  const backup = await store.createBackup(book.id, join(root, "backup"));
  const restored = await store.restoreBackup(backup.path),
    result = await store.importOrigins.read(restored.id);
  assert.notEqual(restored.id, book.id);
  assert.equal(result.restoredCopy, true);
  assert.equal(result.origin.importedBookId, book.id);
  assert.deepEqual(
    result.origin.chapters.map((x) => x.id),
    restored.chapters.map((x) => x.id),
  );
  assert.deepEqual(
    await readFile(
      join(store.root, restored.id, ".zinovel/import-origin.json"),
    ),
    before,
  );
  const other = await store.importBook("别书", [
    { title: "章", body: "另一书原稿" },
  ]);
  const otherPath = join(store.root, other.id, ".zinovel/import-origin.json");
  await writeFile(otherPath, before);
  await assert.rejects(store.importOrigins.read(other.id), /其他作品/);
  assert.deepEqual(await readFile(otherPath), before);
});

test("unknown, malformed and oversized origin records stay byte-identical and never appear as an empty legacy record", async () => {
  const { store, sessions, selected } = await fixture();
  const legacy = await store.importBook("旧版合成书", [
    { title: "章", body: "旧原稿" },
  ]);
  assert.deepEqual(await store.importOrigins.read(legacy.id), {
    origin: null,
    restoredCopy: false,
  });
  const book = await sessions.commit(selected.id, selected.revision, "新导入"),
    path = join(store.root, book.id, ".zinovel/import-origin.json");
  const origin = (await store.importOrigins.read(book.id)).origin;
  for (const raw of [
    "{ broken",
    JSON.stringify({ ...origin, schemaVersion: 99 }),
    JSON.stringify({ ...origin, unexpectedFutureField: "keep" }),
  ]) {
    await writeFile(path, raw);
    await assert.rejects(store.importOrigins.read(book.id), /损坏|版本不支持/);
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await truncate(path, 8 * 1024 * 1024 + 1);
  await assert.rejects(store.importOrigins.read(book.id), /过大/);
  assert.equal((await readFile(path)).length, 8 * 1024 * 1024 + 1);
});

test("a replayed partial creation log recovers both book manifest and receipt through the one storage kernel", async () => {
  const { store, sessions, selected } = await fixture();
  const book = await sessions.commit(
      selected.id,
      selected.revision,
      "恢复事务合成书",
    ),
    dir = join(store.root, book.id);
  const files = await readdir(join(dir, ".zinovel/transactions")),
    raw = await readFile(join(dir, ".zinovel/transactions", files[0]));
  const expected = await readFile(join(dir, ".zinovel/import-origin.json"));
  await rename(
    join(dir, "book.json"),
    join(dir, ".zinovel/fixture-before-book.json"),
  );
  await rename(
    join(dir, ".zinovel/import-origin.json"),
    join(dir, ".zinovel/fixture-before-origin.json"),
  );
  await writeFile(join(dir, ".zinovel/pending.json"), raw);
  const reopened = new NovelStore(store.root),
    result = await reopened.importOrigins.read(book.id);
  assert.equal(result.origin.importedBookId, book.id);
  assert.deepEqual(
    await readFile(join(dir, ".zinovel/import-origin.json")),
    expected,
  );
  assert.equal(await readFile(join(dir, ".zinovel/pending.json"), "utf8"), "");
});

test("queued import captures chapter and receipt inputs before the caller can mutate their references", async () => {
  const { store } = await fixture();
  const chapters = [{ title: "原章名", body: "原确认正文", volume: "原卷" }];
  const metadata = {
    applicationVersion: "0.1.0-alpha.38",
    encoding: "utf-8",
    automaticSplit: false,
    originalChapterCount: 1,
    manualAdjustmentCount: 0,
    sources: [
      {
        name: "原稿.txt",
        bytes: 3,
        sha256: hash("abc"),
        path: "D:/private/should-not-persist.txt",
      },
    ],
  };
  const pending = store.importBook("队列合成书", chapters, metadata);
  chapters[0].body = "调用后修改";
  metadata.sources[0].name = "调用后修改.txt";
  const book = await pending;
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    "原确认正文",
  );
  assert.equal(
    (await store.importOrigins.read(book.id)).origin.sources[0].name,
    "原稿.txt",
  );
});

test("invalid source metadata cannot create a partial book or persist an absolute filename", async () => {
  const { store } = await fixture();
  const input = {
    encoding: "utf-8",
    automaticSplit: true,
    originalChapterCount: 1,
    manualAdjustmentCount: 0,
    sources: [{ name: "D:\\private\\原稿.txt", bytes: 3, sha256: hash("abc") }],
  };
  await assert.rejects(
    store.importBook("不得创建", [{ title: "章", body: "正文" }], input),
    /来源说明无效/,
  );
  assert.equal((await store.listBooks()).books.length, 0);
  assert.deepEqual(await readdir(store.root), []);
});

test("public publication snapshots exclude private source filenames and raw source fingerprints", async () => {
  const { store, sessions, selected } = await fixture();
  const book = await sessions.commit(
    selected.id,
    selected.revision,
    "内部书名",
  );
  const origin = (await store.importOrigins.read(book.id)).origin;
  const publication = await store.publication.capture(book.id, {
    catalogHash: (await store.publication.catalog(book.id)).hash,
    chapterIds: book.chapters.map((chapter) => chapter.id),
    metadata: {
      title: "公开书名",
      author: "合成作者",
      synopsis: "公开简介",
      rights: "合成材料",
      aiDisclosure: "合成测试",
    },
  });
  const serialized = JSON.stringify(publication);
  assert.equal(serialized.includes(origin.sources[0].name), false);
  assert.equal(serialized.includes(origin.sources[0].sha256), false);
  assert.equal(serialized.includes("import-origin"), false);
});
