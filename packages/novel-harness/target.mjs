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

export function validateAcceptance(task, candidate, chapter) {
  const target = task.snapshot.target;
  if (
    task.record.status !== "awaiting-review" ||
    !target ||
    typeof candidate !== "string" ||
    candidate.length > 120000 ||
    !candidate.trim()
  )
    throw new Error("候选任务状态或内容无效");
  const accepted =
    target.body.slice(0, target.start) +
    candidate +
    target.body.slice(target.end);
  if (
    chapter.id !== target.chapterId ||
    chapter.deletedAt ||
    chapter.body !== accepted
  )
    throw new Error("正文尚未保存为本次候选，任务记录未更新");
  return {
    appliedHash: chapter.diskHash,
    acceptedText: candidate,
    reviewedAt: new Date().toISOString(),
  };
}
