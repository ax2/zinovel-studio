import { validateMaterialInput } from "./materials.mjs";

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
  return validateMaterialInput({
    ...baseline,
    title: value.title,
    fields: value.fields,
    notes: value.notes,
  });
}
