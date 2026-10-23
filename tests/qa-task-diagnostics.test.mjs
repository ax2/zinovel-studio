import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  captureTaskDiagnostics,
  taskReviewTimeoutMs,
} from "../scripts/qa-task-diagnostics.mjs";
import { HARNESS_TASK_TIMEOUT_MS } from "../packages/novel-harness/timeouts.mjs";

test("failure diagnostics preserve task outcomes while excluding prompts, keys, unknown error text and malformed source content", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-qa-diagnostics-"));
  assert.deepEqual(await captureTaskDiagnostics(root), []);
  const one = randomUUID(),
    two = randomUUID(),
    bad = randomUUID();
  const secret = "SYNTHETIC_PRIVATE_TOKEN_AND_PROSE";
  for (const id of [one, two, bad])
    await mkdir(join(root, "tasks", id), { recursive: true });
  const original = JSON.stringify({
    status: "running",
    kind: "material",
    startedAt: "2026-10-24T00:00:00.000Z",
    prompt: secret,
    apiKey: secret,
    error: secret,
  });
  await writeFile(join(root, "tasks", one, "task.json"), original);
  await writeFile(
    join(root, "tasks", two, "task.json"),
    JSON.stringify({
      status: "failed",
      kind: "writing",
      errorCode: secret,
      startedAt: secret,
      completedAt: "2026-10-24T00:01:00.000Z",
      candidate: secret,
    }),
  );
  await writeFile(join(root, "tasks", bad, "task.json"), '{"token":"' + secret);
  const result = await captureTaskDiagnostics(root);
  assert.equal(result.length, 3);
  assert.equal(result.find((item) => item.id === one).status, "running");
  assert.equal(result.find((item) => item.id === two).errorCode, "other");
  assert.equal(result.find((item) => item.id === bad).status, "unreadable");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    await readFile(join(root, "tasks", one, "task.json"), "utf8"),
    original,
  );
  assert.ok(taskReviewTimeoutMs > HARNESS_TASK_TIMEOUT_MS);
});
