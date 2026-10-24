import { randomUUID } from "node:crypto";

const active = new Set(["capturing", "verifying", "committing", "cancelling"]);
/** Window/book-scoped, ephemeral capture work. Only completed snapshots are durable. */
export class PublicationCaptures {
  #jobs = new Map();
  #pending = new Set();
  #stopped = false;
  constructor(publication) {
    this.publication = publication;
  }
  start(owner, bookId, input) {
    if (this.#stopped) throw new Error("程序正在关闭，未开始新的发布捕获");
    if (!Number.isSafeInteger(owner) || owner < 1)
      throw new Error("发布窗口身份无效");
    const running = [...this.#jobs.values()].filter((job) =>
      active.has(job.status),
    );
    if (running.length >= 2 || running.some((job) => job.bookId === bookId))
      throw new Error("已有发布捕获尚未完成，请等待或取消");
    for (const job of [...this.#jobs.values()]
      .filter((job) => !active.has(job.status))
      .slice(0, Math.max(0, this.#jobs.size - 19)))
      this.#jobs.delete(job.id);
    const job = {
      id: randomUUID(),
      owner,
      bookId,
      status: "capturing",
      progress: null,
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.#jobs.set(job.id, job);
    const pending = this.publication
      .capture(bookId, input, {
        signal: job.controller.signal,
        onProgress: (progress) => {
          if (!job.controller.signal.aborted) {
            job.status = progress.phase;
            job.progress = { ...progress };
          }
        },
        onCommitting: () => {
          job.controller.signal.throwIfAborted();
          job.status = "committing";
        },
      })
      .then((snapshot) => {
        job.result = { id: snapshot.id, hash: snapshot.hash };
        job.status = "completed";
      })
      .catch((error) => {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = job.status === "failed" ? error.message : null;
      })
      .finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return { id: job.id };
  }
  #owned(owner, bookId, id) {
    const job = this.#jobs.get(id);
    if (!job || job.owner !== owner || job.bookId !== bookId)
      throw new Error("发布捕获不属于当前窗口或作品");
    return job;
  }
  status(owner, bookId, id) {
    const job = this.#owned(owner, bookId, id);
    return structuredClone({
      id: job.id,
      bookId: job.bookId,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
    });
  }
  cancel(owner, bookId, id) {
    const job = this.#owned(owner, bookId, id);
    if (!active.has(job.status) || job.status === "committing")
      return { cancelled: false, status: job.status };
    job.status = "cancelling";
    job.controller.abort();
    return { cancelled: true, status: job.status };
  }
  async cancelAll() {
    for (const job of this.#jobs.values())
      if (active.has(job.status) && job.status !== "committing") {
        job.status = "cancelling";
        job.controller.abort();
      }
    await Promise.allSettled([...this.#pending]);
  }
  async stop() {
    this.#stopped = true;
    await this.cancelAll();
  }
}
