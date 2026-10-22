/** Text anchors use UTF-16 offsets, an exact quote and local context. Never guess an ambiguous location. */
export function createAnchor(body, start, end, hash) {
  if (
    typeof body !== "string" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > body.length ||
    end - start > 60000
  )
    throw new Error("请选择有效的正文范围（最多 6 万字符）");
  for (const offset of [start, end]) {
    if (
      offset > 0 &&
      offset < body.length &&
      /[\uD800-\uDBFF]/.test(body[offset - 1]) &&
      /[\uDC00-\uDFFF]/.test(body[offset])
    )
      throw new Error("定位不能拆开 Unicode 字符");
  }
  return {
    start,
    end,
    hash,
    quote: body.slice(start, end),
    prefix: body.slice(Math.max(0, start - 40), start),
    suffix: body.slice(end, end + 40),
  };
}

export function resolveAnchor(body, anchor, hash) {
  if (
    hash &&
    anchor.hash === hash &&
    body.slice(anchor.start, anchor.end) === anchor.quote
  )
    return { status: "exact", start: anchor.start, end: anchor.end };
  const needle = anchor.quote || anchor.prefix + anchor.suffix;
  if (!needle) return { status: "missing", start: null, end: null };
  const candidates = [],
    contextual = [];
  let position = body.indexOf(needle);
  while (position !== -1) {
    const start = position + (anchor.quote ? 0 : anchor.prefix.length),
      end = start + anchor.quote.length;
    candidates.push({ start, end });
    if (
      body.slice(Math.max(0, start - anchor.prefix.length), start) ===
        anchor.prefix &&
      body.slice(end, end + anchor.suffix.length) === anchor.suffix
    )
      contextual.push({ start, end });
    if (candidates.length > 1000)
      return { status: "ambiguous", start: null, end: null };
    position = body.indexOf(needle, position + 1);
  }
  const match =
    contextual.length === 1
      ? contextual[0]
      : candidates.length === 1
        ? candidates[0]
        : null;
  return match
    ? { status: "relocated", ...match }
    : {
        status: candidates.length ? "ambiguous" : "missing",
        start: null,
        end: null,
      };
}
