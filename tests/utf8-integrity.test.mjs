import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-utf8-")),
    store = new NovelStore(root);
  const book = await store.importBook("MetadataBook", [
    { title: "编码合成稿", body: "完整原稿。𠮷🌊" },
  ]);
  const directory = join(root, book.id),
    chapter = await store.readChapter(book.id, book.chapters[0].id);
  return {
    root,
    store,
    book,
    chapter,
    directory,
    file: join(directory, "manuscript", chapter.id + ".md"),
  };
}
const badBytes = () =>
  Buffer.concat([
    Buffer.from("开头"),
    Buffer.from([0xff]),
    Buffer.from("结尾"),
  ]);
test("editor read, search and export reject malformed UTF-8 without manufacturing replacement text", async () => {
  const f = await fixture(),
    bad = badBytes();
  await writeFile(f.file, bad);
  await assert.rejects(f.store.readChapter(f.book.id, f.chapter.id), /UTF-8/);
  await assert.rejects(f.store.search(f.book.id, "开头"), /UTF-8/);
  await assert.rejects(f.store.exportSnapshot(f.book.id), /UTF-8/);
  assert.deepEqual(await readFile(f.file), bad);
});
test("an unchanged lossy editor view cannot become a valid save baseline or overwrite original bytes", async () => {
  const f = await fixture(),
    bad = badBytes(),
    manifest = await readFile(join(f.directory, "book.json"));
  await writeFile(f.file, bad);
  const lossy = bad.toString("utf8");
  await assert.rejects(
    f.store.saveChapter({
      bookId: f.book.id,
      chapterId: f.chapter.id,
      title: f.chapter.title,
      body: lossy,
      expectedRevision: f.chapter.revision,
      expectedHash: digest(lossy),
    }),
    /UTF-8/,
  );
  assert.deepEqual(await readFile(f.file), bad);
  assert.deepEqual(await readFile(join(f.directory, "book.json")), manifest);
});
test("bad UTF-8 metadata cannot be normalized by a structural edit", async () => {
  const f = await fixture(),
    path = join(f.directory, "book.json"),
    bad = await readFile(path);
  const at = bad.indexOf(Buffer.from("MetadataBook"));
  assert.ok(at > 0);
  bad[at] = 0xff;
  await writeFile(path, bad);
  const files = await readdir(join(f.directory, "manuscript"));
  await assert.rejects(f.store.createChapter(f.book.id, "不应创建"), /UTF-8/);
  assert.deepEqual(await readFile(path), bad);
  assert.deepEqual(await readdir(join(f.directory, "manuscript")), files);
});
test("recovery rejects a lossy preimage rather than replacing malformed raw manuscript bytes", async () => {
  const f = await fixture(),
    bad = badBytes(),
    pendingPath = join(f.directory, ".zinovel", "pending.json");
  await writeFile(f.file, bad);
  const pending = JSON.stringify({
    id: randomUUID(),
    at: new Date().toISOString(),
    entries: [
      {
        path: `manuscript/${f.chapter.id}.md`,
        before: bad.toString("utf8"),
        after: "不应自动覆盖的恢复文本。",
      },
    ],
  });
  await writeFile(pendingPath, pending);
  await assert.rejects(f.store.readChapter(f.book.id, f.chapter.id), /UTF-8/);
  assert.deepEqual(await readFile(f.file), bad);
  assert.equal(await readFile(pendingPath, "utf8"), pending);
});
test("incomplete Unicode input is rejected before import or a transaction can poison the recovery journal", async () => {
  const f = await fixture(),
    pendingPath = join(f.directory, ".zinovel", "pending.json"),
    pending = await readFile(pendingPath),
    original = await readFile(f.file);
  await assert.rejects(
    f.store.saveChapter({
      bookId: f.book.id,
      chapterId: f.chapter.id,
      title: f.chapter.title,
      body: "\ud800",
      expectedRevision: f.chapter.revision,
      expectedHash: f.chapter.diskHash,
    }),
    /Unicode|格式/,
  );
  await assert.rejects(
    f.store.importBook("不完整输入", [{ title: "不应导入", body: "\ud800" }]),
    /Unicode|格式/,
  );
  const kernel = new BookStorageKernel(f.root);
  await assert.rejects(
    kernel.exclusive(() =>
      kernel.transaction(f.directory, {
        [`manuscript/${f.chapter.id}.md`]: "\ud800",
      }),
    ),
    /Unicode|格式/,
  );
  assert.deepEqual(await readFile(f.file), original);
  assert.deepEqual(await readFile(pendingPath), pending);
});
test("valid BOM, CRLF, actual replacement characters and astral Unicode retain exact bytes and hashes", async () => {
  const f = await fixture(),
    body = "\ufeff第一行。\r\n第二行𠮷 🌊 �",
    bytes = Buffer.from(body);
  await writeFile(f.file, bytes);
  const current = await f.store.readChapter(f.book.id, f.chapter.id);
  assert.equal(current.body, body);
  assert.equal(current.diskHash, digest(body));
  const saved = await f.store.saveChapter({
    bookId: f.book.id,
    chapterId: f.chapter.id,
    title: current.title,
    body,
    expectedRevision: current.revision,
    expectedHash: current.diskHash,
  });
  assert.equal(saved.status, "saved");
  assert.deepEqual(await readFile(f.file), bytes);
});
