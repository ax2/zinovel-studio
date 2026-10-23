import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-plan-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("场景合成作品", [
    { title: "第一章", body: "第一份原稿 🌧️\r\n末尾。", volume: "卷一" },
    { title: "第二章", body: "第二份原稿。", volume: "卷二" },
  ]);
  const scenes = [];
  for (const title of ["下船", "拆信", "回港"])
    scenes.push(
      await store.materials.save(book.id, {
        kind: "scene",
        title,
        status: "planned",
        fields: { goal: "找到送信人" },
        notes: "计划",
        chapterIds: [book.chapters[0].id],
      }),
    );
  const path = join(root, "library", book.id, "planning.json");
  async function move(scene, chapterId, beforeId = null) {
    return store.planning.move(
      book.id,
      { sceneId: scene.id, chapterId, beforeId },
      await store.planning.read(book.id),
    );
  }
  return { root, store, book, scenes, path, move };
}
test("one scene order serves board and outline without changing manuscript or reference links; backup retains identities", async () => {
  const { root, store, book, scenes, move } = await fixture();
  const before = await Promise.all(
    book.chapters.map((chapter) => store.readChapter(book.id, chapter.id)),
  );
  const initial = await store.planning.read(book.id);
  assert.equal(initial.revision, 0);
  assert.equal(initial.columns[0].scenes.length, 3);
  for (const scene of scenes) await move(scene, book.chapters[1].id);
  await move(scenes[2], book.chapters[1].id, scenes[0].id);
  const reopened = new NovelStore(join(root, "library"));
  let snapshot = await reopened.planning.read(book.id);
  assert.deepEqual(
    snapshot.columns[2].scenes.map((scene) => scene.id),
    [scenes[2].id, scenes[0].id, scenes[1].id],
  );
  const backup = await store.createBackup(book.id, join(root, "backups")),
    restored = await store.restoreBackup(backup.path);
  assert.notEqual(restored.id, book.id);
  assert.deepEqual(await store.planning.read(restored.id), snapshot);
  assert.deepEqual(
    await Promise.all(
      book.chapters.map((chapter) => store.readChapter(book.id, chapter.id)),
    ),
    before,
  );
  assert.deepEqual(
    (await store.materials.read(book.id, scenes[0].id)).chapterIds,
    [book.chapters[0].id],
  );
  const history = await readdir(
    join(root, "library", book.id, ".zinovel", "planning-history"),
  );
  assert.equal(history.length, 3);
});
test("stale and external same-revision changes reject without overwrite; foreign/deleted targets and adjacent identities reject", async () => {
  const { store, book, scenes, path, move } = await fixture();
  const stale = await store.planning.read(book.id);
  await move(scenes[0], book.chapters[0].id);
  await assert.rejects(
    store.planning.move(
      book.id,
      { sceneId: scenes[1].id, chapterId: null, beforeId: null },
      stale,
    ),
    /其他操作/,
  );
  const baseline = await store.planning.read(book.id),
    raw = await readFile(path, "utf8");
  await writeFile(path, raw + "\n");
  await assert.rejects(
    store.planning.move(
      book.id,
      { sceneId: scenes[1].id, chapterId: null, beforeId: null },
      baseline,
    ),
    /外部编辑/,
  );
  assert.equal(await readFile(path, "utf8"), raw + "\n");
  await assert.rejects(move(scenes[1], null, scenes[0].id), /相邻/);
  await assert.rejects(move(scenes[1], randomUUID()), /目标章节/);
  const foreign = await store.createBook("另一本书");
  await assert.rejects(
    store.planning.move(
      foreign.id,
      { sceneId: scenes[0].id, chapterId: null, beforeId: null },
      await store.planning.read(foreign.id),
    ),
    /ENOENT/,
  );
  await store.materials.setDeleted(book.id, scenes[1], true);
  await assert.rejects(move(scenes[1], null), /已删除/);
});
test("soft-deleted and missing scene/chapter identities remain visible; restoration keeps placement", async () => {
  const { store, book, scenes, path, move } = await fixture();
  await move(scenes[0], book.chapters[0].id);
  let deleted = await store.materials.setDeleted(book.id, scenes[0], true);
  assert.equal(
    (await store.planning.read(book.id)).columns[1].scenes[0].state,
    "deleted",
  );
  await store.materials.setDeleted(book.id, deleted, false);
  assert.equal(
    (await store.planning.read(book.id)).columns[1].scenes[0].id,
    scenes[0].id,
  );
  const data = JSON.parse(await readFile(path, "utf8")),
    missingScene = randomUUID(),
    missingChapter = randomUUID();
  data.placements.push({
    sceneId: missingScene,
    chapterId: missingChapter,
    order: 100,
  });
  await writeFile(path, JSON.stringify(data));
  const snapshot = await store.planning.read(book.id),
    column = snapshot.columns.find((column) => column.id === missingChapter);
  assert.equal(column.state, "missing");
  assert.equal(column.scenes[0].state, "missing");
  data.placements.push({ ...data.placements[0] });
  const invalid = JSON.stringify(data);
  await writeFile(path, invalid);
  await assert.rejects(store.planning.read(book.id), /重复/);
  assert.equal(await readFile(path, "utf8"), invalid);
});
test("partial planning transaction rolls forward via shared kernel without losing old history", async () => {
  const { root, store, book, scenes, path, move } = await fixture();
  await move(scenes[0], book.chapters[0].id);
  const before = await readFile(path, "utf8"),
    next = JSON.parse(before);
  next.revision++;
  next.placements[0].chapterId = book.chapters[1].id;
  const after = JSON.stringify(next),
    historyPath = ".zinovel/planning-history/interrupted-test.json";
  await writeFile(
    join(root, "library", book.id, ".zinovel", "pending.json"),
    JSON.stringify({
      id: randomUUID(),
      entries: [
        { path: "planning.json", before, after },
        { path: historyPath, before: null, after: before },
      ],
    }),
  );
  await writeFile(path, after);
  const snapshot = await new NovelStore(join(root, "library")).planning.read(
    book.id,
  );
  assert.equal(snapshot.revision, 2);
  assert.equal(
    await readFile(join(root, "library", book.id, historyPath), "utf8"),
    before,
  );
});

test("volume order, chapter rename and deletion change display without changing scene identity or placement", async () => {
  const { store, book: initial, scenes, move } = await fixture();
  let book = initial;
  await move(scenes[0], book.chapters[0].id);
  const snapshot = await store.planning.read(book.id);
  book = await store.updateStructure(book.id, book.revision, { type: "volume-move", volumeId: book.volumes[1].id, beforeId: book.volumes[0].id });
  let next = await store.planning.read(book.id);
  assert.deepEqual(next.columns.slice(1).map((column) => column.id), [initial.chapters[1].id, initial.chapters[0].id]);
  const chapter = await store.readChapter(book.id, initial.chapters[0].id);
  await store.saveChapter({ bookId: book.id, chapterId: chapter.id, title: "重命名的章节", body: chapter.body, expectedRevision: chapter.revision, expectedHash: chapter.diskHash });
  book = (await store.listBooks()).books[0];
  book = await store.updateStructure(book.id, book.revision, { type: "chapter-trash", chapterId: chapter.id });
  next = await store.planning.read(book.id);
  const deleted = next.columns.find((column) => column.id === chapter.id);
  assert.equal(deleted.title, "重命名的章节"); assert.equal(deleted.state, "deleted");
  assert.equal(deleted.scenes[0].id, scenes[0].id);
  assert.equal(next.diskHash, snapshot.diskHash);
  await assert.rejects(move(scenes[1], chapter.id), /目标章节/);
});
