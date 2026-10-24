/** Controlled print values shared by editable and fixed-page publication. */
export function normalizePublicationLayout(
  input = {},
  { label, paper, papers },
) {
  const defaults = {
    paper,
    font: "serif",
    size: 11,
    leading: 1.8,
    margin: "standard",
    keepParagraphs: "balanced",
  };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some((key) => !Object.hasOwn(defaults, key))
  )
    throw new Error(`${label}排版选项格式不支持`);
  const result = { ...defaults, ...input };
  for (const [key, allowed] of Object.entries({
    paper: papers,
    font: ["serif", "sans"],
    margin: ["standard", "wide"],
    keepParagraphs: ["balanced", "flow"],
  }))
    if (!allowed.includes(result[key]))
      throw new Error(`${label}排版选项 ${key} 无效`);
  if (
    !Number.isInteger(result.size) ||
    result.size < 9 ||
    result.size > 18 ||
    !Number.isFinite(result.leading) ||
    result.leading < 1.2 ||
    result.leading > 2.4
  )
    throw new Error(`${label}字号或行距超出支持范围`);
  return Object.freeze(result);
}
