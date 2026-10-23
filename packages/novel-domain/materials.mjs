// Shared form definitions; these fields describe author intent, not established canon.
/** @param {string} key @param {string} label @param {string[] | undefined} options */
const field = (key, label, options = undefined) => ({ key, label, options });
export const materialKinds = [
  {
    id: "idea",
    label: "创意",
    fields: [
      field("promise", "题材与读者承诺"),
      field("conflict", "核心冲突"),
      field("hook", "独特切入点"),
      field("audience", "目标读者"),
    ],
  },
  {
    id: "character",
    label: "人物",
    fields: [
      field("aliases", "别名与称谓"),
      field("desire", "欲望与目标"),
      field("flaw", "缺陷与代价"),
      field("voice", "语言与声音"),
      field("appearance", "外貌与衣装"),
      field("arc", "人物变化"),
    ],
  },
  {
    id: "location",
    label: "地点",
    fields: [
      field("region", "所属区域"),
      field("environment", "环境与感官"),
      field("culture", "文化与生活"),
      field("constraints", "通行与地理约束"),
    ],
  },
  {
    id: "rule",
    label: "世界规则",
    fields: [
      field("category", "规则类别", [
        "自然",
        "历史",
        "文化",
        "制度",
        "能力",
        "其他",
      ]),
      field("rule", "规则内容"),
      field("cost", "限制与代价"),
      field("exception", "例外及条件"),
    ],
  },
  {
    id: "outline",
    label: "纲要",
    fields: [
      field("level", "纲要层级", [
        "全书总纲",
        "分卷纲要",
        "章节大纲",
        "近期细纲",
      ]),
      field("goal", "目标与规模"),
      field("cause", "关键因果"),
      field("turn", "不可逆转折"),
      field("ending", "终局与落点"),
    ],
  },
  {
    id: "scene",
    label: "场景",
    fields: [
      field("pov", "视角人物"),
      field("location", "场景地点"),
      field("time", "故事时间"),
      field("goal", "场景目标"),
      field("obstacle", "阻碍"),
      field("choice", "人物选择"),
      field("result", "结果与局面变化"),
    ],
  },
  {
    id: "thread",
    label: "主支线",
    fields: [
      field("type", "线索类型", ["主线", "支线"]),
      field("owner", "推动人物"),
      field("goal", "追求与冲突"),
      field("nodes", "进展节点"),
      field("returnWindow", "回归窗口"),
      field("ending", "交汇与收束"),
    ],
  },
  {
    id: "foreshadow",
    label: "伏笔计划",
    fields: [
      field("clue", "线索设计"),
      field("plant", "预期埋设位置"),
      field("reinforcement", "强化安排"),
      field("payoff", "回收方式与窗口"),
    ],
  },
];
export function materialKind(id) {
  const result = materialKinds.find((kind) => kind.id === id);
  if (!result) throw new Error("未知创作资料类型");
  return result;
}
export function validateMaterialInput(input) {
  if (!input || typeof input !== "object") throw new Error("资料内容无效");
  const kind = materialKind(input.kind);
  const text = (value, max, label) => {
    if (typeof value !== "string" || value.length > max)
      throw new Error(`${label}过长或无效`);
    return value;
  };
  const title = text(input.title, 200, "标题").trim();
  if (!title) throw new Error("请输入资料标题");
  if (!["planned", "accepted"].includes(input.status))
    throw new Error("设定状态无效");
  if (
    !input.fields ||
    typeof input.fields !== "object" ||
    Array.isArray(input.fields)
  )
    throw new Error("资料字段无效");
  if (
    Object.keys(input.fields).some(
      (key) => !kind.fields.some((field) => field.key === key),
    )
  )
    throw new Error("资料包含不支持的字段");
  const fields = {};
  for (const field of kind.fields) {
    const value = text(input.fields[field.key] ?? "", 10000, field.label);
    if (value && field.options && !field.options.includes(value))
      throw new Error(`${field.label}选项无效`);
    fields[field.key] = value;
  }
  if (
    !Array.isArray(input.chapterIds) ||
    input.chapterIds.length > 1000 ||
    input.chapterIds.some(
      (id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id),
    )
  )
    throw new Error("关联章节无效或过多");
  return {
    kind: kind.id,
    title,
    status: input.status,
    fields,
    notes: text(input.notes, 120000, "笔记"),
    chapterIds: [...new Set(input.chapterIds)],
  };
}
export function materialMarkdown(data) {
  const kind = materialKind(data.kind);
  return (
    [
      `# ${data.title}`,
      `类型：${kind.label} · 版本 ${data.revision}`,
      `状态：${data.status === "accepted" ? "作者已确认设定" : "作者计划"}（不代表正文已证实）`,
      ...kind.fields.map(
        (field) =>
          `## ${field.label}\n\n${data.fields[field.key] || "（未填写）"}`,
      ),
      `## 笔记\n\n${data.notes}`,
      `## 关联章节\n\n${(data.chapters || []).map((chapter) => `- ${chapter.title} (${chapter.id})${chapter.state !== "active" ? " · 引用待检查" : ""}`).join("\n")}`,
    ].join("\n\n") + "\n"
  );
}
