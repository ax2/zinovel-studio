function changeSpan(base, value) {
  let from = 0,
    to = base.length,
    end = value.length;
  while (from < to && from < end && base[from] === value[from]) from++;
  while (to > from && end > from && base[to - 1] === value[end - 1]) {
    to--;
    end--;
  }
  // A changed low surrogate must carry its paired high surrogate in the same edit.
  if (from > 0 && /[\uD800-\uDBFF]/.test(base[from - 1])) from--;
  if (to < base.length && /[\uDC00-\uDFFF]/.test(base[to])) {
    to++;
    end++;
  }
  return { from, to, insert: value.slice(from, end) };
}

/** Conservative three-way merge. Multiple edits collapse to one span per side.
 * Disjoint spans are safe; overlap stays for explicit human review, never conflict markers in prose.
 */
export function mergeThreeWay(base, local, remote) {
  if (local === remote)
    return { body: local, automatic: true, reason: "两侧正文一致" };
  if (typeof base !== "string")
    return {
      body: local,
      automatic: false,
      reason: "共同基线缺失，请手动核对两侧",
    };
  if (local === base)
    return { body: remote, automatic: true, reason: "仅磁盘稿有修改" };
  if (remote === base)
    return { body: local, automatic: true, reason: "仅当前稿有修改" };
  const a = changeSpan(base, local),
    b = changeSpan(base, remote);
  const adjacentNonempty =
    (a.to === b.from || b.to === a.from) && a.to > a.from && b.to > b.from;
  if (!(a.to < b.from || b.to < a.from || adjacentNonempty))
    return {
      body: local,
      automatic: false,
      reason: "双方修改范围相交，请在合并稿中决定保留内容",
    };
  let result = base;
  for (const edit of [a, b].sort((left, right) => right.from - left.from))
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return {
    body: result,
    automatic: true,
    reason: "双方修改范围分离，已组合为待确认的合并稿",
  };
}
