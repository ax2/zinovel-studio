import { assetId, assetHash, assetLimits } from "./assets.mjs";

export const publicationResourceLimits = Object.freeze({
  placements: 32,
  imageBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
});
function exact(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new Error("出版图像字段不支持，请保留当前选择");
}
function text(value, max, required = false) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length > max ||
    (required && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/u.test(value)
  )
    throw new Error("出版图像文字为空、过长或不能完整呈现");
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("出版图像来源版本无效");
  return value;
}
function chapters(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 10000 ||
    new Set(value).size !== value.length
  )
    throw new Error("出版图像需要明确且不重复的所选章节");
  return new Set(value.map(assetId));
}
function placement(input, selected) {
  if (
    !["cover", "chapter-start", "chapter-end"].includes(input.placement) ||
    (input.placement === "cover"
      ? input.chapterId !== null
      : !selected.has(assetId(input.chapterId)))
  )
    throw new Error("出版图像位置不属于本次所选章节");
  return {
    placement: input.placement,
    chapterId: input.chapterId,
    alt: text(input.alt, 2000, true),
    caption: text(input.caption, 4000),
    credit: text(input.credit, 4000),
  };
}
function list(input, selectedIds, convert) {
  const selected = chapters(selectedIds);
  if (
    !Array.isArray(input) ||
    input.length > publicationResourceLimits.placements
  )
    throw new Error("本次出版最多选择32处图像");
  const seen = new Set();
  let covers = 0;
  const result = input.map((value) => {
    const next = convert(value, selected);
    if (next.placement === "cover" && ++covers > 1)
      throw new Error("每份出版副本只能选一张封面");
    const identity = JSON.stringify([
      next.asset?.id ?? next.source.assetId,
      next.placement,
      next.chapterId,
    ]);
    if (seen.has(identity)) throw new Error("同一图像在同一出版位置重复");
    seen.add(identity);
    return Object.freeze(next);
  });
  return Object.freeze(result);
}

/** Validated detached author choices; this does not read images or create a snapshot. */
export function publicationResourceSelections(input, selectedIds) {
  return list(input, selectedIds, (value, selected) => {
    exact(value, [
      "asset",
      "placement",
      "chapterId",
      "alt",
      "caption",
      "credit",
    ]);
    exact(value.asset, ["id", "revision", "diskHash"]);
    return {
      asset: Object.freeze({
        id: assetId(value.asset.id),
        revision: revision(value.asset.revision),
        diskHash: assetHash(value.asset.diskHash),
      }),
      ...placement(value, selected),
    };
  });
}

/** A frozen reference is separate from author input: only the host may construct it. */
export function publicationResourceReferences(input, selectedIds) {
  const result = list(input, selectedIds, (value, selected) => {
    exact(value, [
      "source",
      "image",
      "renderVersion",
      "placement",
      "chapterId",
      "alt",
      "caption",
      "credit",
    ]);
    exact(value.source, ["assetId", "revision", "recordHash", "blobHash"]);
    exact(value.image, ["sha256", "bytes", "width", "height"]);
    const { width, height, bytes } = value.image;
    if (
      value.renderVersion !== 1 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > publicationResourceLimits.imageBytes ||
      ![width, height].every(
        (size) =>
          Number.isSafeInteger(size) &&
          size > 0 &&
          size <= assetLimits.dimension,
      ) ||
      width * height > assetLimits.pixels
    )
      throw new Error("出版发行图版本、容量或尺寸不支持");
    return {
      source: Object.freeze({
        assetId: assetId(value.source.assetId),
        revision: revision(value.source.revision),
        recordHash: assetHash(value.source.recordHash),
        blobHash: assetHash(value.source.blobHash),
      }),
      image: Object.freeze({
        sha256: assetHash(value.image.sha256),
        bytes,
        width,
        height,
      }),
      renderVersion: 1,
      ...placement(value, selected),
    };
  });
  const images = new Map();
  for (const resource of result) {
    const previous = images.get(resource.image.sha256);
    if (previous && JSON.stringify(previous) !== JSON.stringify(resource.image))
      throw new Error("同一出版发行图hash对应不同的尺寸或容量");
    images.set(resource.image.sha256, resource.image);
  }
  if (
    [...images.values()].reduce((sum, image) => sum + image.bytes, 0) >
    publicationResourceLimits.totalBytes
  )
    throw new Error("本次出版发行图去重总量超过128 MiB");
  return result;
}
