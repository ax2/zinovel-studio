/** Keyboard selection for a read-only preview whose native control has no caret navigation. */
export function moveReadonlyCaret(
  text,
  { start, end, direction, key, shift = false, control = false },
) {
  const backward = direction === "backward",
    focus = backward ? start : end;
  const anchor = backward ? end : start;
  let target;
  const lineStart = focus === 0 ? 0 : text.lastIndexOf("\n", focus - 1) + 1;
  const lineEnd = text.indexOf("\n", focus);
  if (key === "Home") target = control ? 0 : lineStart;
  else if (key === "End")
    target = control ? text.length : lineEnd < 0 ? text.length : lineEnd;
  else if (control) return null;
  else if (key === "ArrowLeft") {
    target = !shift && start !== end ? start : Math.max(0, focus - 1);
    if (
      target > 0 &&
      /[\uDC00-\uDFFF]/.test(text[target]) &&
      /[\uD800-\uDBFF]/.test(text[target - 1])
    )
      target--;
  } else if (key === "ArrowRight") {
    target =
      !shift && start !== end
        ? end
        : Math.min(
            text.length,
            focus + (text.codePointAt(focus) > 0xffff ? 2 : 1),
          );
  } else if (key === "ArrowUp") {
    const previousEnd = lineStart - 1;
    target =
      previousEnd < 0
        ? 0
        : Math.min(
            previousEnd,
            text.lastIndexOf("\n", previousEnd - 1) + 1 + focus - lineStart,
          );
  } else if (key === "ArrowDown") {
    const nextStart = lineEnd < 0 ? text.length : lineEnd + 1,
      nextEnd = text.indexOf("\n", nextStart);
    target = Math.min(
      nextEnd < 0 ? text.length : nextEnd,
      nextStart + focus - lineStart,
    );
  } else return null;
  if (
    target > 0 &&
    /[\uDC00-\uDFFF]/.test(text[target]) &&
    /[\uD800-\uDBFF]/.test(text[target - 1])
  )
    target--;
  return shift
    ? {
        start: Math.min(anchor, target),
        end: Math.max(anchor, target),
        direction: target < anchor ? "backward" : "forward",
        focus: target,
      }
    : { start: target, end: target, direction: "none", focus: target };
}
