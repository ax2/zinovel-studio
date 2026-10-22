import { NovelHarness } from "../packages/novel-harness/runtime.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const home = await mkdtemp(join(root, ".cache", "novel-agent-qa-"));
let releasePartial;
const partialGate = new Promise((resolve) => {
  releasePartial = resolve;
});
const model = await modelFixture({
  delayMs: 250,
  beforeReply: (index) => (index === 7 ? partialGate : undefined),
});
const runtime = new NovelHarness({
  root: home,
  resources: join(root, "dist/resources"),
});
const report = {
  runtime: "official DSH SDK + agent-loop + custom Cordis tools",
  model: "local deterministic SSE fixture",
  checks: [],
};
try {
  const input = {
    skillId: "novel-polish",
    instruction: "润色选区",
    context: "林舟收到一封旧信。",
    selectedText: "一封旧信",
  };
  const settings = { baseURL: model.url, model: "deepseek-v4-flash" };
  const pending = runtime.generate(input, settings, "fixture-local-only");
  await assert.rejects(
    runtime.generate(input, settings, "fixture-local-only"),
    /已有写作任务/,
  );
  const result = await pending;
  assert.equal(result.text, model.replacement);
  assert.equal(model.requests.length, 3);
  for (const request of model.requests)
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      "novel_change_propose",
      "novel_selection_read",
    ]);
  assert.ok(
    model.requests[1].messages.some((message) =>
      JSON.stringify(message).includes("林舟收到"),
    ),
  );
  report.checks.push(
    "official runtime performed selection read and proposal tool round trip",
    "exactly two novel tools visible, no terminal or filesystem tools",
    "candidate comes from proposal tool, never written to manuscript",
    "simultaneous generation is rejected before asynchronous preparation",
  );
  const saved = await runtime.task(result.id);
  assert.equal(saved.record.status, "awaiting-review");
  assert.equal(saved.record.candidate, result.text);
  assert.equal(saved.snapshot.instruction, input.instruction);
  assert.equal(saved.snapshot.context, input.context);
  assert.equal((await runtime.tasks())[0].hasCandidate, true);
  assert.equal("candidate" in (await runtime.tasks())[0], false);
  const reopened = new NovelHarness({
    root: home,
    resources: join(root, "dist/resources"),
  });
  assert.deepEqual(await reopened.task(result.id), saved);
  assert.equal(model.requests.length, 3);
  report.checks.push(
    "completed candidate and frozen input survive runtime restart without provider replay",
  );
  const cancelledPreparation = runtime.generate(
    input,
    settings,
    "fixture-local-only",
  );
  const preparationRejected = assert.rejects(cancelledPreparation, /取消/);
  await runtime.cancel();
  await preparationRejected;
  assert.equal(model.requests.length, 3);
  report.checks.push(
    "cancelling during preparation starts no model request and releases the task slot",
  );
  const next = runtime.generate(
    {
      skillId: "novel-expand",
      instruction: "扩写选区",
      context: "林舟收到一封旧信。",
      selectedText: "旧信",
    },
    { baseURL: model.url, model: "deepseek-v4-flash" },
    "fixture-local-only",
  );
  const rejected = assert.rejects(next, /取消/);
  const deadline = Date.now() + 60000;
  while (model.requests.length < 4) {
    assert.ok(
      Date.now() < deadline,
      "Harness did not reach model fixture before deadline",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runtime.cancel();
  await rejected;
  const cancelled = (await runtime.tasks()).find(
    (task) => task.status === "cancelled",
  );
  assert.ok(cancelled);
  assert.equal(cancelled.errorCode, "cancelled-or-timeout");
  assert.equal("candidate" in cancelled, false);
  report.checks.push(
    "cancelling an in-flight real Harness task settles and closes the runtime",
  );
  const target = {
    bookId: randomUUID(),
    chapterId: randomUUID(),
    body: input.context,
    start: 6,
    end: 8,
  };
  const partialTask = runtime.generate(
    { ...input, selectedText: "旧信", target },
    settings,
    "fixture-local-only",
  );
  const partialRejected = assert.rejects(partialTask, /取消/);
  const partialDeadline = Date.now() + 60000;
  while (model.requests.length < 7) {
    assert.ok(
      Date.now() < partialDeadline,
      "proposal tool did not complete before cancel checkpoint",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runtime.cancel();
  await partialRejected;
  releasePartial();
  const partialRecord = (await runtime.tasks(target.bookId))[0];
  const partialSaved = await runtime.task(partialRecord.id);
  assert.equal(partialSaved.record.status, "cancelled");
  assert.equal(partialSaved.record.candidate, model.replacement);
  assert.equal(partialSaved.record.partialCandidate, true);
  await assert.rejects(
    runtime.generate(
      {
        ...input,
        target: { ...target, chapterId: randomUUID() },
        retryOf: partialRecord.id,
      },
      settings,
      "fixture-local-only",
    ),
    /同一章节/,
  );
  assert.equal(model.requests.length, 7);
  const fresh = { ...target, body: target.body + "作者增加了新的背景。" };
  const retry = await runtime.generate(
    {
      ...input,
      context: fresh.body,
      selectedText: "旧信",
      target: fresh,
      retryOf: partialRecord.id,
    },
    settings,
    "fixture-local-only",
  );
  assert.notEqual(retry.id, partialRecord.id);
  const retried = await runtime.task(retry.id);
  assert.equal(retried.record.retryOf, partialRecord.id);
  assert.equal(retried.snapshot.context, fresh.body);
  assert.equal(
    (await runtime.task(partialRecord.id)).record.status,
    "cancelled",
  );
  assert.equal(model.requests.length, 10);
  report.checks.push(
    "cancellation after proposal persistence retains a view-only partial result",
    "retry uses a new task with the current frozen input, retains original task and refuses a different chapter before any provider request",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.cause || error);
  throw error;
} finally {
  releasePartial();
  await runtime.cancel();
  await model.close();
  await mkdir(join(root, "assessments/stage-001"), { recursive: true });
  await writeFile(
    join(root, "assessments/stage-001/novel-agent-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
