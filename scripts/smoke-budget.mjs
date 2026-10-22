import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NovelHarness } from "../packages/novel-harness/runtime.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const report = { status: "running", checks: [] };
const input = {
  skillId: "novel-polish",
  instruction: "润色选区",
  context: "雨停后，他看见了旧信。",
  selectedText: "旧信",
};
async function scenario(budget, expected, omitUsage = false) {
  const model = await modelFixture({ omitUsage });
  const home = await mkdtemp(join(root, ".cache", "budget-qa-"));
  const runtime = new NovelHarness({
    root: home,
    resources: join(root, "dist/resources"),
  });
  try {
    const pending = runtime.generate(
      input,
      { baseURL: model.url, budget },
      "synthetic-budget-key",
    );
    if (expected.runtimeFailure)
      await assert.rejects(pending, /Harness 写作任务失败/);
    else if (expected.reason) await assert.rejects(pending, /预算停止/);
    else assert.equal((await pending).text, model.replacement);
    assert.equal(model.requests.length, expected.requests);
    for (const request of model.requests)
      assert.equal(request.max_tokens, budget.maxOutputTokens || 8192);
    const task = await runtime.task((await runtime.tasks())[0].id);
    assert.equal(task.record.usage.stopReason, expected.reason);
    assert.equal(task.record.usage.steps, expected.requests);
    assert.equal(task.record.usage.cost, null);
    if (!omitUsage) {
      assert.equal(
        task.record.usage.counts.inputTokens.value,
        expected.requests * 30,
      );
      assert.equal(
        task.record.usage.counts.outputTokens.value,
        expected.requests * 18,
      );
      assert.equal(task.record.usage.observedTokens, expected.requests * 48);
    } else assert.equal(task.record.usage.reportedAttempts, 0);
    if (expected.reason) {
      assert.equal(task.record.status, "failed");
      assert.equal(task.record.errorCode, "budget-limit");
      if (expected.requests === 2) {
        assert.equal(task.record.candidate, model.replacement);
        assert.equal(task.record.partialCandidate, true);
      }
    }
    report.checks.push({
      policy: budget,
      requests: model.requests.length,
      reason:
        expected.reason ||
        (expected.runtimeFailure
          ? "adapter-rejected-missing-usage"
          : "completed"),
      observedTokens: task.record.usage.observedTokens,
      unknownAttempts: task.record.usage.unknownAttempts,
    });
  } finally {
    await runtime.cancel();
    await model.close();
  }
}
try {
  await scenario(
    { maxSteps: 1, maxOutputTokens: 128 },
    { requests: 1, reason: "step-limit" },
  );
  await scenario({ maxSteps: 2 }, { requests: 2, reason: "step-limit" });
  await scenario(
    { maxReportedTokens: 40 },
    { requests: 1, reason: "reported-token-limit" },
  );
  await scenario(
    { maxReportedTokens: 1000 },
    { requests: 1, runtimeFailure: true },
    true,
  );
  await scenario({ maxSteps: 3 }, { requests: 3 });
  const model = await modelFixture();
  const home = await mkdtemp(join(root, ".cache", "budget-preflight-"));
  try {
    const runtime = new NovelHarness({
      root: home,
      resources: join(root, "dist/resources"),
    });
    await assert.rejects(
      runtime.generate(
        { ...input, context: "甲".repeat(101) },
        { baseURL: model.url, budget: { maxContextCharacters: 100 } },
        "synthetic-budget-key",
      ),
      /上下文字符预算/,
    );
    assert.equal(model.requests.length, 0);
    report.checks.push("context limit rejects before any provider request");
  } finally {
    await model.close();
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await mkdir(join(root, "assessments/stage-003"), { recursive: true });
  await writeFile(
    join(root, "assessments/stage-003/budget-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
