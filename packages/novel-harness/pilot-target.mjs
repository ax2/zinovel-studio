export async function bindPilotInput(pilots, payload) {
  const pack = await pilots.taskSnapshot(payload.bookId, payload.expected);
  if (pack.hash !== payload.snapshotHash)
    throw new Error("试写或场景来源已改变，请刷新将发送的快照再生成");
  return {
    skillId: payload.skillId || "novel-pilot",
    instruction: payload.instruction,
    context: pack.context,
    selectedText: "",
    target: undefined,
    retryOf: undefined,
    materialTarget: undefined,
    materialContext: undefined,
    pilotTarget: pack.target,
  };
}
