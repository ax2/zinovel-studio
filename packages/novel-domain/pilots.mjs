export const pilotFields = [
  ["pov", "叙事视角"],
  ["voice", "语言与声音"],
  ["action", "人物行动"],
  ["obstacle", "场景阻碍"],
  ["promise", "读者承诺"],
];
export function pilotText(value, label, max, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    (required && !value.trim())
  )
    throw new Error(
      `${label}无效，应为${required ? "非空" : ""}完整文本，最多 ${max} 字符`,
    );
  return value;
}
export function pilotInput(input) {
  if (!input || typeof input !== "object") throw new Error("无效的试写内容");
  const result = {
    title: pilotText(input.title, "试写标题", 200, true).trim(),
    body: pilotText(input.body, "试写正文", 2_000_000),
  };
  for (const [key, label] of pilotFields)
    result[key] = pilotText(input[key] ?? "", label, 10_000);
  return result;
}
