import { mapId } from "./maps.mjs";

export const atlasLimits = Object.freeze({
  entries: 1000,
  epochs: 128,
  depth: 32,
  bytes: 1024 * 1024,
});
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("地图册格式不支持，请保留原件");
}
function text(value, max, required = false) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error("地图册文字为空、过长或包含不完整Unicode");
  return value;
}
const nullableId = (value) => (value === null ? null : mapId(value));
/** Independent map frames: membership never transforms or guesses their coordinates. */
export function mapAtlasInput(value) {
  keys(value, ["notes", "epochs", "entries"]);
  if (
    !Array.isArray(value.epochs) ||
    value.epochs.length > atlasLimits.epochs ||
    !Array.isArray(value.entries) ||
    value.entries.length > atlasLimits.entries
  )
    throw new Error("地图册目录数量超出保护上限");
  const epochs = value.epochs.map((item) => {
    keys(item, ["id", "title", "notes"]);
    return {
      id: mapId(item.id),
      title: text(item.title, 200, true),
      notes: text(item.notes, 4000),
    };
  });
  const epochIds = new Set(epochs.map((item) => item.id));
  if (epochIds.size !== epochs.length) throw new Error("地图年代组身份重复");
  const entries = value.entries.map((item) => {
    keys(item, ["mapId", "parentId", "anchorId", "epochId", "notes"]);
    const entry = {
      mapId: mapId(item.mapId),
      parentId: nullableId(item.parentId),
      anchorId: nullableId(item.anchorId),
      epochId: nullableId(item.epochId),
      notes: text(item.notes, 4000),
    };
    if (entry.epochId && !epochIds.has(entry.epochId))
      throw new Error("年代组已缺失，请先明确解除或重新指定");
    if ((entry.parentId === null) !== (entry.anchorId === null))
      throw new Error("子地图须明确指定父图及地点或区域锚点");
    return entry;
  });
  const nodes = new Map(entries.map((item) => [item.mapId, item]));
  if (nodes.size !== entries.length)
    throw new Error("同一地图在目录中重复，请明确选择一个目录位置");
  for (const node of entries) {
    const seen = new Set([node.mapId]);
    let current = node;
    while (current.parentId !== null) {
      if (seen.has(current.parentId))
        throw new Error("地图层级不能循环或引用自身");
      if (!nodes.has(current.parentId))
        throw new Error("父图目录缺失，请先明确关联父图或解除子图关系");
      seen.add(current.parentId);
      if (seen.size > atlasLimits.depth)
        throw new Error("地图层级深度超出保护上限");
      current = nodes.get(current.parentId);
    }
  }
  return { notes: text(value.notes, 12000), epochs, entries };
}
export function validateMapAtlasRecord(value, origins) {
  keys(value, [
    "schemaVersion",
    "bookId",
    "revision",
    "createdAt",
    "updatedAt",
    "notes",
    "epochs",
    "entries",
  ]);
  if (value.schemaVersion !== 1)
    throw new Error("地图册版本不支持，请保留原件");
  mapId(value.bookId);
  if (!origins.includes(value.bookId)) throw new Error("地图册所属作品不符");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new Error("地图册修订无效");
  for (const field of ["createdAt", "updatedAt"])
    if (
      typeof value[field] !== "string" ||
      !Number.isFinite(Date.parse(value[field]))
    )
      throw new Error("地图册时间无效");
  mapAtlasInput({
    notes: value.notes,
    epochs: value.epochs,
    entries: value.entries,
  });
  return value;
}
