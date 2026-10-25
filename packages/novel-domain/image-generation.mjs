const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => names.includes(key));
export const imageGenerationLimits = Object.freeze({
  prompt: 8000,
  count: 4,
  imageBytes: 10 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
});

export function imageAdapterOptions(value) {
  if (value === undefined || value === null) return null;
  if (
    !exact(value, ["responseMode"]) ||
    !["default-base64", "request-base64"].includes(value.responseMode)
  )
    throw new Error("请明确选择受支持的内联base64图像响应模式");
  return { responseMode: value.responseMode };
}

export function imageGenerationRequest(input) {
  if (
    !exact(input, ["prompt", "n", "size", "responseMode"]) ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    !input.prompt.isWellFormed() ||
    input.prompt.length > imageGenerationLimits.prompt ||
    !Number.isInteger(input.n) ||
    input.n < 1 ||
    input.n > imageGenerationLimits.count ||
    !["1024x1024", "1024x1536", "1536x1024", "auto"].includes(input.size) ||
    !["default-base64", "request-base64"].includes(input.responseMode)
  )
    throw new Error("请明确填写图像提示词、数量、尺寸和兼容响应模式");
  return {
    prompt: input.prompt,
    n: input.n,
    size: input.size,
    responseMode: input.responseMode,
  };
}

export function imageGenerationBudget(input = {}) {
  if (!exact(input, ["maxImages", "maxCost", "pricing"]))
    throw new Error("图像预算格式不支持");
  const maxImages = input.maxImages ?? 1,
    maxCost = input.maxCost ?? 0;
  if (
    !Number.isInteger(maxImages) ||
    maxImages < 1 ||
    maxImages > 4 ||
    !Number.isFinite(maxCost) ||
    maxCost < 0 ||
    maxCost > 1000000
  )
    throw new Error("图像预算超出范围");
  let pricing = null;
  if (input.pricing !== undefined && input.pricing !== null) {
    if (
      !exact(input.pricing, ["currency", "perImage"]) ||
      !["CNY", "USD"].includes(input.pricing.currency) ||
      !Number.isFinite(input.pricing.perImage) ||
      input.pricing.perImage < 0 ||
      input.pricing.perImage > 1000000
    )
      throw new Error("图像预算单价无效");
    pricing = {
      currency: input.pricing.currency,
      perImage: input.pricing.perImage,
    };
  }
  if (maxCost > 0 && !pricing)
    throw new Error("图像费用阈值需要作者填写单价，未知价格不能当零费用");
  return { maxImages, maxCost, pricing };
}

function decimalAmount(value) {
  const [mantissa, scientificExponent = "0"] = String(value).split("e"),
    [whole, fraction = ""] = mantissa.split(".");
  return {
    coefficient: BigInt(whole + fraction),
    exponent: Number(scientificExponent) - fraction.length,
  };
}
function pricedImages(price, count, ceiling) {
  const unit = decimalAmount(price),
    limit = decimalAmount(ceiling),
    coefficient = unit.coefficient * BigInt(count),
    exponent = Math.min(unit.exponent, limit.exponent);
  return {
    value: Number(`${coefficient}e${unit.exponent}`),
    exceeds:
      coefficient * 10n ** BigInt(unit.exponent - exponent) >
      limit.coefficient * 10n ** BigInt(limit.exponent - exponent),
  };
}
export function imageGenerationPreflight(request, budget) {
  const checked = imageGenerationRequest(request),
    limits = imageGenerationBudget(budget);
  if (checked.n > limits.maxImages) throw new Error("图像数量超过本配置预算");
  const cost = limits.pricing
    ? pricedImages(limits.pricing.perImage, checked.n, limits.maxCost)
    : null;
  if (limits.maxCost > 0 && cost.exceeds)
    throw new Error("图像手填价格估算超过费用阈值，未发送请求");
  return {
    request: checked,
    budget: limits,
    estimatedCost: cost?.value ?? null,
    currency: limits.pricing?.currency ?? null,
  };
}
