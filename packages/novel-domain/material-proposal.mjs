import { validateMaterialInput } from "./materials.mjs";
export const materialAuthorFields = (kind) =>
  kind === "research"
    ? ["boundary", "checkedAt"]
    : kind === "proposition"
      ? ["truthIntent"]
      : [];

/** Only editable prose fields are proposed; identity, links, authority and evidence are host-owned. */
export function materialProposal(value, baseline) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["title", "fields", "notes"].includes(key),
    )
  )
    throw new Error("资料候选只能包含标题、类型字段和笔记");
  if (JSON.stringify(value).length > 120000)
    throw new Error("资料候选超过 12 万字符限制，请分次修改");
  if (
    materialAuthorFields(baseline.kind).some(
      (key) => (value.fields?.[key] || "") !== (baseline.fields[key] || ""),
    )
  )
    throw new Error(
      baseline.kind === "research"
        ? "AI 提案不能改变现实资料的作者性质标记或核对记录，请在原资料中手工修改"
        : "AI 提案不能改变命题的作者真相设定，请在原资料中手工修改",
    );
  return validateMaterialInput({
    ...baseline,
    title: value.title,
    fields: value.fields,
    notes: value.notes,
  });
}
