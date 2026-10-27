import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { parseDocument, visit, isAlias } from "yaml";
import { modelServiceURL } from "./model-service.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function fail(code) {
  const error = new Error("模型配置无法安全解析，请检查来源格式或手工新建配置");
  error.code = code;
  throw error;
}
function text(value, limit = 200) {
  return typeof value === "string" &&
    value.trim() &&
    value.length <= limit &&
    value.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : undefined;
}
function secret(value) {
  return typeof value === "string" &&
    value.trim() &&
    value.length <= 16384 &&
    !/[\r\n\u0000]/.test(value)
    ? value.trim()
    : undefined;
}
function envName(value) {
  return typeof value === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
    ? value
    : undefined;
}
function credential(inline, environment, oauth = false) {
  const value = secret(inline),
    variable = envName(environment);
  return value
    ? { kind: "api-key", value }
    : variable
      ? { kind: "environment", variable }
      : { kind: oauth ? "login-session" : "none" };
}

/** Pure, host-only parsing. The public preview never contains credential values.
 * No environment lookup, filesystem access, plugin evaluation or model request.
 */
export function previewModelImport(source, bytes) {
  if (!["workbuddy", "codex", "dsh"].includes(source))
    fail("MODEL_IMPORT_SOURCE");
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 1024 * 1024
  )
    fail("MODEL_IMPORT_SIZE");
  let input, parsed;
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source === "workbuddy") parsed = JSON.parse(input);
    else if (source === "codex") parsed = parseToml(input);
    else {
      const doc = parseDocument(input, {
        schema: "core",
        uniqueKeys: true,
        merge: false,
      });
      if (doc.errors.length || doc.warnings.length) fail("MODEL_IMPORT_YAML");
      visit(doc, (_, node) => {
        if (isAlias(node) || node?.tag || node?.anchor)
          fail("MODEL_IMPORT_YAML");
      });
      parsed = doc.toJS({ maxAliasCount: 0 });
    }
  } catch {
    // Parser diagnostics can quote an inline credential. Never forward them.
    fail("MODEL_IMPORT_SYNTAX");
  }
  const entries = [],
    credentials = new Map();
  function add(value, origin) {
    if (entries.length >= 64) fail("MODEL_IMPORT_COUNT");
    const model = text(value.model),
      label = text(value.label, 80) || model;
    if (!model || !label) return;
    let baseURL;
    try {
      if (text(value.baseURL, 2048)) baseURL = modelServiceURL(value.baseURL);
    } catch {
      /* Invalid endpoint stays unresolved, never repaired or contacted. */
    }
    const protocol = [
      "anthropic-text",
      "openai-chat",
      "openai-responses",
    ].includes(value.protocol)
      ? value.protocol
      : null;
    const id = sha(
      JSON.stringify([source, origin, model, baseURL, protocol]),
    ).slice(0, 32);
    if (credentials.has(id)) return;
    const key = value.credential || credential();
    credentials.set(id, key);
    entries.push({
      id,
      source,
      origin,
      label,
      model,
      baseURL: baseURL || null,
      protocol,
      credential: {
        kind: key.kind,
        ...(key.variable ? { variable: key.variable } : {}),
      },
      supportsToolCall: value.supportsToolCall === true ? true : null,
      requiresReview: true,
      warnings: [
        ...(!baseURL ? ["服务地址缺失或无效，须手工确认"] : []),
        ...(!protocol ? ["来源未明确受支持的协议，须手工确认"] : []),
        ...(key.kind === "login-session" ? ["登录会话不能迁作 API Key"] : []),
        ...(key.kind === "environment" ? ["环境变量尚未读取"] : []),
      ],
    });
  }
  if (source === "workbuddy") {
    if (!Array.isArray(parsed) || parsed.length > 64)
      fail("MODEL_IMPORT_SHAPE");
    parsed.forEach((item, index) => {
      if (!object(item)) fail("MODEL_IMPORT_SHAPE");
      // A custom transport flag is not a protocol declaration.
      const protocol =
        item.useCustomProtocol === true
          ? null
          : item.vendor === "anthropic"
            ? "anthropic-text"
            : item.vendor === "openai"
              ? "openai-chat"
              : null;
      add(
        {
          label: item.name,
          model: item.id,
          baseURL: item.url,
          protocol,
          credential: credential(item.apiKey),
          supportsToolCall: item.supportsToolCall,
        },
        String(index),
      );
    });
  } else if (source === "codex") {
    if (!object(parsed)) fail("MODEL_IMPORT_SHAPE");
    const providerName = text(parsed.model_provider),
      provider =
        providerName &&
        object(parsed.model_providers) &&
        Object.hasOwn(parsed.model_providers, providerName)
          ? parsed.model_providers[providerName]
          : undefined;
    if (provider && !object(provider)) fail("MODEL_IMPORT_SHAPE");
    add(
      {
        label: provider?.name || "Codex 文字模型",
        model: parsed.model,
        baseURL: provider?.base_url,
        protocol:
          provider?.wire_api === "responses"
            ? "openai-responses"
            : provider?.wire_api === "chat"
              ? "openai-chat"
              : null,
        credential: credential(
          undefined,
          provider?.env_key,
          provider?.requires_openai_auth === true || !providerName,
        ),
      },
      providerName || "default",
    );
  } else {
    if (!Array.isArray(parsed) || parsed.length > 256)
      fail("MODEL_IMPORT_SHAPE");
    const plugins = [];
    function collect(nodes, depth = 0) {
      if (depth > 8) fail("MODEL_IMPORT_DEPTH");
      for (const node of nodes) {
        if (!object(node)) fail("MODEL_IMPORT_SHAPE");
        if (node.disabled === true) continue;
        if (Array.isArray(node.insert)) collect(node.insert, depth + 1);
        // Only the official static Messages adapter is recognized here.
        // No imported module, !!js expression or foreign plugin is executed.
        if (
          node.name === "@deepseek-ai/dsh-llm-deepseek-api-key" ||
          (node.id === "llm-deepseek" && node.name === undefined)
        )
          plugins.push(node);
      }
    }
    collect(parsed);
    for (const node of plugins) {
      const config = node.config;
      if (!object(config)) continue;
      const models = config.models;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (!object(model)) continue;
        add(
          {
            label: model.name || model.id,
            model: model.id,
            baseURL: config.baseURL,
            protocol: "anthropic-text",
            credential: credential(config.apiKey, config.apiKeyEnv),
          },
          String(node.id || "llm-deepseek"),
        );
      }
    }
  }
  return {
    preview: { source, sourceSha256: sha(bytes), candidates: entries },
    // Only the desktop host may retain this object. IPC returns preview alone.
    credentialFor(id) {
      const value = credentials.get(id);
      if (!value) fail("MODEL_IMPORT_CANDIDATE");
      return { ...value };
    },
    dispose() {
      credentials.clear();
    },
  };
}
