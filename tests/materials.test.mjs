import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import {
  materialKinds,
  materialMarkdown,
} from "../packages/novel-domain/materials.mjs";
const input = (kind = "character", chapterIds = []) => ({
  kind,
  title: "林舟与旧港 🌧️",
  status: "planned",
  notes: "作者设想\r\n保留空行\n\n结尾",
  fields: {},
  chapterIds,
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-material-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("资料合成作品", [
    { title: "码头", body: "雨落在旧港。" },
  ]);
  return { root, store, book };
}
test("all typed records persist and backup restores internal chapter IDs under new book identity", async () => {
  const { root, store, book } = await setup();
  const records = [];
  for (const kind of materialKinds)
    records.push(
      await store.materials.save(
        book.id,
        input(kind.id, [book.chapters[0].id]),
      ),
    );
  const reopened = new NovelStore(join(root, "library"));
  assert.equal((await reopened.materials.list(book.id)).total, 8);
  for (const record of records)
    assert.deepEqual(await reopened.materials.read(book.id, record.id), record);
  const backup = await store.createBackup(book.id, join(root, "backup"));
  const restored = await store.restoreBackup(backup.path);
  assert.notEqual(restored.id, book.id);
  const card = await store.materials.read(restored.id, records[0].id);
  assert.equal(card.chapters[0].id, book.chapters[0].id);
  assert.equal(card.chapters[0].state, "active");
  assert.equal(card.notes, records[0].notes);
  assert.match(materialMarkdown(card), /不代表正文已证实/);
});
test("material and manuscript writes share queue; stale versions, external edits and failed saves preserve bytes", async () => {
  const { root, store, book } = await setup();
  const a = await store.materials.save(book.id, input());
  const chapter = await store.readChapter(book.id, book.chapters[0].id);
  const results = await Promise.allSettled([
    store.materials.save(book.id, { ...a, title: "第一次修改" }, a),
    store.saveChapter({
      bookId: book.id,
      chapterId: chapter.id,
      title: chapter.title,
      body: "正文同步保存。",
      expectedRevision: chapter.revision,
      expectedHash: chapter.diskHash,
    }),
    store.materials.save(book.id, { ...a, title: "过时修改" }, a),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled", "rejected"],
  );
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    "正文同步保存。",
  );
  const current = await store.materials.read(book.id, a.id);
  const path = join(root, "library", book.id, "materials", `${a.id}.json`);
  const external = JSON.stringify({ ...current, title: "外部同版本更改" });
  await writeFile(path, external);
  await assert.rejects(
    store.materials.save(book.id, { ...current, title: "不能覆盖" }, current),
    /外部编辑/,
  );
  assert.equal(await readFile(path, "utf8"), external);
  const latest = await store.materials.read(book.id, a.id);
  const updated = await store.materials.save(
    book.id,
    { ...latest, notes: "保留外部更改" },
    latest,
  );
  assert.equal(updated.title, "外部同版本更改");
  assert.equal(
    (await store.materials.history(book.id, a.id))[0].title,
    "外部同版本更改",
  );
});
test("soft deletion, historical values, search, corrupt files and foreign IDs stay isolated", async () => {
  const { root, store, book } = await setup();
  let card = await store.materials.save(book.id, {
    ...input(),
    fields: { aliases: "归舟" },
  });
  assert.equal(
    (await store.materials.list(book.id, { query: "归舟" })).total,
    1,
  );
  card = await store.materials.setDeleted(book.id, card, true);
  assert.equal((await store.materials.list(book.id)).total, 0);
  assert.equal(
    (await store.materials.list(book.id, { deleted: true })).total,
    1,
  );
  await assert.rejects(store.materials.save(book.id, card, card), /先恢复/);
  card = await store.materials.setDeleted(book.id, card, false);
  assert.equal((await store.materials.history(book.id, card.id)).length, 2);
  await assert.rejects(
    store.materials.save(book.id, { ...input(), chapterIds: [randomUUID()] }),
    /关联章节/,
  );
  await assert.rejects(
    store.materials.save(book.id, { ...input(), status: "established" }),
    /设定状态/,
  );
  await assert.rejects(
    store.materials.save(book.id, {
      ...input(),
      fields: { unrecognized: "x" },
    }),
    /不支持/,
  );
  await assert.rejects(store.materials.read(book.id, "../book.json"), /标识/);
  const other = await store.createBook("另一作品");
  await assert.rejects(store.materials.read(other.id, card.id));
  const path = join(root, "library", book.id, "materials", `${card.id}.json`);
  await writeFile(path, "broken");
  assert.equal((await store.materials.list(book.id)).errors.length, 1);
  await assert.rejects(store.materials.save(book.id, input(), card));
  assert.equal(await readFile(path, "utf8"), "broken");
});
test("shared recovery replays material transactions; links cannot escape the book", async () => {
  const { root, store, book } = await setup();
  const card = await store.materials.save(book.id, input());
  const bookRoot = join(root, "library", book.id),
    path = join(bookRoot, "materials", `${card.id}.json`);
  const before = await readFile(path, "utf8"),
    after = JSON.stringify({
      ...JSON.parse(before),
      title: "故障恢复后的资料",
      revision: 2,
    });
  await writeFile(
    join(bookRoot, ".zinovel", "pending.json"),
    JSON.stringify({
      id: randomUUID(),
      entries: [{ path: `materials/${card.id}.json`, before, after }],
    }),
  );
  assert.equal(
    (await store.materials.read(book.id, card.id)).title,
    "故障恢复后的资料",
  );
  assert.equal(await readFile(path, "utf8"), after);
  const another = await store.createBook("链接拒绝"),
    outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, `${card.id}.json`), after);
  await symlink(
    outside,
    join(root, "library", another.id, "materials"),
    "junction",
  );
  await assert.rejects(store.materials.read(another.id, card.id), /链接/);
  assert.equal(
    digest(await readFile(join(outside, `${card.id}.json`), "utf8")),
    digest(after),
  );
});
