import sharp from "sharp";
import { createHash } from "node:crypto";
import { assetLimits } from "./assets.mjs";

/** Copy every input before awaiting, then decode only the exact frozen PNG bytes. */
export async function publicationDocxImages(resources, input) {
  const expected = new Map(
    resources.map((item) => [item.image.sha256, item.image]),
  );
  if (!(input instanceof Map) || input.size !== expected.size)
    throw new Error("DOCX发行图缺失或范围不符，未创建导出");
  const images = new Map();
  let total = 0;
  for (const [hash, image] of expected) {
    const value = input.get(hash);
    if (!(value instanceof Uint8Array) || value.byteLength !== image.bytes)
      throw new Error("DOCX发行图大小不符，未创建导出");
    const bytes = Buffer.from(value);
    total += bytes.length;
    if (total > 64 * 1024 * 1024)
      throw new Error("本次DOCX发行图超过64 MiB，请缩小选图范围");
    if (
      createHash("sha256").update(bytes).digest("hex") !== hash ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("DOCX发行图指纹或格式不符，未创建导出");
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        end = offset + 12 + length;
      if (end > bytes.length) break;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") throw new Error("DOCX发行图不能是动画PNG");
      offset = end;
      if (type === "IEND") {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) throw new Error("DOCX发行PNG不完整或含附加内容");
    images.set(hash, bytes);
  }
  for (const [hash, bytes] of images) {
    const image = expected.get(hash);
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: assetLimits.pixels,
      limitInputChannels: 4,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "png" ||
      (metadata.pages || 1) !== 1 ||
      metadata.width !== image.width ||
      metadata.height !== image.height ||
      metadata.exif ||
      metadata.icc ||
      metadata.xmp ||
      metadata.iptc ||
      metadata.orientation
    )
      throw new Error("DOCX发行图尺寸或去元数据配方不符");
    await decoder.stats();
  }
  return images;
}
