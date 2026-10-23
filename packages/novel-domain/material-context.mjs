export function materialContextText(pack) {
  if (pack === undefined || pack === null) return "";
  if (
    pack.schemaVersion !== 1 ||
    !Array.isArray(pack.materials) ||
    pack.materials.length > 8
  )
    throw new Error("资料上下文格式无效");
  for (const material of pack.materials) {
    if (
      typeof material.content !== "string" ||
      typeof material.title !== "string" ||
      typeof material.id !== "string" ||
      !Number.isSafeInteger(material.revision)
    )
      throw new Error("资料上下文条目无效");
  }
  const text = pack.materials
    .map(
      (material) =>
        `资料：${material.title}\nID：${material.id} · 版本 ${material.revision}\n${material.content}`,
    )
    .join("\n\n---\n\n");
  if (text.length > 20000)
    throw new Error("所选资料超过 2 万字符，请减少资料选择；不会静默截断");
  return text;
}
