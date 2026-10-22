import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskBudget,
  budgetSummary,
  validateBudget,
} from "../packages/novel-harness/budget.mjs";

test("usage updates replace counters and do not double-count total or reasoning; unknown stays unknown", () => {
  const summary = budgetSummary({
    schemaVersion: 1,
    policy: {},
    steps: 3,
    attempts: [
      {
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          totalTokens: 35,
          reasoningTokens: 7,
        },
      },
      { usage: { inputTokens: -1, outputTokens: 5 } },
    ],
  });
  assert.equal(summary.observedTokens, 35);
  assert.equal(summary.unknownAttempts, 2);
  assert.equal(summary.counts.cacheWriteTokens.reported, 0);
  assert.equal(summary.cost, null);
  assert.equal(
    budgetSummary({
      schemaVersion: 1,
      steps: 0,
      attempts: [],
      policy: {},
      estimates: [null],
    }),
    undefined,
  );
  assert.equal(
    budgetSummary({
      schemaVersion: 1,
      steps: 0,
      attempts: [],
      policy: { maxSteps: -1 },
    }),
    undefined,
  );
  for (const value of [-1, NaN, 1.5, Infinity, 1000001])
    assert.throws(() => validateBudget({ maxReportedTokens: value }));
  assert.throws(() => validateBudget({ maxSteps: 0 }));
});
test("step and usage limits persist their stop reason before denying another call", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-budget-"));
  const agent = { session: { id: "root" } };
  const budget = new TaskBudget(join(root, "usage.json"), {
    maxSteps: 3,
    maxReportedTokens: 40,
    maxOutputTokens: 128,
  });
  assert.equal(
    (await budget.beforeRequest({ agent }, async () => ({ maxTokens: 8192 })))
      .maxTokens,
    128,
  );
  budget.accept({ agent, frame: { type: "start", attemptId: "one" } });
  for (const outputTokens of [10, 20])
    budget.accept({
      agent,
      frame: {
        type: "chunk",
        attemptId: "one",
        chunk: { type: "usage", usage: { inputTokens: 30, outputTokens } },
      },
    });
  await assert.rejects(
    budget.beforeRequest({ agent }, () => assert.fail("must not call next")),
    /预算/,
  );
  const saved = JSON.parse(await readFile(join(root, "usage.json"), "utf8"));
  assert.equal(saved.stopReason, "reported-token-limit");
  assert.equal(budgetSummary(saved).observedTokens, 50);
  const unknown = new TaskBudget(join(root, "unknown.json"), {
    maxReportedTokens: 1000,
  });
  await unknown.beforeRequest({ agent }, async () => ({}));
  await assert.rejects(
    unknown.beforeRequest({ agent }, () => assert.fail()),
    /预算/,
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "unknown.json"), "utf8")).stopReason,
    "usage-unknown",
  );
});
