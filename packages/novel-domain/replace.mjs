/** Literal replacement preview with UTF-16 offsets and no regex execution. */
export function previewReplacement(body, query, replacement) {
  if (
    typeof body !== "string" ||
    typeof query !== "string" ||
    !query.length ||
    query.length > 2000 ||
    typeof replacement !== "string" ||
    replacement.length > 20000
  )
    throw new Error("查找或替换内容无效");
  const matches = [];
  let cursor = 0,
    count = 0,
    result = "";
  while (true) {
    const start = body.indexOf(query, cursor);
    if (start === -1) break;
    count++;
    if (matches.length < 50)
      matches.push({
        start,
        end: start + query.length,
        excerpt: body.slice(Math.max(0, start - 20), start + query.length + 30),
      });
    result += body.slice(cursor, start) + replacement;
    cursor = start + query.length;
  }
  result += body.slice(cursor);
  if (result.length > 8 * 1024 * 1024)
    throw new Error("替换结果过大，请缩小范围");
  return { matches, count, body: result, truncated: count > matches.length };
}
