import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePricing,
  priceUsage,
  estimateRequest,
  estimateCost,
} from "../packages/novel-harness/pricing.mjs";
import {
  TaskBudget,
  validateBudget,
} from "../packages/novel-harness/budget.mjs";
const pricing = {
  currency: "CNY",
  inputPerMillion: 2,
  outputPerMillion: 6,
  cacheReadPerMillion: 1,
  cacheWritePerMillion: 4,
};
test("configured price distinguishes missing usage from zero and prices disjoint fields only", () => {
  assert.equal(
    priceUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      pricing,
    ),
    0.00032,
  );
  assert.equal(
    priceUsage({ inputTokens: 100, outputTokens: 20 }, pricing),
    null,
  );
  assert.ok(
    Math.abs(
      priceUsage(
        {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          totalTokens: 135,
          reasoningTokens: 7,
        },
        pricing,
      ) - 0.00035,
    ) < 1e-12,
  );
  assert.equal(
    priceUsage(
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 130,
      },
      pricing,
    ),
    null,
  );
  assert.equal(
    priceUsage(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { ...pricing, inputPerMillion: null, outputPerMillion: null },
    ),
    0,
  );
  assert.throws(() => validatePricing({ ...pricing, outputPerMillion: -1 }));
  assert.throws(() => validateBudget({ maxCost: 1 }));
  const estimate = estimateRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "中文正文" }] }],
    system: "系统提示",
    tools: [
      {
        name: "novel_read",
        description: "读取授权选区",
        parameters: { type: "object" },
      },
    ],
    maxTokens: 100,
  });
  assert.ok(estimate.inputTokens > 10);
  assert.equal(estimate.scope, "assembled-messages-system-and-tools");
  assert.equal(
    estimateCost(estimate, pricing),
    (estimate.inputTokens * 4 + 100 * 6) / 1000000,
  );
});
test("unknown settled cost prevents the next dispatch instead of being counted as free", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-cost-"));
  const budget = new TaskBudget(join(root, "usage.json"), {
    pricing,
    maxCost: 1,
  });
  const agent = { session: { id: "root" } };
  let dispatched = 0;
  const next = async function* () {
    dispatched++;
    yield { type: "finish" };
  };
  const request = { sessionId: "root", messages: [], maxTokens: 128 };
  await budget.beforeRequest({ agent }, async () => ({}));
  budget.accept({ agent, frame: { type: "start", attemptId: "a" } });
  for await (const _ of budget.beforeStream(request, next)) {
  }
  budget.accept({
    agent,
    frame: {
      type: "chunk",
      attemptId: "a",
      chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } },
    },
  });
  await budget.beforeRequest({ agent }, async () => ({}));
  budget.accept({ agent, frame: { type: "start", attemptId: "b" } });
  await assert.rejects(async () => {
    for await (const _ of budget.beforeStream(request, next)) {
    }
  }, /预算不足/);
  assert.equal(dispatched, 1);
});
