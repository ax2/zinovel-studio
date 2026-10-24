import sharp from "sharp";
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import { assetLimits, validateAssetBlob } from "../novel-domain/assets.mjs";

export const binaryHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
function imageFormat(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        end = offset + 12 + length;
      if (end > bytes.length) throw new Error("PNG文件不完整");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL")
        throw new Error("暂不支持多帧图像，请另存为静态图片");
      offset = end;
      if (type === "IEND") {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) throw new Error("PNG文件不完整或带有未识别内容");
    return "png";
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length)
      throw new Error("WebP文件不完整");
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4);
      if (type === "ANIM" || type === "ANMF")
        throw new Error("暂不支持多帧图像，请另存为静态图片");
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) throw new Error("WebP文件不完整");
    }
    if (offset !== bytes.length) throw new Error("WebP文件不完整");
    return "webp";
  }
  throw new Error("请选择PNG、JPEG或WebP静态图像，不能只修改文件后缀");
}
export function copyImageBytes(input) {
  if (
    !(input instanceof Uint8Array) ||
    !input.byteLength ||
    input.byteLength > assetLimits.bytes
  )
    throw new Error("图像文件须为1字节至20MiB");
  return Buffer.from(input);
}
export async function readAssetSource(path) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > assetLimits.bytes
  )
    throw new Error("请选择20MiB以内的本地普通图像文件");
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (before.size !== info.size || !before.isFile())
      throw new Error("所选原图已经改变，请重新选择");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const chunk = await file.read(bytes, count, bytes.length - count, count);
      if (!chunk.bytesRead) break;
      count += chunk.bytesRead;
    }
    const after = await file.stat();
    if (
      count !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("读取时原图发生变化，请重新选择，原文件未改动");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
export async function inspectAssetImage(
  input,
  previewEdge = assetLimits.thumbnail,
) {
  if (![assetLimits.thumbnail, 2048].includes(previewEdge))
    throw new Error("图像预览尺寸无效");
  const bytes = copyImageBytes(input),
    format = imageFormat(bytes);
  const options = {
    failOn: "warning",
    limitInputPixels: assetLimits.pixels,
    limitInputChannels: 4,
  };
  try {
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== format || (metadata.pages || 1) !== 1)
      throw new Error("图像格式或帧数不符");
    const blob = validateAssetBlob({
      sha256: binaryHash(bytes),
      bytes: bytes.length,
      format,
      mime: { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[
        format
      ],
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation || 1,
      displayWidth: metadata.autoOrient.width,
      displayHeight: metadata.autoOrient.height,
    });
    // metadata() does not decode compressed pixels: producing a thumbnail is required.
    const thumbnail = await sharp(bytes, options)
      .autoOrient()
      .resize({
        width: previewEdge,
        height: previewEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const outputLimit = previewEdge === 2048 ? 20 : 2;
    if (thumbnail.length > outputLimit * 1024 * 1024)
      throw new Error("图像预览超出上限");
    return { bytes, blob, thumbnail };
  } catch {
    throw new Error("图像无法完整解码、尺寸过大或格式不支持，原文件未改动");
  }
}
