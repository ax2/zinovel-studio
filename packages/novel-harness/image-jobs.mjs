import { assetId } from "../novel-domain/assets.mjs";
import { imageTaskInput } from "../novel-domain/image-tasks.mjs";
import { binaryHash } from "../novel-storage/image-decoder.mjs";
import {
  requestImageCandidates,
  ImageProviderError,
} from "./image-provider.mjs";

const expected = (task) => ({
  id: task.id,
  revision: task.revision,
  diskHash: task.diskHash,
});
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("图像任务操作字段无效");
};
const choiceValue = (value) => {
  exact(value, ["revision", "diskHash"]);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.diskHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.diskHash)
  )
    throw new Error("请刷新图像模型选择");
  return { revision: value.revision, diskHash: value.diskHash };
};
const frozenProfile = (resolved) => ({
  id: resolved.profile.id,
  label: resolved.profile.label,
  model: resolved.profile.model,
  protocol: resolved.profile.protocol,
  revision: resolved.revision,
  diskHash: resolved.diskHash,
});

/** Host-only coordinator. The desktop exposes only strict author actions through its IPC allowlist.
 * One active or unsaved image response globally; never retries a paid network request.
 */
export class ImageJobService {
  #job = null;
  constructor(
    tasks,
    resolveModel,
    { transport = requestImageCandidates } = {},
  ) {
    this.tasks = tasks;
    this.resolveModel = resolveModel;
    this.transport = transport;
  }
  async prepare(bookId, input) {
    exact(input, ["id", "request", "target", "choice"]);
    const choice = choiceValue(input.choice),
      captured = structuredClone({
        id: input.id,
        request: input.request,
        target: input.target,
      }),
      selected = await this.resolveModel("image", choice, { secret: false });
    // Adapter options must be explicitly confirmed on the selected profile.
    if (
      !selected.profile.runnable ||
      selected.profile.protocol !== "openai-images" ||
      selected.profile.imageOptions?.responseMode !==
        captured.request?.responseMode
    )
      throw new Error("所选图像适配选项尚未明确确认，未发送请求");
    return this.tasks.create(
      bookId,
      imageTaskInput({
        ...captured,
        budget: selected.profile.imageBudget,
        profile: frozenProfile(selected),
      }),
    );
  }
  status() {
    const job = this.#job;
    return job
      ? {
          bookId: job.bookId,
          id: job.id,
          phase: job.phase,
          running: job.running,
          localResponseRetained: !!job.response,
          cancelRequested: job.controller.signal.aborted,
        }
      : null;
  }
  #identity(bookId, id) {
    if (
      !this.#job ||
      this.#job.bookId !== assetId(bookId) ||
      this.#job.id !== assetId(id)
    )
      throw new Error("当前进程没有该图像任务的运行或待保存结果");
    return this.#job;
  }
  async start(bookId, requested, modelChoice) {
    exact(requested, ["id", "revision", "diskHash"]);
    const capturedExpected = structuredClone(requested),
      choice = choiceValue(modelChoice),
      id = assetId(requested.id);
    assetId(bookId);
    if (this.#job)
      throw new Error("请先完成当前图像任务或保存已返回候选，再发送下一次请求");
    const job = {
      bookId,
      id,
      controller: new AbortController(),
      phase: "preparing",
      running: true,
      response: null,
      outcome: null,
      task: null,
      promise: null,
    };
    this.#job = job;
    job.promise = this.#run(job, capturedExpected, choice);
    return job.promise;
  }
  async #run(job, requested, choice) {
    try {
      const task = await this.tasks.read(job.bookId, job.id);
      if (
        task.revision !== requested.revision ||
        task.diskHash !== requested.diskHash ||
        task.status !== "prepared" ||
        task.restoredSource
      )
        throw new Error("图像任务已变化或不能发送，请重新核对");
      if (
        task.profile.revision !== choice.revision ||
        task.profile.diskHash !== choice.diskHash
      )
        throw new Error("图像任务与当前确认模型不符，请重新准备");
      const selected = await this.resolveModel("image", choice, {
        secret: true,
      });
      if (
        !selected.profile.runnable ||
        JSON.stringify(frozenProfile(selected)) !==
          JSON.stringify(task.profile) ||
        selected.profile.imageOptions?.responseMode !==
          task.request.responseMode
      )
        throw new Error("图像模型或明确适配选项已改变，未发送请求");
      job.task = task;
      job.phase = "requesting";
      const response = await this.transport(
        {
          baseURL: selected.profile.baseURL,
          apiKey: selected.apiKey,
          model: task.profile.model,
          request: task.request,
          budget: task.budget,
        },
        {
          signal: job.controller.signal,
          beforeDispatch: async () => {
            const current = await this.resolveModel("image", choice, {
              secret: false,
            });
            if (
              JSON.stringify(frozenProfile(current)) !==
              JSON.stringify(task.profile)
            )
              throw new Error("Model choice changed");
            job.task = await this.tasks.markSending(job.bookId, expected(task));
          },
        },
      );
      job.response = response;
      return await this.#save(job);
    } catch (error) {
      if (job.response) return this.#pending(job);
      if (!job.task) {
        this.#job = null;
        // Resolver/IO failures must not expose credential codec/provider raw errors.
        throw new Error(
          "图像任务或模型核对失败，未发送请求；请刷新后核对配置与任务",
        );
      }
      job.outcome =
        error instanceof ImageProviderError
          ? {
              code: error.code,
              dispatched: error.dispatched,
              remoteResult: error.remoteResult,
            }
          : {
              code: "NETWORK",
              dispatched: !!job.task.attemptId,
              remoteResult: job.task.attemptId ? "unknown" : "not-sent",
            };
      try {
        return await this.#save(job);
      } catch {
        return this.#pending(job);
      }
    } finally {
      job.running = false;
    }
  }
  #pending(job) {
    job.phase = job.response ? "local-save-pending" : "outcome-save-pending";
    return {
      status: job.phase,
      id: job.id,
      bookId: job.bookId,
      message: job.response
        ? "候选已返回但本地保存未完成，已保留在当前进程；请重试本地保存，不会重新请求"
        : "发送结果未能写入，当前进程保留结果事实；请重试本地保存，不会重新请求",
    };
  }
  async #save(job) {
    job.phase = "saving";
    const current = await this.tasks.read(job.bookId, job.id);
    if (
      current.creationHash !== job.task.creationHash ||
      (job.task.attemptId && current.attemptId !== job.task.attemptId)
    )
      throw new Error("Task identity changed");
    let task;
    if (job.response) {
      if (current.status === "received") {
        if (
          current.candidates.length !== job.response.candidates.length ||
          current.candidates.some(
            (item, index) =>
              item.blob.sha256 !==
                binaryHash(job.response.candidates[index].bytes) ||
              item.revisedPrompt !==
                job.response.candidates[index].revisedPrompt,
          ) ||
          JSON.stringify(current.usage) !==
            JSON.stringify(job.response.usage ?? null) ||
          current.interruptedAfterResponse !==
            job.response.interruptedAfterResponse
        )
          throw new Error("Received response differs from retained bytes");
        const verified = await this.tasks.reconcileReceived(
          job.bookId,
          expected(current),
        );
        if (verified.status !== "received")
          throw new Error("Candidate files incomplete");
        task = verified.task;
      } else {
        task = await this.tasks.receive(
          job.bookId,
          expected(current),
          job.task.attemptId,
          job.response,
        );
      }
    } else {
      if (["failed", "cancelled", "unknown"].includes(current.status)) {
        if (JSON.stringify(current.outcome) !== JSON.stringify(job.outcome))
          throw new Error("Outcome changed");
        task = current;
      } else
        task = await this.tasks.finishFailure(
          job.bookId,
          expected(current),
          job.outcome,
        );
    }
    job.response = null;
    this.#job = null;
    return { status: task.status, task };
  }
  cancel(bookId, id) {
    const job = this.#identity(bookId, id);
    if (job.phase === "saving" || job.response)
      throw new Error("候选正在保存或等待本地补存，不能丢弃已返回结果");
    job.controller.abort();
    return this.status();
  }
  async retryLocalSave(bookId, id) {
    const job = this.#identity(bookId, id);
    if (
      job.running ||
      !["local-save-pending", "outcome-save-pending"].includes(job.phase)
    )
      throw new Error("当前任务仍在处理，请稍后核对");
    job.running = true;
    job.promise = this.#save(job)
      .catch(() => this.#pending(job))
      .finally(() => {
        job.running = false;
      });
    return job.promise;
  }
  async discardRetained(bookId, requested, confirmation) {
    exact(requested, ["id", "revision", "diskHash"]);
    if (confirmation !== "discard-unsaved-images")
      throw new Error("请明确确认放弃当前进程中尚未保存的候选原图");
    const job = this.#identity(bookId, requested.id);
    if (job.running || !job.response || job.phase !== "local-save-pending")
      throw new Error("当前没有可明确放弃的待补存图像");
    const task = await this.tasks.read(bookId, requested.id);
    if (
      !["received-pending-check", "received"].includes(task.status) ||
      task.creationHash !== job.task.creationHash ||
      task.attemptId !== job.task.attemptId
    )
      throw new Error("请先重试本地保存以记录已收到的候选，再核对放弃");
    // Only after the explicit discard is durable may the sole retained response be released.
    job.running = true;
    try {
      const discarded = await this.tasks.discard(bookId, requested);
      job.response = null;
      this.#job = null;
      return { status: "discarded", task: discarded };
    } finally {
      job.running = false;
    }
  }
  async whenIdle() {
    await this.#job?.promise;
    return this.#job === null;
  }
}
