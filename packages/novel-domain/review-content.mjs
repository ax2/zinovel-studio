/** Select persisted review text by acceptance identity, never wall-clock ordering. */
export function reviewContent(task) {
  const intent = task.record.acceptance;
  if (task.record.acceptanceRecovery === "original-text-retained" && intent) {
    if (
      typeof intent.id === "string" &&
      task.reviewDraft?.afterAcceptanceId === intent.id
    )
      return { text: task.reviewDraft.text, source: "saved-review" };
    return {
      text: intent.acceptedText ?? task.record.candidate ?? "",
      source: "recovered-acceptance",
    };
  }
  return task.reviewDraft
    ? { text: task.reviewDraft.text, source: "saved-review" }
    : { text: task.record.candidate ?? "", source: "model-candidate" };
}
