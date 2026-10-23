export const knowledgeStates = [
  { id: "recorded", label: "世界记录" },
  { id: "knows", label: "知道" },
  { id: "believes", label: "相信" },
  { id: "suspects", label: "怀疑" },
  { id: "unaware", label: "明确不知" },
  { id: "forgotten", label: "遗忘" },
  { id: "unspecified", label: "状态未明确" },
];
export function knowledgeInput(value) {
  const validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
  if (
    !value ||
    !validId(value.propositionId) ||
    !["world", "reader", "character"].includes(value.scope)
  )
    throw new Error("命题或认知范围无效");
  if (
    value.scope === "character"
      ? !validId(value.characterId)
      : value.characterId !== null &&
        value.characterId !== undefined &&
        value.characterId !== ""
  )
    throw new Error("人物认知必须绑定本书人物，其他范围不绑定人物");
  if (
    !knowledgeStates.some((state) => state.id === value.state) ||
    (value.scope === "world"
      ? !["recorded", "unspecified"].includes(value.state)
      : value.state === "recorded")
  )
    throw new Error("认知状态无效");
  for (const [key, max] of [
    ["statement", 10000],
    ["storyTime", 200],
  ])
    if (
      typeof value[key] !== "string" ||
      !value[key].isWellFormed() ||
      value[key].includes("\0") ||
      value[key].length > max
    )
      throw new Error("认知说明或故事时间过长或无效");
  if (!value.statement.trim()) throw new Error("请填写认知记录说明");
  return {
    propositionId: value.propositionId,
    scope: value.scope,
    characterId: value.scope === "character" ? value.characterId : null,
    state: value.state,
    statement: value.statement.trim(),
    storyTime: value.storyTime,
  };
}
