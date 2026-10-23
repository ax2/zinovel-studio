export const evidenceKinds = [
  { id: "fact", label: "正文事实" },
  { id: "plant", label: "伏笔埋设" },
  { id: "reinforce", label: "伏笔强化" },
  { id: "payoff", label: "伏笔回收" },
  { id: "state", label: "状态变化" },
  { id: "relation", label: "关系变化" },
  { id: "knowledge", label: "认知变化" },
];
export function evidenceInput(value, ownerKind) {
  if (!value || !evidenceKinds.some((kind) => kind.id === value.kind))
    throw new Error("证据类型无效");
  if (
    ["plant", "reinforce", "payoff"].includes(value.kind) &&
    ownerKind !== "foreshadow"
  )
    throw new Error("伏笔证据只能添加到伏笔资料");
  if (
    typeof value.statement !== "string" ||
    !value.statement.trim() ||
    value.statement.length > 10000
  )
    throw new Error("请填写证据说明（最多 1 万字符）");
  if (typeof value.storyTime !== "string" || value.storyTime.length > 200)
    throw new Error("故事时间无效");
  if (!["world", "reader", "character"].includes(value.scope))
    throw new Error("认知范围无效");
  if (value.scope === "character" && ownerKind !== "character")
    throw new Error("人物已知范围需要绑定人物资料");
  if (
    !Array.isArray(value.relatedIds) ||
    value.relatedIds.length > 20 ||
    value.relatedIds.some(
      (id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id),
    )
  )
    throw new Error("关联资料无效");
  if (value.kind === "relation" && !value.relatedIds.length)
    throw new Error("关系变化需要关联另一份资料");
  return {
    kind: value.kind,
    statement: value.statement.trim(),
    storyTime: value.storyTime,
    scope: value.scope,
    relatedIds: [...new Set(value.relatedIds)],
  };
}
export function validateEvidence(records, ownerKind) {
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length > 250)
    throw new Error("资料证据过多或格式无效");
  const ids = new Set();
  for (const record of records) {
    evidenceInput(record, ownerKind);
    if (
      typeof record.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(record.id) ||
      ids.has(record.id) ||
      typeof record.chapterId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(record.chapterId)
    )
      throw new Error("证据身份无效");
    ids.add(record.id);
    const a = record.anchor;
    if (
      !a ||
      !Number.isInteger(a.start) ||
      !Number.isInteger(a.end) ||
      a.start < 0 ||
      a.end <= a.start ||
      a.end - a.start > 12000 ||
      typeof a.quote !== "string" ||
      a.quote.length !== a.end - a.start ||
      typeof a.prefix !== "string" ||
      a.prefix.length > 40 ||
      typeof a.suffix !== "string" ||
      a.suffix.length > 40 ||
      typeof a.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.hash) ||
      !["active", "retired"].includes(record.status)
    )
      throw new Error("证据锚点无效");
  }
}
