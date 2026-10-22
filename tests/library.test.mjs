import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import {
  previewImport,
  splitManuscript,
} from "../packages/novel-storage/importer.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-library-"));
  const store = new NovelStore(join(root, "library"));
  await store.initialize();
  return { root, store };
}
test("volume order, stable chapter IDs, reviewed status and trash survive restart", async () => {
  const { root, store } = await setup();
  let book = await store.importBook("合成测试书", [
    { title: "第一章", body: "开头", volume: "第一卷" },
    { title: "第二章", body: "结尾", volume: "第二卷" },
  ]);
  const [first, second] = book.chapters;
  book = await store.updateStructure(book.id, book.revision, {
    type: "chapter-move",
    chapterId: second.id,
    volumeId: first.volumeId,
    beforeId: first.id,
  });
  assert.deepEqual(
    book.chapters.map((item) => item.id),
    [second.id, first.id],
  );
  book = await store.updateStructure(book.id, book.revision, {
    type: "chapter-status",
    chapterId: first.id,
    status: "final",
  });
  book = await store.updateStructure(book.id, book.revision, {
    type: "chapter-trash",
    chapterId: first.id,
  });
  assert.equal((await store.exportSnapshot(book.id)).chapters.length, 1);
  book = await store.updateStructure(book.id, book.revision, {
    type: "chapter-restore",
    chapterId: first.id,
  });
  const reopened = (await new NovelStore(join(root, "library")).listBooks())
    .books[0];
  assert.equal(reopened.chapters[1].status, "final");
  assert.equal(reopened.chapters[1].id, first.id);
  await assert.rejects(
    store.updateStructure(book.id, 1, {
      type: "volume-create",
      title: "过期修改",
    }),
    /已经改变/,
  );
});
test("UTF-8 import preview preserves source bytes and chapter/volume order", async () => {
  const { root, store } = await setup();
  const source = join(root, "源稿.txt");
  const text =
    "第一卷 旧港\n第一章 旧信\n𠮷🙂雨落在港口。\n第二章 灯塔\n他看见信封。\n第二卷 出航\n第三章 海上\n结尾。";
  await writeFile(source, text, "utf8");
  const before = await readFile(source);
  const preview = await previewImport([source]);
  assert.equal(preview.chapters.length, 3);
  assert.equal(preview.chapters[2].volume, "第二卷 出航");
  const book = await store.importBook("导入测试", preview.chapters);
  assert.equal(
    (await store.exportSnapshot(book.id)).chapters[2].body,
    "结尾。",
  );
  assert.deepEqual(await readFile(source), before);
  const found = await store.search(book.id, "雨落");
  assert.equal(found.hits[0].start, 4);
  assert.equal(found.offsetUnit, "utf16");
  assert.equal(
    splitManuscript("一段没有标题的正文", "默认章")[0].body,
    "一段没有标题的正文",
  );
});
test("verified backup restores into a new book; corruption is rejected without overwriting originals", async () => {
  const { root, store } = await setup();
  const book = await store.importBook("备份测试", [
    { title: "第一章", body: "不可丢失的正文" },
  ]);
  const destination = join(root, "backup");
  await mkdir(destination);
  const backup = await store.createBackup(book.id, destination);
  const restored = await store.restoreBackup(backup.path);
  assert.notEqual(restored.id, book.id);
  assert.equal(
    (await store.readChapter(restored.id, book.chapters[0].id)).body,
    "不可丢失的正文",
  );
  await assert.rejects(
    store.createBackup(book.id, join(root, "library", book.id, "nested")),
    /作品目录内部/,
  );
  await writeFile(
    join(backup.path, "manuscript", `${book.chapters[0].id}.md`),
    "被损坏",
  );
  await assert.rejects(store.restoreBackup(backup.path), /校验失败/);
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).diskHash,
    digest("不可丢失的正文"),
  );
  assert.equal((await store.listBooks()).books.length, 2);
});
test("preview supports legacy Chinese encoding and retains deliberately empty chapters", async () => {
  const { root } = await setup(),
    source = join(root, "旧编码.txt");
  await writeFile(source, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  await assert.rejects(previewImport([source], "utf-8"));
  assert.equal(
    (await previewImport([source], "gb18030")).chapters[0].body,
    "你好",
  );
  assert.deepEqual(
    splitManuscript("第一章旧信\n第二章灯塔\n正文", "默认").map(
      (chapter) => chapter.body,
    ),
    ["", "正文"],
  );
});
