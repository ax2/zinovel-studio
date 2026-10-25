import { createHash } from "node:crypto";
import {
  assetId,
  assetHash,
  assetPurposes,
  validateAssetBlob,
  assetInput,
} from "./assets.mjs";
import { assetCreationHash } from "./asset-creation-hash.mjs";
import {
  imageGenerationPreflight,
  imageGenerationLimits,
} from "./image-generation.mjs";

const keys = (value, allowed) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("图像任务字段不支持，原记录已保留");
};
const text = (value, max) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !value.isWellFormed() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("图像任务名称或模型标识无效");
  return value;
};
const revision = (value) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("图像任务修订无效");
  return value;
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function expectedTarget(value) {
  if (value === null) return null;
  keys(value, ["id", "revision", "diskHash"]);
  return {
    id: assetId(value.id),
    revision: revision(value.revision),
    diskHash: assetHash(value.diskHash),
  };
}
export function imageTaskTarget(value) {
  keys(value, ["purpose", "material", "chapter"]);
  if (!assetPurposes.includes(value.purpose)) throw new Error("图像用途无效");
  const material = expectedTarget(value.material ?? null),
    chapter = expectedTarget(value.chapter ?? null);
  if (value.purpose === "portrait" && !material)
    throw new Error("人物定妆任务需要明确的角色版本");
  if (value.purpose === "illustration" && !chapter)
    throw new Error("章节插图任务需要明确的章节版本");
  return { purpose: value.purpose, material, chapter };
}
function profile(value) {
  keys(value, ["id", "label", "model", "protocol", "revision", "diskHash"]);
  if (value.protocol !== "openai-images")
    throw new Error("图像任务不能借用文字协议");
  return {
    id: assetId(value.id),
    label: text(value.label, 80),
    model: text(value.model, 200),
    protocol: value.protocol,
    revision: revision(value.revision),
    diskHash: assetHash(value.diskHash),
  };
}
export function imageTaskInput(input) {
  keys(input, ["id", "request", "budget", "profile", "target"]);
  const checked = imageGenerationPreflight(input.request, input.budget);
  return {
    id: assetId(input.id),
    request: checked.request,
    budget: checked.budget,
    profile: profile(input.profile),
    target: imageTaskTarget(input.target),
  };
}
export function imageTaskCreationHash(bookId, input) {
  return hash({ bookId: assetId(bookId), ...imageTaskInput(input) });
}
export function imageTaskOutcome(value) {
  keys(value, ["code", "dispatched", "remoteResult"]);
  const codes = [
    "INPUT",
    "INTENT",
    "CANCELLED",
    "TIMEOUT",
    "NETWORK",
    "HTTP",
    "RESPONSE",
    "LIMIT",
    "IMAGE",
    "STORAGE",
  ];
  if (
    !codes.includes(value.code) ||
    typeof value.dispatched !== "boolean" ||
    !["not-sent", "unknown", "rejected", "received-invalid"].includes(
      value.remoteResult,
    ) ||
    value.dispatched === (value.remoteResult === "not-sent") ||
    (["INPUT", "INTENT"].includes(value.code) && value.dispatched) ||
    (value.code === "HTTP" &&
      (!value.dispatched || value.remoteResult !== "rejected"))
  )
    throw new Error("图像任务结果事实无效");
  return {
    code: value.code,
    dispatched: value.dispatched,
    remoteResult: value.remoteResult,
  };
}
export function imageTaskReviewedTarget(original, value) {
  const before = imageTaskTarget(original),
    after = imageTaskTarget(value);
  if (
    before.purpose !== after.purpose ||
    ["material", "chapter"].some(
      (field) => (before[field]?.id ?? null) !== (after[field]?.id ?? null),
    )
  )
    throw new Error(
      "复评只能确认同一人物或章节的新版本，不能改变用途或目标身份",
    );
  if (JSON.stringify(before) === JSON.stringify(after))
    throw new Error("目标没有变化，请使用普通采用");
  return after;
}
export function imageTaskTargetReviewHash(task, index, adoption) {
  const item = task.candidates[index];
  return hash({
    format: "zinovel-image-target-review",
    schemaVersion: 1,
    taskId: task.id,
    creationHash: task.creationHash,
    responseHash: task.responseHash,
    index,
    assetId: item.assetId,
    original: imageTaskTarget(task.target),
    target: imageTaskReviewedTarget(task.target, adoption.targetReview.target),
    adoptedBookId: adoption.bookId,
    creation: adoption.creationHash,
    adoptedAt: adoption.adoptedAt,
  });
}
function candidate(value, index, version) {
  keys(value, [
    "index",
    "blob",
    "revisedPrompt",
    "decision",
    "assetId",
    "adoption",
    "sourceIndex",
  ]);
  if (
    value.index !== index ||
    !["pending", "discarded", "accepted"].includes(value.decision)
  )
    throw new Error("图像候选状态无效");
  validateAssetBlob(value.blob);
  if (
    value.sourceIndex !== undefined &&
    (!Number.isInteger(value.sourceIndex) ||
      value.sourceIndex < 0 ||
      value.sourceIndex >= imageGenerationLimits.count)
  )
    throw new Error("图像候选原返回位置无效");
  if (value.decision === "accepted") {
    keys(value.adoption, [
      "bookId",
      "input",
      "creationHash",
      "adoptedAt",
      ...(version === 2 ? ["targetReview"] : []),
    ]);
    if (
      assetCreationHash(
        value.assetId,
        value.adoption.bookId,
        value.adoption.input,
        value.blob,
      ) !== assetHash(value.adoption.creationHash) ||
      typeof value.adoption.adoptedAt !== "string" ||
      !Number.isFinite(Date.parse(value.adoption.adoptedAt))
    )
      throw new Error("图像采用回执无效");
  } else if (value.adoption !== undefined)
    throw new Error("未采用的候选不能声明采用回执");
  if (value.blob.bytes > imageGenerationLimits.imageBytes)
    throw new Error("图像候选过大");
  if (
    value.revisedPrompt !== undefined &&
    (typeof value.revisedPrompt !== "string" ||
      !value.revisedPrompt.isWellFormed() ||
      value.revisedPrompt.length > imageGenerationLimits.prompt)
  )
    throw new Error("图像候选说明无效");
  return {
    index,
    blob: structuredClone(value.blob),
    decision: value.decision,
    assetId: assetId(value.assetId),
    ...(value.revisedPrompt !== undefined
      ? { revisedPrompt: value.revisedPrompt }
      : {}),
  };
}
export function imageTaskCandidateErrors(value) {
  if (!Array.isArray(value) || value.length > imageGenerationLimits.count)
    throw new Error("图像逐项错误清单无效");
  return value.map((item) => {
    keys(item, ["sourceIndex", "code"]);
    if (
      !Number.isInteger(item.sourceIndex) ||
      item.sourceIndex < 0 ||
      item.sourceIndex >= imageGenerationLimits.count ||
      !["RESPONSE", "IMAGE", "LIMIT"].includes(item.code)
    )
      throw new Error("图像逐项错误事实无效");
    return { sourceIndex: item.sourceIndex, code: item.code };
  });
}
export function imageTaskResponseHash(value) {
  return hash({
    attemptId: value.attemptId,
    candidates: value.candidates.map((item) => ({
      index: item.index,
      assetId: item.assetId,
      ...(item.sourceIndex !== undefined
        ? { sourceIndex: item.sourceIndex }
        : {}),
      blob: Object.fromEntries(
        [
          "sha256",
          "bytes",
          "format",
          "mime",
          "width",
          "height",
          "orientation",
          "displayWidth",
          "displayHeight",
        ].map((key) => [key, item.blob[key]]),
      ),
      ...(item.revisedPrompt !== undefined
        ? { revisedPrompt: item.revisedPrompt }
        : {}),
    })),
    usage: value.usage,
    interruptedAfterResponse: value.interruptedAfterResponse,
    ...(value.candidateErrors !== undefined
      ? { candidateErrors: imageTaskCandidateErrors(value.candidateErrors) }
      : {}),
  });
}
export function validateImageTask(value, id, origins) {
  keys(value, [
    "format",
    "schemaVersion",
    "id",
    "bookId",
    "creationHash",
    "revision",
    "createdAt",
    "updatedAt",
    "status",
    "request",
    "budget",
    "profile",
    "target",
    "attemptId",
    "candidates",
    "outcome",
    "usage",
    "interruptedAfterResponse",
    "responseHash",
    "candidateErrors",
  ]);
  if (
    value.format !== "zinovel-image-task" ||
    ![1, 2].includes(value.schemaVersion) ||
    value.id !== assetId(id) ||
    !origins.includes(assetId(value.bookId)) ||
    ![
      "prepared",
      "send-intent",
      "receive-intent",
      "received",
      "unknown",
      "failed",
      "cancelled",
      "discarded",
    ].includes(value.status)
  )
    throw new Error("图像任务版本、状态或所属作品无效");
  revision(value.revision);
  for (const field of ["createdAt", "updatedAt"])
    if (
      typeof value[field] !== "string" ||
      !Number.isFinite(Date.parse(value[field]))
    )
      throw new Error("图像任务时间无效");
  const input = imageTaskInput({
    id,
    request: value.request,
    budget: value.budget,
    profile: value.profile,
    target: value.target,
  });
  if (
    imageTaskCreationHash(value.bookId, input) !== assetHash(value.creationHash)
  )
    throw new Error("图像任务冻结基线不符");
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > imageGenerationLimits.count ||
    typeof value.interruptedAfterResponse !== "boolean"
  )
    throw new Error("图像候选清单无效");
  value.candidates.forEach((item, index) =>
    candidate(item, index, value.schemaVersion),
  );
  const candidateErrors =
    value.candidateErrors === undefined
      ? []
      : imageTaskCandidateErrors(value.candidateErrors);
  if (
    value.candidateErrors !== undefined &&
    !["receive-intent", "received", "discarded"].includes(value.status)
  )
    throw new Error("尚未收到图像响应，不能声明逐项错误");
  if (
    new Set(value.candidates.map((item) => item.assetId)).size !==
    value.candidates.length
  )
    throw new Error("图像候选资源身份重复");
  for (const item of value.candidates) {
    if (item.decision !== "accepted") continue;
    const adoptedInput = assetInput(item.adoption.input);
    if (
      !["received", "discarded"].includes(value.status) ||
      !origins.includes(item.adoption.bookId) ||
      adoptedInput.purpose !== value.target.purpose ||
      (value.target.material &&
        !adoptedInput.linkedIds.includes(value.target.material.id))
    )
      throw new Error("图像采用目标或所属作品不符");
    if (item.adoption.targetReview !== undefined) {
      const review = item.adoption.targetReview;
      keys(review, ["schemaVersion", "target", "hash"]);
      if (
        review.schemaVersion !== 1 ||
        imageTaskTargetReviewHash(value, item.index, item.adoption) !==
          assetHash(review.hash)
      )
        throw new Error("图像目标复评回执校验不符，原记录已保留");
    }
  }
  if (
    value.schemaVersion === 2 &&
    !value.candidates.some((item) => item.adoption?.targetReview)
  )
    throw new Error("图像任务新版本缺少明确复评事实");
  if (value.attemptId !== undefined) assetId(value.attemptId);
  if (value.status === "prepared" && value.attemptId !== undefined)
    throw new Error("有发送意图的任务不能重置为待发送");
  if (
    ["send-intent", "receive-intent", "received", "unknown"].includes(
      value.status,
    ) &&
    !value.attemptId
  )
    throw new Error("图像发送事实缺失");
  if (
    ["receive-intent", "received"].includes(value.status) &&
    value.candidates.length + candidateErrors.length !== input.request.n
  )
    throw new Error("图像候选数量不符");
  if (value.candidates.length || candidateErrors.length) {
    const positions = [
      ...value.candidates.map((item) => item.sourceIndex ?? item.index),
      ...candidateErrors.map((item) => item.sourceIndex),
    ].sort((a, b) => a - b);
    if (
      positions.length !== input.request.n ||
      positions.some((position, index) => position !== index)
    )
      throw new Error("图像原返回位置缺失或重复");
  }
  if (
    !["receive-intent", "received", "discarded"].includes(value.status) &&
    value.candidates.length
  )
    throw new Error("图像任务尚未收到候选");
  if (value.outcome !== undefined) imageTaskOutcome(value.outcome);
  if (value.outcome?.dispatched && !value.attemptId)
    throw new Error("缺少已尝试发送的身份");
  if (
    !["receive-intent", "received", "discarded"].includes(value.status) &&
    (value.usage !== null || value.interruptedAfterResponse)
  )
    throw new Error("未收到图像的任务不能声明返回用量或迟到结果");
  if (
    ["unknown", "failed", "cancelled"].includes(value.status) &&
    !value.outcome
  )
    throw new Error("图像结果事实缺失");
  if (
    value.status === "unknown" &&
    (!value.outcome.dispatched || value.outcome.remoteResult !== "unknown")
  )
    throw new Error("图像远端未知状态不符");
  if (
    value.status === "cancelled" &&
    (value.outcome.dispatched || value.outcome.code !== "CANCELLED")
  )
    throw new Error("不能把已发送任务标作未发送取消");
  if (value.status === "failed" && value.outcome.remoteResult === "unknown")
    throw new Error("结果未知不能冒充确定失败");
  if (
    ["prepared", "send-intent", "receive-intent", "received"].includes(
      value.status,
    ) &&
    value.outcome !== undefined
  )
    throw new Error("图像任务结果与状态不符");
  if (value.usage !== null) {
    keys(value.usage, ["input_tokens", "output_tokens", "total_tokens"]);
    if (
      !Object.keys(value.usage).length ||
      Object.values(value.usage).some(
        (count) =>
          !Number.isSafeInteger(count) || count < 0 || count > 1000000000,
      )
    )
      throw new Error("图像用量无效");
  }
  if (value.candidates.length || candidateErrors.length) {
    if (imageTaskResponseHash(value) !== assetHash(value.responseHash))
      throw new Error("图像接收回执校验不符，原记录已保留");
  } else if (value.responseHash !== undefined)
    throw new Error("没有候选的图像任务不能声明接收回执");
  return value;
}
