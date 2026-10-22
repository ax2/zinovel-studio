/** Bind only the editor's frozen range to an existing, current manuscript. */
export function bindWritingTarget(target, context, selectedText, chapter) {
  if (
    !target ||
    typeof target.body !== "string" ||
    target.body !== context ||
    !Number.isInteger(target.start) ||
    !Number.isInteger(target.end) ||
    target.start < 0 ||
    target.end < target.start ||
    target.end > target.body.length ||
    selectedText !== target.body.slice(target.start, target.end) ||
    target.chapterId !== chapter.id ||
    chapter.deletedAt
  )
    throw new Error("任务选区或章节无效，请重新选择正文");
  // An automatic save may have just completed: identical bytes are a valid
  // refreshed baseline. A different on-disk body needs the exact prior hash.
  if (target.baseHash !== chapter.diskHash && target.body !== chapter.body)
    throw new Error("章节已在外部改变，请重新读取后生成候选");
  return {
    bookId: target.bookId,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    body: target.body,
    start: target.start,
    end: target.end,
    baseHash: chapter.diskHash,
  };
}
