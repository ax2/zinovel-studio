export function modelServiceURL(input) {
  if (input !== undefined && (typeof input !== "string" || input.length > 2048))
    throw new Error("模型服务地址无效或过长");
  const url = new URL(input || "https://api.deepseek.com/anthropic");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("模型地址不能包含凭据、查询参数或片段");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    )
  )
    throw new Error("模型服务需使用 HTTPS；本机服务可以使用 HTTP");
  return url.href.replace(/\/+$/, "");
}

/** Endpoint scope includes origin and path, so different tenants on one gateway do not inherit keys. */
export function modelCredentialPlan(previousScope, nextService, input) {
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== "string" || input.apiKey.length > 16384)
  )
    throw new Error("API Key 格式无效或过长");
  if (input.clearKey !== undefined && typeof input.clearKey !== "boolean")
    throw new Error("清除密钥选项无效");
  const replace = typeof input.apiKey === "string" && !!input.apiKey.trim();
  if (replace && input.clearKey)
    throw new Error("请分别执行输入新密钥或清除密钥");
  const scope = modelServiceURL(nextService),
    changed = modelServiceURL(previousScope) !== scope;
  return {
    action: replace ? "replace" : input.clearKey || changed ? "clear" : "keep",
    credentialScope: scope,
  };
}

export function modelProfileReference(input) {
  if (input === undefined) return undefined;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["id", "label", "revision", "protocol"].includes(key),
    ) ||
    typeof input.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.id,
    ) ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 80 ||
    !input.label.isWellFormed() ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.protocol !== "anthropic-text"
  )
    throw new Error("文字模型配置引用无效");
  return {
    id: input.id,
    label: input.label,
    revision: input.revision,
    protocol: input.protocol,
  };
}
