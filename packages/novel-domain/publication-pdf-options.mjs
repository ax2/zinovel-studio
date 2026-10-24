export const defaultPublicationPdfOptions = Object.freeze({
  paper: "A5",
  font: "serif",
  size: 11,
  leading: 1.8,
  margin: "standard",
  keepParagraphs: "balanced",
});

/** Only controlled layout values cross the renderer boundary; never CSS or paths. */
export function publicationPdfOptions(input = {}) {
  const defaults = defaultPublicationPdfOptions;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(defaults, key))
  )
    throw new Error("PDF排版选项格式不支持");
  const result = { ...defaults, ...input };
  for (const [key, allowed] of Object.entries({
    paper: ["A4", "A5"],
    font: ["serif", "sans"],
    margin: ["standard", "wide"],
    keepParagraphs: ["balanced", "flow"],
  }))
    if (!allowed.includes(result[key]))
      throw new Error(`PDF排版选项 ${key} 无效`);
  if (
    !Number.isInteger(result.size) ||
    result.size < 9 ||
    result.size > 18 ||
    !Number.isFinite(result.leading) ||
    result.leading < 1.2 ||
    result.leading > 2.4
  )
    throw new Error("PDF字号或行距超出支持范围");
  return Object.freeze(result);
}
