import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  prepareAssetReference,
  validateAssetReference,
} from "../packages/novel-storage/reference-image.mjs";
const input = {
  title: "参考原图",
  purpose: "reference",
  source: "自行合成",
  rights: "测试",
  notes: "原件",
  linkedIds: [],
};
const expected = (a) => ({
  id: a.id,
  revision: a.revision,
  diskHash: a.diskHash,
});
async function fixture() {
  const library = await mkdtemp(join(tmpdir(), "novel-asset-reference-")),
    store = new NovelStore(library);
  const book = await store.createBook("参考图合成书");
  const bytes = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "#28718d" },
  })
    .png()
    .toBuffer();
  const asset = await store.assets.import(book.id, bytes, input);
  return { library, store, book, asset, bytes, root: join(library, book.id) };
}
test("same-book fixed reference preparation preserves original and creates no canonical records", async () => {
  const f = await fixture(),
    path = join(f.root, "assets/items", f.asset.id + ".json");
  const before = await readFile(path),
    transactions = await readdir(join(f.root, ".zinovel/transactions"));
  const prepared = await prepareAssetReference(
    f.store.assets,
    f.book.id,
    expected(f.asset),
  );
  assert.equal(prepared.reference.bookId, f.book.id);
  assert.deepEqual(prepared.reference.asset, expected(f.asset));
  assert.equal(prepared.reference.sourceBlob.sha256, f.asset.blob.sha256);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(
    await readdir(join(f.root, ".zinovel/transactions")),
    transactions,
  );
  await validateAssetReference(f.store.assets, f.book.id, prepared.reference);
  const other = await f.store.createBook("另一书");
  await assert.rejects(
    prepareAssetReference(f.store.assets, other.id, expected(f.asset)),
  );
  await assert.rejects(
    validateAssetReference(f.store.assets, other.id, prepared.reference),
    /所属作品/,
  );
  await assert.rejects(
    prepareAssetReference(f.store.assets, f.book.id, {
      ...expected(f.asset),
      path: "C:/private.png",
    }),
    /路径|URL/,
  );
});
test("reference metadata changes during decode refuse a stale preview", async () => {
  const f = await fixture(),
    original = f.store.assets.decode.bind(f.store.assets);
  let edited;
  f.store.assets.decode = async (...args) => {
    const image = await original(...args);
    edited = await f.store.assets.save(
      f.book.id,
      { ...input, notes: "作者刚修改说明" },
      expected(f.asset),
    );
    return image;
  };
  await assert.rejects(
    prepareAssetReference(f.store.assets, f.book.id, expected(f.asset)),
    /修改|改变/,
  );
  assert.equal(
    (await f.store.assets.read(f.book.id, f.asset.id)).diskHash,
    edited.diskHash,
  );
});
test("recycled references and corrupted originals cannot be sent from an old preparation", async () => {
  const f = await fixture(),
    prepared = await prepareAssetReference(
      f.store.assets,
      f.book.id,
      expected(f.asset),
    );
  const deleted = await f.store.assets.setDeleted(
    f.book.id,
    expected(f.asset),
    true,
  );
  await assert.rejects(
    prepareAssetReference(f.store.assets, f.book.id, expected(deleted)),
    /回收/,
  );
  await assert.rejects(
    validateAssetReference(f.store.assets, f.book.id, prepared.reference),
    /修改|改变/,
  );
  const restored = await f.store.assets.setDeleted(
    f.book.id,
    expected(deleted),
    false,
  );
  const fresh = await prepareAssetReference(
    f.store.assets,
    f.book.id,
    expected(restored),
  );
  const blob = join(
    f.root,
    "assets/blobs",
    f.asset.blob.sha256 + "." + f.asset.blob.format,
  );
  const corrupt = Buffer.from(f.bytes);
  corrupt[20] ^= 1;
  await writeFile(blob, corrupt);
  await assert.rejects(
    validateAssetReference(f.store.assets, f.book.id, fresh.reference),
  );
  assert.deepEqual(await readFile(blob), corrupt);
});
