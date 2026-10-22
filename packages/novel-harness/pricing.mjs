import {
  estimateMessage,
  estimateToolsTokens,
} from "@deepseek-ai/dsh-token-meter/estimate";

const priceFields = [
  "inputPerMillion",
  "outputPerMillion",
  "cacheReadPerMillion",
  "cacheWritePerMillion",
];
export function validatePricing(value) {
  if (value === undefined || value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    !["CNY", "USD"].includes(value.currency)
  )
    throw new Error("价格币种或格式无效");
  const result = { currency: value.currency };
  for (const key of priceFields) {
    const rate = value[key] ?? null;
    if (
      rate !== null &&
      (typeof rate !== "number" ||
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > 1000000)
    )
      throw new Error("Token 单价无效");
    result[key] = rate;
  }
  return result;
}
export function estimateRequest(options) {
  let inputTokens = 0;
  for (const message of options.messages || [])
    inputTokens += estimateMessage(message);
  if (options.system)
    inputTokens += estimateMessage({
      role: "system",
      content: [{ type: "text", text: options.system }],
    });
  inputTokens += estimateToolsTokens({ tools: options.tools });
  return {
    inputTokens,
    outputTokenCap: options.maxTokens || 0,
    method: "dsh-token-meter-0.2.1-rc.2-heuristic",
    scope: "assembled-messages-system-and-tools",
  };
}
export function estimateCost(estimate, pricing) {
  if (!pricing || priceFields.some((key) => pricing[key] === null)) return null;
  // Cache outcome is unknown before dispatch. Reserve at the largest input rate.
  const inputRate = Math.max(
    pricing.inputPerMillion,
    pricing.cacheReadPerMillion,
    pricing.cacheWritePerMillion,
  );
  return (
    (estimate.inputTokens * inputRate +
      estimate.outputTokenCap * pricing.outputPerMillion) /
    1000000
  );
}
export function priceUsage(usage, pricing) {
  if (!pricing || !usage) return null;
  const counts = { ...usage };
  const knownTotal = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  if (
    !Number.isSafeInteger(knownTotal) ||
    (counts.totalTokens !== undefined && counts.totalTokens !== knownTotal)
  )
    return null;
  if (
    Number.isSafeInteger(counts.totalTokens) &&
    counts.totalTokens === knownTotal
  ) {
    counts.cacheReadTokens ??= 0;
    counts.cacheWriteTokens ??= 0;
  }
  let cost = 0;
  for (const [field, price] of [
    ["inputTokens", "inputPerMillion"],
    ["outputTokens", "outputPerMillion"],
    ["cacheReadTokens", "cacheReadPerMillion"],
    ["cacheWriteTokens", "cacheWritePerMillion"],
  ]) {
    if (
      counts[field] === undefined ||
      (counts[field] !== 0 && pricing[price] === null)
    )
      return null;
    cost += (counts[field] * (pricing[price] ?? 0)) / 1000000;
  }
  return cost;
}
