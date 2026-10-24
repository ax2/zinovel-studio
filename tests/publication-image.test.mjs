import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import { preparePublicationImage } from "../packages/novel-storage/publication-image.mjs";

function chunks(bytes) {
  const names = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    names.push(bytes.toString("ascii", offset + 4, offset + 8));
    offset += length + 12;
  }
  return names;
}
test("publication PNG rendition retains full pixels and alpha, strips private metadata, and never modifies originals", async () => {
  const bytes = await sharp({
    create: {
      width: 64,
      height: 32,
      channels: 4,
      background: { r: 18, g: 107, b: 131, alpha: 0.5 },
    },
  })
    .withMetadata()
    .png()
    .toBuffer();
  const before = Buffer.from(bytes),
    hash = binaryHash(bytes);
  assert.ok((await sharp(bytes).metadata()).icc);
  const result = await preparePublicationImage(bytes, hash);
  assert.deepEqual(bytes, before);
  assert.equal(result.sourceHash, hash);
  assert.equal(result.image.width, 64);
  assert.equal(result.image.height, 32);
  assert.equal(result.image.sha256, binaryHash(result.bytes));
  assert.equal(result.renderVersion, 1);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.deepEqual(chunks(result.bytes), ["IHDR", "pHYs", "IDAT", "IEND"]);
  assert.deepEqual(
    await sharp(result.bytes).raw().toBuffer(),
    await sharp(bytes).raw().toBuffer(),
  );
  assert.equal(
    (await preparePublicationImage(bytes, hash)).image.sha256,
    result.image.sha256,
  );
  await assert.rejects(preparePublicationImage(bytes, "a".repeat(64)), /hash/);
});
test("publication PNG follows JPEG orientation and handles static WebP without downsampling", async () => {
  const jpeg = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#126b83" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await preparePublicationImage(jpeg, binaryHash(jpeg));
  assert.equal(result.image.width, 40);
  assert.equal(result.image.height, 80);
  assert.equal((await sharp(result.bytes).metadata()).orientation, undefined);
  const webp = await sharp({
    create: { width: 91, height: 47, channels: 3, background: "#943627" },
  })
    .webp()
    .toBuffer();
  const converted = await preparePublicationImage(webp, binaryHash(webp));
  assert.equal(converted.image.width, 91);
  assert.equal(converted.image.height, 47);
  assert.equal((await sharp(converted.bytes).metadata()).format, "png");
  await assert.rejects(
    preparePublicationImage(webp.subarray(0, 20), binaryHash(webp)),
    /完整|格式|图像/,
  );
});
