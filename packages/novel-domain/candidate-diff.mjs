const MAX_CELLS = 250000;
const MAX_BLOCKS = 120;

function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/** Exact line-preserving review; bounded alignment falls back to one explicit block. */
export function candidateDiff(original, candidate) {
  if (typeof original !== "string" || typeof candidate !== "string")
    throw new TypeError("Review requires two text values");
  const before = lines(original),
    after = lines(candidate);
  let prefix = 0,
    suffix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix),
    b = after.slice(prefix, after.length - suffix);
  const head = before.slice(0, prefix).join(""),
    tail = suffix ? before.slice(-suffix).join("") : "";
  const coarse = () => ({
    coarse: true,
    segments: [
      ...(head ? [{ kind: "equal", before: head, after: head }] : []),
      { kind: "change", id: 0, before: a.join(""), after: b.join("") },
      ...(tail ? [{ kind: "equal", before: tail, after: tail }] : []),
    ],
  });
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return coarse();
  const width = b.length + 1,
    cells = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      cells[i * width + j] =
        a[i] === b[j]
          ? 1 + cells[(i + 1) * width + j + 1]
          : Math.max(cells[(i + 1) * width + j], cells[i * width + j + 1]);
  const segments = [];
  let changes = 0;
  function append(kind, oldText, newText) {
    if (!oldText && !newText) return;
    const last = segments.at(-1);
    if (last?.kind === kind) {
      last.before += oldText;
      last.after += newText;
    } else
      segments.push({
        kind,
        ...(kind === "change" ? { id: changes++ } : {}),
        before: oldText,
        after: newText,
      });
  }
  append("equal", head, head);
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      append("equal", a[i], b[j]);
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || cells[(i + 1) * width + j] >= cells[i * width + j + 1])
    )
      append("change", a[i++], "");
    else append("change", "", b[j++]);
    if (changes > MAX_BLOCKS) return coarse();
  }
  append("equal", tail, tail);
  return { coarse: false, segments };
}

/** Rejected blocks retain the exact original bytes represented by their JS string. */
export function composeCandidate(diff, rejected = new Set()) {
  return diff.segments
    .map((part) =>
      part.kind === "change" && rejected.has(part.id)
        ? part.before
        : part.after,
    )
    .join("");
}
