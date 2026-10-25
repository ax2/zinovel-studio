import { assetId, assetHash, validateAssetRecord } from "./assets.mjs";

export const characterLookLimits = Object.freeze({
  entries: 128,
  bytes: 1024 * 1024,
});
export const characterLookFields = Object.freeze([
  ["title", "形象名称", 200],
  ["age", "年龄描述", 400],
  ["outfit", "衣装", 1600],
  ["expression", "表情", 800],
  ["view", "视角", 400],
  ["period", "剧情时期", 800],
  ["constraints", "一致性约束", 4000],
  ["notes", "形象备注", 4000],
]);
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("人物形象格式不支持，请保留原件");
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("人物形象版本无效");
  return value;
}
function at(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("人物形象时间无效");
  return value;
}
export function characterLookInput(value, { draft = false } = {}) {
  keys(
    value,
    characterLookFields.map(([key]) => key),
  );
  return Object.fromEntries(
    characterLookFields.map(([key, , max]) => {
      const text = value[key];
      if (
        typeof text !== "string" ||
        text.length > max ||
        (!draft && (!text.isWellFormed() || (key === "title" && !text.trim())))
      )
        throw new Error("人物形象文字为空、过长或Unicode不完整");
      return [key, text];
    }),
  );
}
export function characterLookExpected(value, withId = false) {
  keys(
    value,
    withId ? ["id", "revision", "diskHash"] : ["revision", "diskHash"],
  );
  return {
    ...(withId ? { id: assetId(value.id) } : {}),
    revision: revision(value.revision),
    diskHash: assetHash(value.diskHash),
  };
}
export function validateCharacterLooks(record, characterId, origins) {
  keys(record, [
    "schemaVersion",
    "bookId",
    "characterId",
    "revision",
    "createdAt",
    "updatedAt",
    "entries",
    "selected",
  ]);
  if (
    record.schemaVersion !== 1 ||
    !origins.includes(assetId(record.bookId)) ||
    record.characterId !== assetId(characterId)
  )
    throw new Error("人物形象版本、人物或所属作品不符，请保留原件");
  revision(record.revision);
  at(record.createdAt);
  at(record.updatedAt);
  if (
    !Array.isArray(record.entries) ||
    record.entries.length > characterLookLimits.entries
  )
    throw new Error("人物形象数量超过限制");
  const ids = new Set();
  for (const entry of record.entries) {
    keys(entry, [
      "id",
      "revision",
      "createdAt",
      "updatedAt",
      "deletedAt",
      "character",
      "asset",
      "input",
    ]);
    const id = assetId(entry.id);
    if (ids.has(id)) throw new Error("人物形象身份重复");
    ids.add(id);
    revision(entry.revision);
    at(entry.createdAt);
    at(entry.updatedAt);
    if (entry.deletedAt !== null) at(entry.deletedAt);
    if (characterLookExpected(entry.character, true).id !== characterId)
      throw new Error("形象关联了其他人物");
    keys(entry.asset, ["record", "diskHash"]);
    assetHash(entry.asset.diskHash);
    validateAssetRecord(entry.asset.record, entry.asset.record?.id, origins);
    if (
      entry.asset.record.purpose !== "portrait" ||
      !entry.asset.record.linkedIds.includes(characterId) ||
      entry.asset.record.deletedAt
    )
      throw new Error("人物形象须使用关联此人物的未回收定妆资源");
    characterLookInput(entry.input);
  }
  const selected = record.selected;
  if (selected !== null) {
    keys(selected, [
      "source",
      "entryId",
      "entryRevision",
      "selectedAt",
      "character",
    ]);
    const source = characterLookExpected(selected.source);
    if (source.revision >= record.revision)
      throw new Error("定妆选择必须引用已保存的历史版本");
    const entry = record.entries.find(
      (e) => e.id === assetId(selected.entryId),
    );
    if (
      !entry ||
      entry.deletedAt ||
      revision(selected.entryRevision) > entry.revision
    )
      throw new Error("定妆选择的形象不存在或已回收");
    if (characterLookExpected(selected.character, true).id !== characterId)
      throw new Error("定妆选择的人物不符");
    at(selected.selectedAt);
  }
  return record;
}
