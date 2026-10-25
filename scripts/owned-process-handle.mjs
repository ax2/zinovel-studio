/** QA-only termination. The opened handle pins the object; a reused PID is never a target. */
export async function terminateOriginalWithHandle(
  pid,
  identity,
  api,
  {
    timeoutMs = 30000,
    intervalMs = 25,
    now = Date.now,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof identity !== "string" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  )
    throw new Error("Invalid owned process termination request");
  let handle = api.open(pid),
    readOnly = false,
    openError = handle ? null : api.error();
  if (!handle && openError === 87) return { status: "absent" };
  if (!handle && api.openReadOnly) {
    handle = api.openReadOnly(pid);
    readOnly = true;
    const error = handle ? null : api.error();
    if (!handle && error === 87) return { status: "absent" };
  }
  if (!handle)
    throw new Error(`Cannot open owned process handle: ${openError}`);
  try {
    const created = api.creationDate(handle);
    if (!created) throw new Error("Cannot verify owned process creation time");
    if (JSON.stringify(created) !== identity)
      return { status: "different-identity" };
    let state = api.wait(handle);
    if (state === 0) return { status: "already-exited" };
    if (state !== 258)
      throw new Error(`Cannot observe owned process exit: ${api.error()}`);
    if (readOnly)
      throw new Error(`Cannot terminate owned process: ${openError}`);
    const terminated = api.terminate(handle),
      terminationError = terminated ? null : api.error(),
      deadline = now() + timeoutMs;
    for (;;) {
      state = api.wait(handle);
      if (state === 0)
        return {
          status: terminated ? "terminated" : "exited-during-termination",
        };
      if (state !== 258)
        throw new Error(`Cannot observe owned process exit: ${api.error()}`);
      if (now() >= deadline)
        throw new Error(
          `Original owned process did not exit: pid=${pid}, nativeError=${terminationError ?? 0}`,
        );
      await pause(intervalMs);
    }
  } finally {
    api.close(handle);
  }
}
