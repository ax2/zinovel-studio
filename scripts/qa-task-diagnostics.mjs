import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_TASK_TIMEOUT_MS } from "../packages/novel-harness/timeouts.mjs";

// Observe the product's existing task budget, then allow its final UI/receipt to settle.
export const taskReviewTimeoutMs = HARNESS_TASK_TIMEOUT_MS + 30000;
const statuses = new Set([
  "queued",
  "running",
  "awaiting-review",
  "applied",
  "cancelled",
  "interrupted",
  "failed",
  "discarded",
]);
const errorCodes = new Set([
  "runtime-failed",
  "budget-limit",
  "cancelled-or-timeout",
]);
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    ? value
    : undefined;

/** Metadata only: never serialize prompts, credentials, candidates or raw parsing errors. */
export async function captureTaskDiagnostics(dataRoot) {
  const directory = join(dataRoot, "tasks");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return error.code === "ENOENT"
      ? []
      : [{ status: "unreadable", errorCode: "task-directory-unreadable" }];
  }
  const result = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.name)
    )
      continue;
    try {
      const task = JSON.parse(
        await readFile(join(directory, entry.name, "task.json"), "utf8"),
      );
      result.push({
        id: entry.name,
        status: statuses.has(task.status) ? task.status : "unsupported",
        kind: ["writing", "material", "pilot"].includes(task.kind)
          ? task.kind
          : "other",
        errorCode: task.errorCode
          ? errorCodes.has(task.errorCode)
            ? task.errorCode
            : "other"
          : undefined,
        startedAt: time(task.startedAt),
        completedAt: time(task.completedAt),
      });
    } catch {
      result.push({ id: entry.name, status: "unreadable" });
    }
  }
  return result;
}
