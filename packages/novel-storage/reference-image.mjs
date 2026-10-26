import sharp from "sharp";
import { inspectAssetImage, binaryHash } from "./image-decoder.mjs";

export const referenceImageLimits = Object.freeze({
  edge: 1536,
  bytes: 4 * 1024 * 1024,
});

/** Host-only derivation. Callers must separately bind and recheck the same-book asset version.
 * Returns the exact bytes to preview and send; it never writes or modifies the original image.
 */
export async function prepareReferenceImage(input) {
  const image = await inspectAssetImage(input, 2048);
  return deriveReference(image);
}

async function deriveReference(image) {
  for (const edge of [referenceImageLimits.edge, 1024, 512]) {
    const { data, info } = await sharp(image.thumbnail, {
      failOn: "warning",
      limitInputPixels: 2048 * 2048,
    })
      .resize({
        width: edge,
        height: edge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= referenceImageLimits.bytes) {
      return {
        sourceBlob: { ...image.blob },
        bytes: data,
        derivative: {
          algorithm: "reference-png-v1",
          sha256: binaryHash(data),
          bytes: data.length,
          mime: "image/png",
          width: info.width,
          height: info.height,
        },
      };
    }
  }
  throw new Error("参考图衍生结果超过4MiB，未准备发送图片");
}

/** Uses the live host's existing AssetStore/kernel; no second storage writer. */
export async function prepareAssetReference(assets, bookId, value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["id", "revision", "diskHash"].includes(key),
    )
  )
    throw new Error("请选择同书固定资源版本，不能提供参考图路径或URL");
  const expected = assets.expected(value);
  const initial = await assets.storage.exclusive(async () => {
    const ctx = await assets.context(bookId),
      record = await assets.current(ctx, expected);
    if (record.data.deletedAt)
      throw new Error("参考图已移入回收站，请重新选择");
    return {
      title: record.data.title,
      blob: record.data.blob,
      bytes: await assets.blobBytes(ctx, record.data.blob),
    };
  });
  const result = await deriveReference(
    await assets.decode(initial.bytes, 2048),
  );
  if (
    Object.keys(initial.blob).some(
      (key) => initial.blob[key] !== result.sourceBlob[key],
    )
  )
    throw new Error("参考原图与资源记录不符，请重新选择");
  await validateAssetReference(assets, bookId, {
    asset: expected,
    sourceBlob: initial.blob,
  });
  return {
    ...result,
    reference: {
      bookId,
      asset: expected,
      sourceBlob: { ...initial.blob },
      derivative: { ...result.derivative },
    },
    title: initial.title,
  };
}

/** Recheck the captured same-book identity immediately before persisting/sending a task. */
export async function validateAssetReference(assets, bookId, reference) {
  if (reference.bookId !== undefined && reference.bookId !== bookId)
    throw new Error("参考图所属作品不符");
  const expected = assets.expected(reference.asset);
  const sourceBlob = { ...reference.sourceBlob };
  await assets.storage.exclusive(async () => {
    const ctx = await assets.context(bookId),
      record = await assets.current(ctx, expected);
    if (record.data.deletedAt)
      throw new Error("参考图已移入回收站，请重新选择");
    if (
      Object.keys(record.data.blob).some(
        (key) => record.data.blob[key] !== sourceBlob[key],
      )
    )
      throw new Error("参考原图版本已经改变，请重新准备");
    await assets.blobBytes(ctx, record.data.blob);
  });
}
