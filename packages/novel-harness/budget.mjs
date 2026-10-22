import { atomicWriteText } from "../novel-storage/atomic.mjs";

export function validateBudget(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("任务预算格式无效");
  const result = {};
  for (const [key, fallback, min, max] of [
    ["maxSteps", 12, 1, 64],
    ["maxContextCharacters", 120000, 100, 120000],
    ["maxOutputTokens", 8192, 64, 32768],
    ["maxReportedTokens", 0, 0, 1000000],
  ]) {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error("任务预算超出允许范围");
    result[key] = value;
  }
  return result;
}
const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
];
export function reportedUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  if (
    ![value.inputTokens, value.outputTokens].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    return undefined;
  const result = {};
  for (const key of fields) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return undefined;
    result[key] = value[key];
  }
  return result;
}
export function budgetSummary(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 256 ||
    !Number.isSafeInteger(value.steps) ||
    value.steps < 0
  )
    return undefined;
  let policy;
  try {
    if (!value.policy || typeof value.policy !== "object") return undefined;
    policy = validateBudget(value.policy);
  } catch {
    return undefined;
  }
  const counts = Object.fromEntries(
    fields.map((key) => [key, { value: 0, reported: 0 }]),
  );
  let reportedAttempts = 0;
  for (const attempt of value.attempts) {
    const usage = reportedUsage(attempt.usage);
    if (!usage) continue;
    reportedAttempts++;
    for (const key of fields)
      if (usage[key] !== undefined) {
        counts[key].value += usage[key];
        counts[key].reported++;
      }
  }
  const observedTokens =
    counts.inputTokens.value +
    counts.outputTokens.value +
    counts.cacheReadTokens.value +
    counts.cacheWriteTokens.value;
  // Reasoning is an output breakdown, and total is an alternative aggregate:
  // adding either would double-count provider-reported tokens.
  return {
    steps: value.steps,
    attempts: value.attempts.length,
    reportedAttempts,
    unknownAttempts:
      value.attempts.length -
      reportedAttempts +
      Math.max(0, value.steps - value.attempts.length),
    counts,
    observedTokens,
    policy,
    stopReason: value.stopReason,
    cost: null,
    costReason: "pricing-not-configured",
    scope: "provider-reported-fields",
  };
}

/** Enforces limits before admitting the next official agent step. */
export class TaskBudget {
  #data;
  #attempts = new Map();
  #sessionId;
  #pending = Promise.resolve();
  #error;
  constructor(path, policy) {
    this.path = path;
    this.#data = {
      schemaVersion: 1,
      policy: validateBudget(policy),
      steps: 0,
      attempts: [],
    };
  }
  async beforeRequest({ agent }, next) {
    this.#sessionId ??= agent.session.id;
    if (agent.session.id !== this.#sessionId)
      throw new Error("任务不允许其他会话消耗预算");
    const summary = budgetSummary(this.#data),
      policy = this.#data.policy;
    let reason = this.#data.stopReason;
    if (this.#data.steps >= policy.maxSteps) reason = "step-limit";
    else if (policy.maxReportedTokens > 0 && summary.unknownAttempts > 0)
      reason = "usage-unknown";
    else if (
      policy.maxReportedTokens > 0 &&
      summary.observedTokens >= policy.maxReportedTokens
    )
      reason = "reported-token-limit";
    if (reason) {
      this.#data.stopReason = reason;
      await this.flush();
      throw new Error("写作任务已达到预算，未启动下一模型步骤");
    }
    this.#data.steps++;
    await this.flush();
    const config = await next();
    return {
      ...config,
      maxTokens: Math.min(
        config.maxTokens ?? policy.maxOutputTokens,
        policy.maxOutputTokens,
      ),
    };
  }
  accept({ agent, frame }) {
    if (
      agent?.session?.id !== this.#sessionId ||
      typeof frame?.attemptId !== "string"
    )
      return;
    if (frame.type === "start") {
      if (this.#attempts.has(frame.attemptId)) return;
      if (this.#attempts.size >= 256) {
        this.#data.stopReason = "attempt-record-limit";
        return;
      }
      const attempt = { id: frame.attemptId };
      this.#attempts.set(frame.attemptId, attempt);
      this.#data.attempts.push(attempt);
    }
    const attempt = this.#attempts.get(frame.attemptId);
    if (!attempt) return;
    if (frame.type === "chunk" && frame.chunk?.type === "usage") {
      const usage = reportedUsage(frame.chunk.usage);
      // Updates of one attempt replace its counters, never add the same call twice.
      if (usage) attempt.usage = usage;
      this.flush().catch(() => {});
    }
    if (frame.type === "end") {
      attempt.ended = true;
      this.flush().catch(() => {});
    }
  }
  async flush() {
    this.#pending = this.#pending
      .then(() => atomicWriteText(this.path, JSON.stringify(this.#data) + "\n"))
      .catch((error) => {
        this.#error = error;
      });
    await this.#pending;
    if (this.#error)
      throw new Error("任务用量记录失败，已停止继续调用", {
        cause: this.#error,
      });
  }
}
