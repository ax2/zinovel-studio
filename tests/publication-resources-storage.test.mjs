import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  publicationText,
  publicationHtml,
  verifyPublicationSnapshot,
} from "../packages/novel-domain/publication.mjs";
import { publicationPdfDocument } from "../packages/novel-domain/publication-pdf.mjs";
import { publicationDocx } from "../packages/novel-domain/publication-docx.mjs";

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

const metadata = {
  title: "公开发行图验收",
  author: "合成作者",
  synopsis: "公开简介",
  rights: "合成",
  aiDisclosure: "测试",
};
test("schema2 capture freezes selected image hashes with text, survives restart and restored-book provenance, and never silently drops images on export", async () => {
  const f = await fixture(),
    ids = [f.book.chapters[0].id];
  const catalog = await f.store.publication.catalog(f.book.id);
  const snapshot = await f.store.publication.capture(f.book.id, {
    catalogHash: catalog.hash,
    chapterIds: ids,
    metadata,
    resources: [f.selection()],
  });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.content.resources.length, 1);
  assert.equal(
    (await f.store.publication.list(f.book.id)).snapshots[0].resourceCount,
    1,
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
  const altered = structuredClone(snapshot);
  altered.content.resources[0].alt += "changed";
  assert.throws(() => verifyPublicationSnapshot(altered), /hash/);
  const wrongVersion = structuredClone(snapshot);
  wrongVersion.schemaVersion = 1;
  assert.throws(() => verifyPublicationSnapshot(wrongVersion), /格式/);
  const missing = structuredClone(snapshot);
  delete missing.content.resources;
  assert.throws(() => verifyPublicationSnapshot(missing), /格式/);
  assert.throws(() => publicationText(snapshot, "txt"), /带图/);
  assert.throws(() => publicationHtml(snapshot), /发行图/);
  assert.throws(() => publicationPdfDocument(snapshot), /带图/);
  await assert.rejects(publicationDocx(snapshot), /带图/);
  await f.store.assets.setDeleted(f.book.id, f.asset, true);
  const backup = await f.store.createBackup(f.book.id, f.root);
  // No further writes through the original instance after this explicit restart.
  const restarted = new NovelStore(join(f.root, "library"));
  assert.equal(
    (await restarted.publication.read(f.book.id, snapshot.id, snapshot.hash))
      .hash,
    snapshot.hash,
  );
  const restored = await restarted.restoreBackup(backup.path);
  const restoredSnapshot = await restarted.publication.read(
    restored.id,
    snapshot.id,
    snapshot.hash,
  );
  assert.deepEqual(restoredSnapshot, snapshot);
  const image = restoredSnapshot.content.resources[0].image;
  const bytes = await restarted.publicationResources.storage.exclusive(
    async () => {
      const ctx = await restarted.assets.context(restored.id);
      return restarted.publicationResources.bytesLocked(ctx.root, image);
    },
  );
  assert.equal(binaryHash(bytes), image.sha256);
});

test("image version changes during text capture reject before commit and retain the source manuscript", async () => {
  const f = await fixture(),
    ids = [f.book.chapters[0].id],
    catalog = await f.store.publication.catalog(f.book.id);
  let changed = false;
  await assert.rejects(
    f.store.publication.capture(
      f.book.id,
      {
        catalogHash: catalog.hash,
        chapterIds: ids,
        metadata,
        resources: [f.selection()],
      },
      {
        onProgress: async (progress) => {
          if (!changed && progress.phase === "verifying") {
            changed = true;
            await f.store.assets.save(
              f.book.id,
              {
                title: f.asset.title,
                purpose: f.asset.purpose,
                source: f.asset.source,
                rights: f.asset.rights,
                notes: "作者同时改图记录",
                linkedIds: [],
              },
              f.asset,
            );
          }
        },
      },
    ),
    /修改/,
  );
  assert.equal(changed, true);
  assert.equal((await f.store.publication.list(f.book.id)).snapshots.length, 0);
  assert.equal(
    (await f.store.readChapter(f.book.id, ids[0])).body,
    "合成原稿𠮷🌊。",
  );
});

test("frozen HTML includes exact local image bytes and escaped public captions while later source changes cannot affect it", async () => {
  const f = await fixture(),
    chapterId = f.book.chapters[0].id;
  const snapshot = await f.store.publication.capture(f.book.id, {
    catalogHash: (await f.store.publication.catalog(f.book.id)).hash,
    chapterIds: [chapterId],
    metadata,
    resources: [
      f.selection({ caption: "<script>not executable</script>𠮷🌊" }),
      f.selection({
        placement: "chapter-end",
        chapterId,
        alt: '图像 "替代" & <文字>',
      }),
    ],
  });
  const images = await f.store.publicationResources.images(f.book.id, snapshot);
  const result = publicationHtml(snapshot, images),
    hash = snapshot.content.resources[0].image.sha256;
  assert.equal(images.size, 1);
  assert.deepEqual(result.files.get(`images/${hash}.png`), images.get(hash));
  assert.match(
    result.files.get("index.html"),
    /&lt;script&gt;not executable&lt;\/script&gt;𠮷🌊/,
  );
  assert.match(
    result.files.get(`chapters/${chapterId}.html`),
    /alt="图像 &quot;替代&quot; &amp; &lt;文字&gt;"/,
  );
  assert.doesNotMatch(
    [...result.files.values()]
      .filter((value) => typeof value === "string")
      .join("\n"),
    /PRIVATE_/,
  );
  assert.equal(
    result.manifest.files.find((item) => item.path === `images/${hash}.png`)
      .sha256,
    hash,
  );
  const modified = new Map(images);
  modified.set(hash, Buffer.from("not an image"));
  assert.throws(() => publicationHtml(snapshot, modified), /校验/);
  const before = await f.store.publicationResources.preview(
    f.book.id,
    snapshot,
    0,
  );
  assert.ok(before.dataUrl.startsWith("data:image/png;base64,"));
  await assert.rejects(
    f.store.publicationResources.preview(f.book.id, snapshot, 2),
    /不属于/,
  );
  const anotherBook = await f.store.createBook("另书");
  await assert.rejects(
    f.store.publicationResources.preview(anotherBook.id, snapshot, 0),
    /不属于/,
  );
  await f.store.assets.setDeleted(f.book.id, f.asset, true);
  assert.deepEqual(
    await f.store.publicationResources.images(f.book.id, snapshot),
    images,
  );
});
