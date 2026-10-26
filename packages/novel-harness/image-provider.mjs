import { modelServiceURL } from "../novel-domain/model-service.mjs";
import {
  imageGenerationLimits,
  imageGenerationPreflight,
} from "../novel-domain/image-generation.mjs";
import {
  inspectAssetImage,
  copyImageBytes,
  binaryHash,
} from "../novel-storage/image-decoder.mjs";
import {
  imageEditProtocol,
  imageTaskReference,
} from "../novel-domain/image-reference.mjs";

const messages = Object.freeze({
  INPUT: "图像服务配置、凭据或请求无效，未发送请求",
  INTENT: "未能保存图像发送意图，未发送请求",
  CANCELLED: "本地图像等待已取消；已发送时远端结果可能未知，请勿自动重试",
  TIMEOUT: "图像服务等待超时；远端可能仍在处理，请勿自动重试",
  NETWORK: "图像网络请求未完成；远端结果可能未知，请勿自动重试",
  HTTP: "图像服务拒绝请求；请核对配置，不会自动重试",
  RESPONSE: "图像服务响应格式不支持，未获取可采用图像",
  LIMIT: "图像服务响应超过数量或字节上限，未采用任何图像",
  IMAGE: "图像候选无法完整解码或格式不支持，未采用任何图像",
});
export class ImageProviderError extends Error {
  constructor(
    code,
    dispatched,
    remoteResult = dispatched ? "unknown" : "not-sent",
  ) {
    super(messages[code]);
    this.name = "ImageProviderError";
    this.code = code;
    this.dispatched = dispatched;
    this.remoteResult = remoteResult;
  }
}
const fail = (code, dispatched, remoteResult) => {
  throw new ImageProviderError(code, dispatched, remoteResult);
};
const stopBody = async (response) => {
  try {
    await response.body?.cancel();
  } catch {}
};

async function boundedJSON(response) {
  if (
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    await stopBody(response);
    fail("RESPONSE", true, "received-invalid");
  }
  const length = response.headers.get("content-length");
  if (length && Number(length) > imageGenerationLimits.responseBytes) {
    await stopBody(response);
    fail("LIMIT", true);
  }
  if (!response.body) fail("RESPONSE", true, "received-invalid");
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > imageGenerationLimits.responseBytes) fail("LIMIT", true);
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      ),
    );
  } catch {
    fail("RESPONSE", true, "received-invalid");
  }
}

function decodedImage(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 ||
    value.length > Math.ceil(imageGenerationLimits.imageBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    fail("IMAGE", true, "received-invalid");
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.length > imageGenerationLimits.imageBytes ||
    bytes.toString("base64") !== value
  )
    fail("IMAGE", true, "received-invalid");
  return bytes;
}
function usage(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of ["input_tokens", "output_tokens", "total_tokens"])
    if (
      Number.isSafeInteger(value[field]) &&
      value[field] >= 0 &&
      value[field] <= 1000000000
    )
      result[field] = value[field];
  return Object.keys(result).length ? result : null;
}

/** Transport only: no profile resolution, book access, adoption, retry or renderer IPC.
 * The host task service persists the send intent in beforeDispatch.
 * A successful late response is retained even if cancellation arrives during decoding.
 */
export async function requestImageCandidates(
  config,
  { beforeDispatch, signal, timeoutMs = 90000, fetchImpl = fetch } = {},
) {
  let endpoint, apiKey, body, preflight;
  try {
    if (
      typeof beforeDispatch !== "function" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 120000 ||
      typeof config.baseURL !== "string" ||
      !config.baseURL.trim() ||
      typeof config.model !== "string" ||
      !config.model.trim() ||
      !config.model.isWellFormed() ||
      config.model.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(config.model) ||
      typeof config.apiKey !== "string" ||
      !config.apiKey.trim() ||
      config.apiKey.length > 16384 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(config.apiKey)
    )
      fail("INPUT", false);
    const editing = config.protocol === imageEditProtocol;
    if (
      (config.protocol !== undefined &&
        !["openai-images", imageEditProtocol].includes(config.protocol)) ||
      editing !== (config.reference !== undefined)
    )
      fail("INPUT", false);
    let reference = null;
    if (editing) {
      if (
        !config.reference ||
        Object.keys(config.reference).some(
          (key) => !["metadata", "bytes"].includes(key),
        )
      )
        fail("INPUT", false);
      const metadata = imageTaskReference(config.reference.metadata),
        bytes = copyImageBytes(config.reference.bytes);
      if (
        bytes.length !== metadata.derivative.bytes ||
        binaryHash(bytes) !== metadata.derivative.sha256
      )
        fail("INPUT", false);
      const decoded = await inspectAssetImage(bytes, 2048);
      if (
        Object.keys(decoded.blob).some(
          (key) => decoded.blob[key] !== metadata.derivative[key],
        )
      )
        fail("INPUT", false);
      reference = `data:image/png;base64,${bytes.toString("base64")}`;
    }
    endpoint =
      modelServiceURL(config.baseURL) +
      (editing ? "/images/edits" : "/images/generations");
    apiKey = config.apiKey.trim();
    preflight = imageGenerationPreflight(config.request, config.budget);
    const request = preflight.request;
    body = JSON.stringify({
      model: config.model.trim(),
      prompt: request.prompt,
      n: request.n,
      size: request.size,
      ...(reference ? { images: [{ image_url: reference }] } : {}),
      ...(request.responseMode === "request-base64"
        ? { response_format: "b64_json" }
        : {}),
    });
    new Headers({ authorization: `Bearer ${apiKey}` });
  } catch {
    fail("INPUT", false);
  }
  if (signal?.aborted) fail("CANCELLED", false);
  try {
    await beforeDispatch();
  } catch {
    fail("INTENT", false);
  }
  if (signal?.aborted) fail("CANCELLED", false);
  const deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  let dispatched = false;
  try {
    dispatched = true;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      await stopBody(response);
      fail("HTTP", true, "rejected");
    }
    const document = await boundedJSON(response);
    if (!document || !Array.isArray(document.data))
      fail("RESPONSE", true, "received-invalid");
    if (document.data.length !== preflight.request.n)
      fail("LIMIT", true, "received-invalid");
    const candidates = [],
      errors = [];
    for (const [sourceIndex, entry] of document.data.entries()) {
      try {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.b64_json !== "string"
        )
          fail("RESPONSE", true, "received-invalid");
        const bytes = decodedImage(entry.b64_json);
        let decoded;
        try {
          decoded = await inspectAssetImage(bytes);
        } catch {
          fail("IMAGE", true, "received-invalid");
        }
        candidates.push({
          ...decoded,
          sourceIndex,
          ...(typeof entry.revised_prompt === "string" &&
          entry.revised_prompt.length <= imageGenerationLimits.prompt &&
          entry.revised_prompt.isWellFormed()
            ? { revisedPrompt: entry.revised_prompt }
            : {}),
        });
      } catch (error) {
        if (
          !(error instanceof ImageProviderError) ||
          !["RESPONSE", "IMAGE", "LIMIT"].includes(error.code)
        )
          throw error;
        errors.push({ sourceIndex, code: error.code });
      }
    }
    return {
      candidates,
      errors,
      usage: usage(document.usage),
      estimatedCost: preflight.estimatedCost,
      currency: preflight.currency,
      dispatched: true,
      remoteResult: "received",
      interruptedAfterResponse: combined.aborted,
    };
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    fail(
      signal?.aborted
        ? "CANCELLED"
        : deadline.signal.aborted
          ? "TIMEOUT"
          : "NETWORK",
      dispatched,
    );
  } finally {
    clearTimeout(timer);
  }
}
