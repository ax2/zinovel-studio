import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";
import { PublicationStore } from "../packages/novel-storage/publication.mjs";
import { ReaderStore } from "../packages/novel-storage/reader.mjs";

const metadata = () => ({
  title: "公开雾港",
  author: "合成作者",
  synopsis: "公开简介",
  rights: "合成测试文本",
  aiDisclosure: "测试数据",
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-publication-")),
    store = new NovelStore(root);
  const book = await store.importBook("原书内部标题", [
    { title: "旧信", body: "\ufeff第一封信。𠮷🌊\r\n合法替换字符：\ufffd" },
    { title: "渡口", body: "第二章结尾。" },
    { title: "未选的未来章节", body: "EXCLUDED_FUTURE_SECRET" },
  ]);
  const folder = join(root, book.id),
    path = (id) => join(folder, "manuscript", id + ".md");
  const request = async (
    ids = book.chapters.slice(0, 2).map((ch) => ch.id),
  ) => ({
    catalogHash: (await store.publication.catalog(book.id)).hash,
    chapterIds: ids,
    metadata: metadata(),
  });
  return { root, store, book, folder, path, request };
}
const snapshotFile = (folder, id) =>
  join(folder, ".zinovel", "publications", id + ".json");

test("publication captures only selected ordered text and public metadata, persists across restart and remains frozen after source edits", async () => {
  const f = await fixture();
  await f.store.materials.save(f.book.id, {
    kind: "proposition",
    title: "PRIVATE_AUTHOR_SECRET",
    notes: "PRIVATE_FUTURE_WORLD",
    status: "planned",
    fields: { claim: "作者秘密", truthIntent: "作者设定为真" },
    chapterIds: [],
  });
  const ids = [f.book.chapters[1].id, f.book.chapters[0].id];
  const snapshot = await f.store.publication.capture(
    f.book.id,
    await f.request(ids),
  );
  assert.deepEqual(
    snapshot.content.chapters.map((ch) => ch.id),
    ids,
  );
  assert.equal(snapshot.content.chapters[0].volumeTitle, "");
  assert.equal(
    snapshot.content.chapters[1].body,
    "\ufeff第一封信。𠮷🌊\r\n合法替换字符：\ufffd",
  );
  const raw = await readFile(snapshotFile(f.folder, snapshot.id));
  assert.doesNotMatch(
    raw.toString("utf8"),
    /PRIVATE_AUTHOR_SECRET|PRIVATE_FUTURE_WORLD|EXCLUDED_FUTURE_SECRET|原书内部标题/,
  );
  const chapter = await f.store.readChapter(f.book.id, ids[0]);
  await f.store.saveChapter({
    bookId: f.book.id,
    chapterId: chapter.id,
    title: "作者后改章名",
    body: "作者后改正文",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  const reopened = new NovelStore(f.root);
  assert.deepEqual(
    await reopened.publication.read(f.book.id, snapshot.id, snapshot.hash),
    snapshot,
  );
  assert.deepEqual(await readFile(snapshotFile(f.folder, snapshot.id)), raw);
  const list = await reopened.publication.list(f.book.id);
  assert.equal(list.snapshots[0].chapterCount, 2);
  assert.deepEqual(list.snapshots[0].externalChapterIds, []);
  assert.deepEqual(list.errors, []);
});

test("publication refuses duplicate, foreign, deleted and stale-directory selections without creating a snapshot", async () => {
  const f = await fixture(),
    other = await f.store.importBook("另一部", [
      { title: "外书", body: "外书正文" },
    ]);
  const request = await f.request();
  await assert.rejects(
    f.store.publication.capture(f.book.id, {
      ...request,
      chapterIds: [request.chapterIds[0], request.chapterIds[0]],
    }),
    /重复/,
  );
  await assert.rejects(
    f.store.publication.capture(f.book.id, {
      ...request,
      chapterIds: [other.chapters[0].id],
    }),
    /不属于/,
  );
  const manifestPath = join(f.folder, "book.json"),
    book = JSON.parse(await readFile(manifestPath, "utf8"));
  book.chapters[2].deletedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(book));
  await assert.rejects(
    f.store.publication.capture(f.book.id, request),
    /目录已改变/,
  );
  await assert.rejects(
    f.store.publication.capture(
      f.book.id,
      await f.request([f.book.chapters[2].id]),
    ),
    /不属于/,
  );
  assert.deepEqual((await f.store.publication.list(f.book.id)).snapshots, []);
  book.chapters[0].volumeId = other.id;
  await writeFile(manifestPath, JSON.stringify(book));
  await assert.rejects(f.store.publication.catalog(f.book.id), /分卷失联/);
});

test("capture releases the shared queue between batches and cancellation leaves source and recovery journal unchanged", async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.store.publication.batchSize = 1;
  const before = await readFile(f.path(f.book.chapters[0].id));
  const pendingPath = join(f.folder, ".zinovel", "pending.json"),
    pending = await readFile(pendingPath);
  await assert.rejects(
    f.store.publication.capture(f.book.id, await f.request(), {
      signal: controller.signal,
      onProgress: async (progress) => {
        assert.equal(progress.phase, "capturing");
        // This would deadlock if the callback ran inside the same exclusive queue.
        await f.store.publication.catalog(f.book.id);
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(await readFile(f.path(f.book.chapters[0].id)), before);
  assert.deepEqual(await readFile(pendingPath), pending);
  assert.deepEqual((await f.store.publication.list(f.book.id)).snapshots, []);
  await f.store.createChapter(f.book.id, "取消后仍可写作");
});

test("external byte changes during capture are detected; a subsequent explicit capture keeps actual bytes and exposes differing saved hashes", async () => {
  const f = await fixture();
  f.store.publication.batchSize = 1;
  const file = f.path(f.book.chapters[0].id),
    external = "外部作者明确改写。𠮷";
  let changed = false;
  await assert.rejects(
    f.store.publication.capture(f.book.id, await f.request(), {
      onProgress: async (progress) => {
        if (!changed && progress.phase === "capturing") {
          changed = true;
          await writeFile(file, external);
        }
      },
    }),
    /正文已改变/,
  );
  assert.equal(await readFile(file, "utf8"), external);
  assert.equal((await f.store.publication.list(f.book.id)).snapshots.length, 0);
  const snapshot = await f.store.publication.capture(
    f.book.id,
    await f.request(),
  );
  assert.equal(snapshot.content.chapters[0].body, external);
  assert.equal(snapshot.content.chapters[0].bodyHash, digest(external));
  assert.notEqual(
    snapshot.content.chapters[0].bodyHash,
    snapshot.content.chapters[0].savedHash,
  );
  assert.deepEqual(
    (await f.store.publication.list(f.book.id)).snapshots[0].externalChapterIds,
    [f.book.chapters[0].id],
  );
  assert.equal(await readFile(file, "utf8"), external);
});

test("bad UTF-8 and oversized capture inputs preserve source bytes and never poison pending recovery", async () => {
  const f = await fixture(),
    file = f.path(f.book.chapters[0].id);
  const pendingPath = join(f.folder, ".zinovel", "pending.json"),
    pending = await readFile(pendingPath);
  const bad = Buffer.from([0x61, 0xff, 0x62]);
  await writeFile(file, bad);
  await assert.rejects(
    f.store.publication.capture(f.book.id, await f.request()),
    /UTF-8/,
  );
  assert.deepEqual(await readFile(file), bad);
  await writeFile(file, "a".repeat(4096));
  const kernel = new BookStorageKernel(f.root),
    limited = new PublicationStore(kernel, new ReaderStore(kernel), {
      maxBytes: 1024,
    });
  await assert.rejects(limited.capture(f.book.id, await f.request()), /容量/);
  assert.equal((await readFile(file)).length, 4096);
  assert.deepEqual(await readFile(pendingPath), pending);
  assert.deepEqual((await f.store.publication.list(f.book.id)).snapshots, []);
});

test("damaged and future snapshots remain on disk and are reported individually alongside valid snapshots", async () => {
  const f = await fixture(),
    request = await f.request();
  const first = await f.store.publication.capture(f.book.id, request);
  const bad = JSON.stringify({ ...first, schemaVersion: 99 }),
    path = snapshotFile(f.folder, first.id);
  await writeFile(path, bad);
  const second = await f.store.publication.capture(f.book.id, request);
  const list = await f.store.publication.list(f.book.id);
  assert.deepEqual(
    list.snapshots.map((item) => item.id),
    [second.id],
  );
  assert.equal(list.errors[0].id, first.id);
  await assert.rejects(f.store.publication.read(f.book.id, first.id), /版本/);
  await assert.rejects(
    f.store.publication.read(f.book.id, second.id, "a".repeat(64)),
    /已改变/,
  );
  assert.equal(await readFile(path, "utf8"), bad);
});

test("backup restore preserves immutable original provenance through two new book identities and rejects foreign snapshot copies", async () => {
  const f = await fixture(),
    snapshot = await f.store.publication.capture(f.book.id, await f.request());
  const raw = await readFile(snapshotFile(f.folder, snapshot.id));
  const backupRoot = await mkdtemp(join(tmpdir(), "publication-backup-"));
  const backup = await f.store.createBackup(f.book.id, backupRoot);
  const restored = await f.store.restoreBackup(backup.path);
  assert.notEqual(restored.id, f.book.id);
  assert.deepEqual(restored.restoredFromBookIds, [f.book.id]);
  assert.deepEqual(
    await f.store.publication.read(restored.id, snapshot.id),
    snapshot,
  );
  assert.deepEqual(
    await readFile(snapshotFile(join(f.root, restored.id), snapshot.id)),
    raw,
  );
  const backup2 = await f.store.createBackup(restored.id, backupRoot);
  const restored2 = await f.store.restoreBackup(backup2.path);
  assert.deepEqual(restored2.restoredFromBookIds, [restored.id, f.book.id]);
  assert.deepEqual(
    await f.store.publication.read(restored2.id, snapshot.id),
    snapshot,
  );
  const foreign = await f.store.createBook("不相关作品"),
    foreignFolder = join(f.root, foreign.id);
  await mkdir(join(foreignFolder, ".zinovel", "publications"), {
    recursive: true,
  });
  const foreignPath = snapshotFile(foreignFolder, snapshot.id);
  await writeFile(foreignPath, raw);
  await assert.rejects(
    f.store.publication.read(foreign.id, snapshot.id),
    /不属于/,
  );
  assert.equal((await f.store.publication.list(foreign.id)).errors.length, 1);
  assert.deepEqual(await readFile(foreignPath), raw);
});

test("transaction create-only preimages refuse existing files and invalid conditions before creating a journal", async () => {
  const f = await fixture(),
    kernel = new BookStorageKernel(f.root);
  const path = `.zinovel/publications/create-once.json`,
    pendingPath = join(f.folder, ".zinovel", "pending.json");
  await kernel.exclusive(() =>
    kernel.transaction(
      f.folder,
      { [path]: "original" },
      { expectedBefore: { [path]: null } },
    ),
  );
  const pending = await readFile(pendingPath);
  await assert.rejects(
    kernel.exclusive(() =>
      kernel.transaction(
        f.folder,
        { [path]: "overwrite" },
        { expectedBefore: { [path]: null } },
      ),
    ),
    /前像已改变/,
  );
  await assert.rejects(
    kernel.exclusive(() =>
      kernel.transaction(
        f.folder,
        { [path]: "overwrite" },
        { expectedBefore: { "not-requested": null } },
      ),
    ),
    /条件无效/,
  );
  await assert.rejects(
    kernel.exclusive(() =>
      kernel.transaction(
        f.folder,
        { [path]: "overwrite" },
        { expectedBefore: null },
      ),
    ),
    /条件无效/,
  );
  assert.equal(await readFile(join(f.folder, path), "utf8"), "original");
  assert.deepEqual(await readFile(pendingPath), pending);
  if (process.platform === "win32") {
    await assert.rejects(
      kernel.exclusive(() =>
        kernel.transaction(f.folder, { "alias.txt": "a", "ALIAS.txt": "b" }),
      ),
      /路径重复/,
    );
    assert.deepEqual(await readFile(pendingPath), pending);
  }
});

test("capture freezes caller input before awaiting and reports a committed snapshot after cancellation closes", async () => {
  const f = await fixture(),
    request = await f.request(),
    originalIds = [...request.chapterIds];
  const controller = new AbortController();
  let commitStarted = false;
  const pending = f.store.publication.capture(f.book.id, request, {
    signal: controller.signal,
    onCommitting() {
      commitStarted = true;
      controller.abort();
    },
  });
  request.chapterIds.reverse();
  request.metadata.title = "调用者后改输入";
  request.catalogHash = "a".repeat(64);
  const snapshot = await pending;
  assert.equal(commitStarted, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(
    snapshot.content.chapters.map((chapter) => chapter.id),
    originalIds,
  );
  assert.equal(snapshot.content.metadata.title, "公开雾港");
  assert.deepEqual(
    await f.store.publication.read(f.book.id, snapshot.id),
    snapshot,
  );
  const before = await readFile(join(f.folder, ".zinovel", "pending.json"));
  await assert.rejects(
    f.store.publication.capture(f.book.id, await f.request(), {
      onCommitting: async () => {},
    }),
    /同步/,
  );
  assert.equal((await f.store.publication.list(f.book.id)).snapshots.length, 1);
  await assert.rejects(
    f.store.publication.capture(f.book.id, await f.request(), {
      onCommitting: async () => {
        throw new Error("synthetic callback failure");
      },
    }),
    /同步/,
  );
  assert.deepEqual(
    await readFile(join(f.folder, ".zinovel", "pending.json")),
    before,
  );
});
