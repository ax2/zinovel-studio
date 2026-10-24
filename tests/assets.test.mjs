import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  assetInput,
  assetDraftInput,
} from "../packages/novel-domain/assets.mjs";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";
import { AssetStore } from "../packages/novel-storage/assets.mjs";
import { MaterialStore } from "../packages/novel-storage/materials.mjs";
import {
  inspectAssetImage,
  binaryHash,
} from "../packages/novel-storage/image-decoder.mjs";

const input = (title = "合成定妆𠮷🌊") => ({
  title,
  purpose: "portrait",
  source: "程序合成图片",
  rights: "合成验收材料",
  notes: "人物方向待作者选定",
  linkedIds: [],
});
test("unfinished local image notes round-trip separately from canonical validation", () => {
  const value = { ...input(""), notes: "尚未写完\ud800" };
  assert.deepEqual(assetDraftInput(JSON.parse(JSON.stringify(value))), value);
  assert.throws(() => assetInput(value), /为空|Unicode/);
  assert.throws(
    () => assetDraftInput({ ...input(), future: "unknown" }),
    /不支持/,
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-assets-")),
    store = new NovelStore(join(root, "library")),
    book = await store.importBook("合成图像作品", [
      { title: "旧信", body: "原稿不因图片改变。𠮷🌊" },
    ]);
  const bytes = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "#126b83" },
  })
    .png()
    .toBuffer();
  const folder = join(root, "library", book.id);
  const source = join(root, "中文 空格 原图.png");
  await writeFile(source, bytes);
  return {
    root,
    store,
    book,
    bytes,
    folder,
    source,
    path: (asset) =>
      join(folder, "assets/blobs", asset.blob.sha256 + "." + asset.blob.format),
    record: (id) => join(folder, "assets/items", id + ".json"),
  };
}
test("real PNG/JPEG/WebP decode preserves original bytes and applies EXIF direction only to derived thumbnails", async () => {
  const f = await fixture();
  for (const format of ["png", "jpeg", "webp"]) {
    const bytes = await sharp({
      create: { width: 64, height: 32, channels: 3, background: "#814c36" },
    })
      .withMetadata({ orientation: 6 })
      [format]()
      .toBuffer();
    const decoded = await inspectAssetImage(bytes);
    assert.equal(decoded.blob.format, format);
    assert.deepEqual(decoded.bytes, bytes);
    assert.equal(decoded.blob.sha256, binaryHash(bytes));
    if (format === "jpeg") {
      assert.equal(decoded.blob.displayWidth, 32);
      assert.equal(decoded.blob.displayHeight, 64);
    }
    const record = await f.store.assets.import(f.book.id, bytes, {
      ...input(format),
      purpose: "cover",
    });
    assert.deepEqual(await readFile(f.path(record)), bytes);
    const preview = await f.store.assets.preview(f.book.id, record);
    assert.match(preview.dataUrl, /^data:image\/png;base64,/);
    assert.equal(preview.blob.sha256, record.blob.sha256);
  }
  assert.deepEqual(await readFile(f.source), f.bytes);
});
test("unknown signatures, corrupt pixels, oversized and animated images reject before any visible asset is created", async () => {
  const f = await fixture(),
    badPixels = Buffer.from(f.bytes),
    offset = badPixels.indexOf(Buffer.from("IDAT"));
  badPixels[offset + 5] ^= 255;
  for (const bad of [
    Buffer.from("<svg/>"),
    f.bytes.subarray(0, 40),
    badPixels,
    Buffer.alloc(20 * 1024 * 1024 + 1),
  ])
    await assert.rejects(f.store.assets.import(f.book.id, bad, input()));
  const large = await sharp({
    create: { width: 5000, height: 4001, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    f.store.assets.import(f.book.id, large, input()),
    /解码|尺寸/,
  );
  const animated = Buffer.from(f.bytes),
    idat = animated.indexOf(Buffer.from("IDAT"));
  animated.write("acTL", idat, 4, "ascii");
  await assert.rejects(
    f.store.assets.import(f.book.id, animated, input()),
    /多帧/,
  );
  assert.equal((await f.store.assets.list(f.book.id)).total, 0);
  assert.deepEqual(await readFile(f.source), f.bytes);
});
test("edits use exact versions; replacement preserves old image history; recycle and restore never delete bytes", async () => {
  const f = await fixture(),
    first = await f.store.assets.import(f.book.id, f.bytes, input());
  const saved = await f.store.assets.save(
    f.book.id,
    { ...input("重命名"), notes: "第二版说明" },
    first,
  );
  await assert.rejects(
    f.store.assets.save(f.book.id, input(), first),
    /已被其他操作/,
  );
  const newImage = await sharp({
    create: { width: 16, height: 20, channels: 3, background: "#915844" },
  })
    .webp()
    .toBuffer();
  const replaced = await f.store.assets.replace(f.book.id, newImage, saved);
  assert.notEqual(replaced.blob.sha256, first.blob.sha256);
  const history = await f.store.assets.history(f.book.id, first.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].revision, 2);
  const oldPreview = await f.store.assets.preview(f.book.id, history[1], true);
  assert.equal(oldPreview.blob.sha256, first.blob.sha256);
  const deleted = await f.store.assets.setDeleted(f.book.id, replaced, true);
  assert.equal((await f.store.assets.list(f.book.id)).total, 0);
  assert.equal(
    (await f.store.assets.list(f.book.id, { deleted: true })).total,
    1,
  );
  await assert.rejects(
    f.store.assets.save(f.book.id, input(), deleted),
    /恢复/,
  );
  const restored = await f.store.assets.setDeleted(f.book.id, deleted, false);
  assert.equal(restored.deletedAt, undefined);
  assert.deepEqual(await readFile(f.path(first)), f.bytes);
  assert.deepEqual(await readFile(f.path(replaced)), newImage);
  assert.equal(
    (await f.store.assets.preview(f.book.id, restored)).blob.sha256,
    replaced.blob.sha256,
  );
  const adopted = await f.store.assets.restoreVersion(
    f.book.id,
    restored,
    history[1],
  );
  assert.equal(adopted.blob.sha256, first.blob.sha256);
  assert.equal(adopted.title, first.title);
  assert.equal(adopted.revision, restored.revision + 1);
  assert.equal(adopted.creationHash, first.creationHash);
  assert.deepEqual(await readFile(f.path(replaced)), newImage);
  await assert.rejects(
    f.store.assets.restoreVersion(f.book.id, restored, history[1]),
    /已被其他操作/,
  );
});
test("duplicate bytes allow different author records while exact creation retry cannot duplicate or rewind later edits", async () => {
  const f = await fixture(),
    intent = randomUUID(),
    data = input();
  const a = await f.store.assets.import(f.book.id, f.bytes, data, intent);
  const modified = await f.store.assets.save(
    f.book.id,
    input("作者后来修改"),
    a,
  );
  assert.deepEqual(
    await f.store.assets.import(f.book.id, f.bytes, data, intent),
    modified,
  );
  await assert.rejects(
    f.store.assets.import(f.book.id, f.bytes, input("不同的导入"), intent),
    /已经保存其他/,
  );
  const b = await f.store.assets.import(f.book.id, f.bytes, {
    ...data,
    purpose: "reference",
  });
  assert.notEqual(a.id, b.id);
  assert.equal(a.blob.sha256, b.blob.sha256);
  assert.equal((await readdir(join(f.folder, "assets/blobs"))).length, 1);
  assert.equal((await f.store.assets.creation(f.book.id, intent)).id, a.id);
  assert.equal(await f.store.assets.creation(f.book.id, randomUUID()), null);
});
test("input is captured before awaits and decoding does not hold the shared manuscript writer queue", async () => {
  const f = await fixture(),
    data = input(),
    bytes = Buffer.from(f.bytes),
    pending = f.store.assets.import(f.book.id, bytes, data);
  bytes.fill(0);
  data.title = "调用后改变";
  data.linkedIds.push(randomUUID());
  const record = await pending;
  assert.equal(record.title, "合成定妆𠮷🌊");
  assert.deepEqual(record.linkedIds, []);
  assert.deepEqual(await readFile(f.path(record)), f.bytes);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve)),
    original = f.store.assets.decode.bind(f.store.assets);
  f.store.assets.decode = async (bytes) => {
    entered();
    await gate;
    return original(bytes);
  };
  const importing = f.store.assets.import(
    f.book.id,
    f.bytes,
    input("队列外解码"),
  );
  await started;
  const chapter = await f.store.readChapter(f.book.id, f.book.chapters[0].id);
  await f.store.saveChapter({
    bookId: f.book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: "解码期间手工保存仍完成。",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  release();
  await importing;
  assert.equal(
    (await f.store.readChapter(f.book.id, chapter.id)).body,
    "解码期间手工保存仍完成。",
  );
});
test("corrupt metadata and original bytes remain visible as errors and cannot be silently repaired or overwritten", async () => {
  const f = await fixture(),
    a = await f.store.assets.import(f.book.id, f.bytes, input());
  const raw = await readFile(f.record(a.id)),
    future = { ...JSON.parse(raw), schemaVersion: 99 };
  await writeFile(f.record(a.id), JSON.stringify(future));
  assert.equal((await f.store.assets.list(f.book.id)).errors.length, 1);
  await assert.rejects(f.store.assets.read(f.book.id, a.id));
  assert.deepEqual(JSON.parse(await readFile(f.record(a.id), "utf8")), future);
  await writeFile(f.record(a.id), raw);
  const corrupt = Buffer.from(f.bytes);
  corrupt[corrupt.length - 1] ^= 255;
  await writeFile(f.path(a), corrupt);
  await assert.rejects(f.store.assets.preview(f.book.id, a), /校验/);
  await assert.rejects(
    f.store.assets.import(f.book.id, f.bytes, input("同hash新导入")),
    /校验/,
  );
  assert.deepEqual(await readFile(f.path(a)), corrupt);
  assert.deepEqual(await readFile(f.record(a.id)), raw);
  assert.equal((await f.store.assets.list(f.book.id)).total, 1);
});
test("new links and resource identities are book-scoped; backup restores original blobs and history under explicit origin lineage", async () => {
  const f = await fixture(),
    other = await f.store.createBook("另一部书");
  const material = await f.store.materials.save(other.id, {
    kind: "character",
    title: "外书人物",
    notes: "合成",
    status: "planned",
    fields: {},
    chapterIds: [],
  });
  await assert.rejects(
    f.store.assets.import(f.book.id, f.bytes, {
      ...input(),
      linkedIds: [material.id],
    }),
  );
  const first = await f.store.assets.import(f.book.id, f.bytes, input()),
    next = await f.store.assets.save(f.book.id, input("备份前版本"), first);
  const backup = await f.store.createBackup(f.book.id, f.root),
    restored = await f.store.restoreBackup(backup.path);
  assert.notEqual(restored.id, f.book.id);
  assert.equal(
    (await f.store.assets.preview(restored.id, next)).blob.sha256,
    next.blob.sha256,
  );
  assert.equal((await f.store.assets.history(restored.id, next.id)).length, 1);
  const foreignFolder = join(f.root, "library", other.id, "assets/items");
  await mkdir(foreignFolder, { recursive: true });
  await copyFile(f.record(next.id), join(foreignFolder, next.id + ".json"));
  await assert.rejects(f.store.assets.read(other.id, next.id), /所属作品/);
  assert.equal((await f.store.assets.list(other.id)).errors.length, 1);
});
test("a binary-only orphan after metadata failure is preserved and reusable; interrupted text commit recovers once with exact creation identity", async () => {
  const f = await fixture(),
    kernel = new BookStorageKernel(join(f.root, "library")),
    assets = new AssetStore(kernel, new MaterialStore(kernel)),
    original = kernel.transaction.bind(kernel);
  kernel.transaction = async () => {
    throw new Error("synthetic metadata write failure");
  };
  const intent = randomUUID();
  await assert.rejects(
    assets.import(f.book.id, f.bytes, input(), intent),
    /synthetic/,
  );
  assert.equal((await f.store.assets.list(f.book.id)).total, 0);
  assert.equal(
    (await readdir(join(f.folder, "assets/blobs"))).filter(
      (n) => !n.startsWith("."),
    ).length,
    1,
  );
  kernel.transaction = original;
  const originalRecover = kernel.recover.bind(kernel);
  let interrupted = false;
  kernel.recover = async (root) => {
    const raw = await readFile(
      join(root, ".zinovel/pending.json"),
      "utf8",
    ).catch(() => "");
    if (raw && !interrupted) {
      interrupted = true;
      throw new Error("synthetic after journal");
    }
    return originalRecover(root);
  };
  await assert.rejects(
    assets.import(f.book.id, f.bytes, input(), intent),
    /after journal/,
  );
  const reopened = new NovelStore(join(f.root, "library"));
  const found = await reopened.assets.creation(f.book.id, intent);
  assert.equal(found.id, intent);
  assert.equal((await reopened.assets.list(f.book.id)).total, 1);
  assert.deepEqual(
    await reopened.assets.import(f.book.id, f.bytes, input(), intent),
    found,
  );
  assert.deepEqual(await readFile(f.path(found)), f.bytes);
});
test("a linked assets directory refuses writes outside the book, preserving the selected original", async () => {
  const f = await fixture(),
    outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(f.folder, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.store.assets.import(f.book.id, f.bytes, input()),
    /链接/,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test("backup capacity preflight refuses an oversized image-bearing tree before staging, retaining every original", async () => {
  const f = await fixture();
  const a = await f.store.assets.import(f.book.id, f.bytes, input());
  const destination = join(f.root, "backups");
  await mkdir(destination);
  await assert.rejects(
    f.store.createBackup(f.book.id, destination, { maxBytes: 1024 }),
    /容量限制/,
  );
  assert.deepEqual(await readdir(destination), []);
  assert.deepEqual(await readFile(f.path(a)), f.bytes);
  const backup = await f.store.createBackup(f.book.id, destination);
  const restored = await f.store.restoreBackup(backup.path);
  assert.equal(
    (await f.store.assets.preview(restored.id, a)).blob.sha256,
    a.blob.sha256,
  );
});

test("image association labels read only same-book metadata even when manuscript bytes cannot be decoded", async () => {
  const f = await fixture();
  const card = await f.store.materials.save(f.book.id, {
    kind: "character",
    title: "林渡",
    notes: "只读名称",
    status: "planned",
    fields: {},
    chapterIds: [],
  });
  const bodyPath = join(f.folder, "manuscript", f.book.chapters[0].id + ".md"),
    damaged = Buffer.from([0xc3, 0x28]);
  await writeFile(bodyPath, damaged);
  const labels = await f.store.assets.linkOptions(f.book.id, [
    card.id,
    randomUUID(),
  ]);
  assert.equal(labels[0].title, "林渡");
  assert.equal(labels[0].state, "active");
  assert.equal(labels[1].state, "missing");
  assert.deepEqual(await readFile(bodyPath), damaged);
  await assert.rejects(
    async () => f.store.assets.linkOptions(f.book.id, [card.id, card.id]),
    /关联选择/,
  );
});
