import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { binaryHash } from "../packages/novel-storage/image-decoder.mjs";
import {
  prepareReferenceImage,
  referenceImageLimits,
} from "../packages/novel-storage/reference-image.mjs";

test("reference derivative freezes exact PNG bytes, auto-orients and strips source metadata", async () => {
  const source = await sharp({
    create: { width: 2200, height: 1100, channels: 3, background: "#267485" },
  })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: {
          Artist: "PRIVATE_REFERENCE_ARTIST",
          Copyright: "PRIVATE_SOURCE_RIGHTS",
        },
      },
    })
    .toBuffer();
  const before = Buffer.from(source),
    result = await prepareReferenceImage(source);
  assert.deepEqual(source, before);
  assert.equal(result.sourceBlob.sha256, binaryHash(source));
  assert.equal(result.derivative.sha256, binaryHash(result.bytes));
  assert.equal(result.derivative.bytes, result.bytes.length);
  assert.equal(result.derivative.mime, "image/png");
  assert.ok(result.derivative.bytes <= referenceImageLimits.bytes);
  assert.equal(result.derivative.width, 768);
  assert.equal(result.derivative.height, 1536);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.equal(
    result.bytes.includes(Buffer.from("PRIVATE_REFERENCE_ARTIST")),
    false,
  );
  const again = await prepareReferenceImage(source);
  assert.deepEqual(again.derivative, result.derivative);
  assert.deepEqual(again.bytes, result.bytes);
});

test("small transparent references are not enlarged or flattened", async () => {
  const source = await sharp({
    create: {
      width: 17,
      height: 31,
      channels: 4,
      background: { r: 120, g: 40, b: 20, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const result = await prepareReferenceImage(source),
    metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.width, 17);
  assert.equal(metadata.height, 31);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(result.sourceBlob.sha256, binaryHash(source));
});

test("invalid and truncated reference originals fail before producing sendable bytes", async () => {
  for (const source of [
    Buffer.from("not an image"),
    Buffer.alloc(0),
    new Uint8Array(20 * 1024 * 1024 + 1),
  ])
    await assert.rejects(prepareReferenceImage(source));
  const source = await sharp({
    create: { width: 12, height: 18, channels: 3, background: "#28728e" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    prepareReferenceImage(source.subarray(0, source.length - 8)),
  );
});

test("high entropy references reduce dimensions to meet the actual encoded-byte cap", async () => {
  const pixels = randomBytes(1536 * 1536 * 3);
  const source = await sharp(pixels, {
    raw: { width: 1536, height: 1536, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(source.length > referenceImageLimits.bytes);
  const before = binaryHash(source),
    result = await prepareReferenceImage(source);
  assert.ok(result.bytes.length <= referenceImageLimits.bytes);
  assert.equal(result.derivative.width, 1024);
  assert.equal(result.derivative.height, 1024);
  assert.equal(binaryHash(source), before);
  assert.equal(result.derivative.sha256, binaryHash(result.bytes));
});
