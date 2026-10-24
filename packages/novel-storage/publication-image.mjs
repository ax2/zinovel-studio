import sharp from "sharp";
import { assetHash, assetLimits } from "../novel-domain/assets.mjs";
import { publicationResourceLimits } from "../novel-domain/publication-resources.mjs";
import { binaryHash, inspectAssetImage } from "./image-decoder.mjs";

/** Prepare an immutable publication rendition; never replace the source image bytes. */
export async function preparePublicationImage(input, expectedSourceHash) {
  assetHash(expectedSourceHash);
  const source = await inspectAssetImage(input);
  if (source.blob.sha256 !== expectedSourceHash)
    throw new Error("出版原图hash已改变，未生成发行图");
  const { data, info } = await sharp(source.bytes, {
    failOn: "warning",
    limitInputPixels: assetLimits.pixels,
    limitInputChannels: 4,
  })
    .autoOrient()
    .png({ compressionLevel: 6, progressive: false })
    .toBuffer({ resolveWithObject: true });
  if (
    info.format !== "png" ||
    info.width !== source.blob.displayWidth ||
    info.height !== source.blob.displayHeight ||
    data.length < 1 ||
    data.length > publicationResourceLimits.imageBytes
  )
    throw new Error("出版发行图尺寸或容量不支持，原图未改动");
  return Object.freeze({
    sourceHash: expectedSourceHash,
    renderVersion: 1,
    image: Object.freeze({
      sha256: binaryHash(data),
      bytes: data.length,
      width: info.width,
      height: info.height,
    }),
    bytes: data,
  });
}
