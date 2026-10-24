export const assetPurposes = [
  "cover",
  "portrait",
  "map",
  "illustration",
  "reference",
];
export const assetLimits = Object.freeze({
  bytes: 20 * 1024 * 1024,
  pixels: 20000000,
  dimension: 16384,
  thumbnail: 512,
});
export const assetId = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
  )
    throw new Error("图像资源身份无效");
  return value;
};
export const assetHash = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("图像资源校验值无效");
  return value;
};
function keys(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new Error("图像资源格式不支持，请保留原文件");
}
function text(value, max, required = false, draft = false) {
  if (
    typeof value !== "string" ||
    (!draft && !value.isWellFormed()) ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error("图像说明为空、过长或包含不完整Unicode");
  return value;
}
function inputFields(input, draft) {
  keys(input, ["title", "purpose", "source", "rights", "notes", "linkedIds"]);
  if (!assetPurposes.includes(input.purpose)) throw new Error("图像用途无效");
  if (
    !Array.isArray(input.linkedIds) ||
    input.linkedIds.length > 32 ||
    new Set(input.linkedIds).size !== input.linkedIds.length
  )
    throw new Error("请选择最多32个不同的关联资料");
  return {
    title: text(input.title, 200, !draft, draft),
    purpose: input.purpose,
    source: text(input.source, 4000, false, draft),
    rights: text(input.rights, 4000, false, draft),
    notes: text(input.notes, 16000, false, draft),
    linkedIds: input.linkedIds.map(assetId),
  };
}
export const assetInput = (input) => inputFields(input, false);
// Local drafts may contain temporarily empty titles or incomplete text; formal records never do.
export const assetDraftInput = (input) => inputFields(input, true);
export function validateAssetBlob(blob) {
  keys(blob, [
    "sha256",
    "bytes",
    "format",
    "mime",
    "width",
    "height",
    "orientation",
    "displayWidth",
    "displayHeight",
  ]);
  assetHash(blob.sha256);
  if (
    !Object.hasOwn(
      { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" },
      blob.format,
    ) ||
    blob.mime !==
      { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[blob.format]
  )
    throw new Error("图像格式无效");
  if (
    !Number.isSafeInteger(blob.bytes) ||
    blob.bytes < 1 ||
    blob.bytes > assetLimits.bytes
  )
    throw new Error("图像文件大小无效");
  for (const key of ["width", "height", "displayWidth", "displayHeight"])
    if (
      !Number.isSafeInteger(blob[key]) ||
      blob[key] < 1 ||
      blob[key] > assetLimits.dimension
    )
      throw new Error("图像尺寸无效");
  if (
    blob.width * blob.height > assetLimits.pixels ||
    !Number.isSafeInteger(blob.orientation) ||
    blob.orientation < 1 ||
    blob.orientation > 8
  )
    throw new Error("图像像素或方向无效");
  const rotated = blob.orientation >= 5;
  if (
    blob.displayWidth !== (rotated ? blob.height : blob.width) ||
    blob.displayHeight !== (rotated ? blob.width : blob.height)
  )
    throw new Error("图像显示方向与尺寸不符");
  return { ...blob };
}
export function validateAssetRecord(record, id, origins) {
  keys(record, [
    "schemaVersion",
    "id",
    "bookId",
    "revision",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "blob",
    "creationHash",
    "title",
    "purpose",
    "source",
    "rights",
    "notes",
    "linkedIds",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.id !== assetId(id) ||
    !origins.includes(assetId(record.bookId)) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  )
    throw new Error("图像版本或所属作品不符，请保留原文件");
  for (const key of ["createdAt", "updatedAt"])
    if (
      typeof record[key] !== "string" ||
      !Number.isFinite(Date.parse(record[key]))
    )
      throw new Error("图像记录时间无效");
  if (
    record.deletedAt !== undefined &&
    (typeof record.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(record.deletedAt)))
  )
    throw new Error("图像回收记录无效");
  assetInput(
    Object.fromEntries(
      ["title", "purpose", "source", "rights", "notes", "linkedIds"].map(
        (key) => [key, record[key]],
      ),
    ),
  );
  validateAssetBlob(record.blob);
  assetHash(record.creationHash);
  return record;
}
