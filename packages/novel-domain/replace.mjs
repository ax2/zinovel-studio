/** Literal replacement preview with UTF-16 offsets and no regex execution. */
export function previewReplacement(body, query, replacement, options = {}) {
  if (
    typeof body !== "string" ||
    typeof query !== "string" ||
    !query.length ||
    query.length > 2000 ||
    typeof replacement !== "string" ||
    replacement.length > 20000
  )
    throw new Error("查找或替换内容无效");
  const { all = true, starts = [], offset = 0, limit = 50 } = options;
  if (
    !Array.isArray(starts) ||
    starts.some((start) => !Number.isSafeInteger(start) || start < 0) ||
    typeof all !== "boolean" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("替换选区无效");
  const chosen = new Set(starts);
  const matches = [];
  let cursor = 0,
    count = 0,
    selectedCount = 0,
    result = "";
  while (true) {
    const start = body.indexOf(query, cursor);
    if (start === -1) break;
    const selected = all ? !chosen.has(start) : chosen.has(start);
    if (count >= offset && matches.length < limit)
      matches.push({
        start,
        end: start + query.length,
        selected,
        excerpt: body.slice(Math.max(0, start - 20), start + query.length + 30),
      });
    count++;
    if (selected) selectedCount++;
    result += body.slice(cursor, start) + (selected ? replacement : query);
    if (result.length > 8 * 1024 * 1024)
      throw new Error("替换结果过大，请缩小范围");
    cursor = start + query.length;
  }
  result += body.slice(cursor);
  if (result.length > 8 * 1024 * 1024)
    throw new Error("替换结果过大，请缩小范围");
  return {
    matches,
    count,
    selectedCount,
    body: result,
    offset,
    truncated: count > matches.length,
  };
}
