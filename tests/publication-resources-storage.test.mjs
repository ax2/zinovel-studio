import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "publication-resource-"));
  const store = new NovelStore(join(root, "library"));
  const book = await store.importBook("发行图合成书", [
    { title: "渡口", body: "合成原稿𠮷🌊。" },
  ]);
  const bytes = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#126b83" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const asset = await store.assets.import(book.id, bytes, {
    title: "封面候选",
    purpose: "cover",
    source: "PRIVATE_SOURCE_SENTINEL",
    rights: "PRIVATE_RIGHTS_SENTINEL",
    notes: "PRIVATE_NOTES_SENTINEL",
    linkedIds: [],
  });
  const selection = (extra = {}) => ({
    asset: { id: asset.id, revision: asset.revision, diskHash: asset.diskHash },
    placement: "cover",
    chapterId: null,
    alt: "合成封面𠮷🌊",
    caption: "公开图注",
    credit: "公开署名",
    ...extra,
  });
  const locked = (operation) =>
    store.publicationResources.storage.exclusive(async () =>
      operation(await store.assets.context(book.id)),
    );
  return { root, store, book, bytes, asset, selection, locked };
}

test("publication resources freeze a full-size oriented rendition, deduplicate uses and exclude private asset text", async () => {
  const f = await fixture(),
    chapterIds = [f.book.chapters[0].id];
  const result = await f.store.publicationResources.prepare(
    f.book.id,
    [
      f.selection(),
      f.selection({ placement: "chapter-end", chapterId: chapterIds[0] }),
    ],
    chapterIds,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].image, result[1].image);
  assert.deepEqual([result[0].image.width, result[0].image.height], [40, 80]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  const bytes = await f.locked((ctx) =>
    f.store.publicationResources.bytesLocked(ctx.root, result[0].image),
  );
  assert.equal(binaryHash(bytes), result[0].image.sha256);
  assert.equal((await sharp(bytes).metadata()).exif, undefined);
  assert.deepEqual(
    await readFile(
      join(
        f.root,
        "library",
        f.book.id,
        `assets/blobs/${f.asset.blob.sha256}.jpeg`,
      ),
    ),
    f.bytes,
  );
  await f.locked((ctx) =>
    f.store.publicationResources.verifyLocked(ctx, result),
  );
  const replacement = await sharp({
    create: { width: 32, height: 16, channels: 3, background: "#942456" },
  })
    .png()
    .toBuffer();
  const replaced = await f.store.assets.replace(
    f.book.id,
    replacement,
    f.asset,
  );
  await assert.rejects(
    f.locked((ctx) => f.store.publicationResources.verifyLocked(ctx, result)),
    /修改/,
  );
  await f.store.assets.setDeleted(f.book.id, replaced, true);
  assert.deepEqual(
    await f.locked((ctx) =>
      f.store.publicationResources.bytesLocked(ctx.root, result[0].image),
    ),
    bytes,
  );
  const backup = await f.store.createBackup(f.book.id, f.root),
    restored = await f.store.restoreBackup(backup.path);
  const restoredBytes = await f.store.publicationResources.storage.exclusive(
    async () => {
      const ctx = await f.store.assets.context(restored.id);
      return f.store.publicationResources.bytesLocked(
        ctx.root,
        result[0].image,
      );
    },
  );
  assert.deepEqual(restoredBytes, bytes);
  assert.equal(
    (await f.store.readChapter(f.book.id, chapterIds[0])).body,
    "合成原稿𠮷🌊。",
  );
});

test("publication resource preparation rejects stale/deleted or corrupted originals and never replaces an existing bad rendition", async () => {
  const f = await fixture(),
    ids = [f.book.chapters[0].id];
  const references = await f.store.publicationResources.prepare(
    f.book.id,
    [f.selection()],
    ids,
  );
  const file = join(
    f.root,
    "library",
    f.book.id,
    `assets/blobs/${references[0].image.sha256}.png`,
  );
  const before = await readFile(file),
    corrupt = Buffer.from(before);
  corrupt[corrupt.length - 8] ^= 1;
  await writeFile(file, corrupt);
  await assert.rejects(
    f.store.publicationResources.prepare(f.book.id, [f.selection()], ids),
    /hash/,
  );
  assert.deepEqual(await readFile(file), corrupt);
  const deleted = await f.store.assets.setDeleted(f.book.id, f.asset, true);
  await assert.rejects(
    f.store.publicationResources.prepare(
      f.book.id,
      [
        f.selection({
          asset: {
            id: deleted.id,
            revision: deleted.revision,
            diskHash: deleted.diskHash,
          },
        }),
      ],
      ids,
    ),
    /恢复/,
  );
});

test("publication image cancellation after progress does not return a completed resource selection", async () => {
  const f = await fixture(),
    controller = new AbortController();
  await assert.rejects(
    f.store.publicationResources.prepare(
      f.book.id,
      [f.selection()],
      [f.book.chapters[0].id],
      { signal: controller.signal, onProgress: () => controller.abort() },
    ),
    { name: "AbortError" },
  );
  const snapshots = await f.store.publication.list(f.book.id);
  assert.equal(snapshots.snapshots.length, 0);
  assert.equal((await f.store.assets.read(f.book.id, f.asset.id)).revision, 1);
});

test("publication rendition preparation bounds concurrent work and releases capacity after completion", async () => {
  const f = await fixture();
  let release,
    ready,
    count = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const arrivals = new Promise((resolve) => {
    ready = resolve;
  });
  const options = {
    onProgress: () => {
      if (++count === 2) ready();
      return gate;
    },
  };
  const jobs = Array.from({ length: 2 }, () =>
    f.store.publicationResources.prepare(
      f.book.id,
      [f.selection()],
      [f.book.chapters[0].id],
      options,
    ),
  );
  try {
    await arrivals;
    await assert.rejects(
      f.store.publicationResources.prepare(
        f.book.id,
        [f.selection()],
        [f.book.chapters[0].id],
      ),
      /等待/,
    );
  } finally {
    release();
    await Promise.all(jobs);
  }
  assert.equal(
    (
      await f.store.publicationResources.prepare(
        f.book.id,
        [f.selection()],
        [f.book.chapters[0].id],
      )
    ).length,
    1,
  );
});
