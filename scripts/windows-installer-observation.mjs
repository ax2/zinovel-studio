/** Permission-denied during delete-pending is inconclusive, never evidence of absence. */
export async function waitForCondition(
  check,
  message,
  timeout = 30000,
  interval = 200,
) {
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    !Number.isFinite(interval) ||
    interval < 0
  )
    throw new Error("Invalid observation budget");
  const started = Date.now(),
    until = started + timeout;
  let attempts = 0,
    permissionRetries = 0,
    lastPermissionError;
  const codes = new Set();
  do {
    attempts++;
    try {
      if (await check())
        return {
          attempts,
          permissionRetries,
          permissionErrorCodes: [...codes],
          elapsedMs: Date.now() - started,
        };
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      permissionRetries++;
      codes.add(error.code);
      lastPermissionError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  } while (Date.now() < until);
  const error = new Error(message, { cause: lastPermissionError });
  error.code = "OBSERVATION_TIMEOUT";
  error.observation = {
    attempts,
    permissionRetries,
    permissionErrorCodes: [...codes],
    elapsedMs: Date.now() - started,
  };
  throw error;
}
