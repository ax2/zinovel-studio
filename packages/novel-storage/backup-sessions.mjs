import { randomUUID } from "node:crypto";

const active = (job) =>
  [
    "capturing",
    "scanning",
    "copying",
    "verifying",
    "committing",
    "cancelling",
  ].includes(job.status);
/** Ephemeral native-picker capabilities and owner-scoped jobs. No renderer-supplied paths. */
export class BackupSessions {
  #sessions = new Map();
  #jobs = new Map();
  #pending = new Set();
  #stopped = false;
  #restoring = false;
  constructor(backups) {
    this.backups = backups;
  }
  #check(owner, bookId) {
    if (this.#stopped) throw new Error("程序正在关闭，未开始新的备份操作");
    if (
      !Number.isSafeInteger(owner) ||
      owner < 1 ||
      typeof bookId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(bookId)
    )
      throw new Error("备份窗口或作品身份无效");
  }
  #session(owner, bookId, token) {
    this.#check(owner, bookId);
    const session = this.#sessions.get(token);
    if (!session || session.owner !== owner || session.bookId !== bookId)
      throw new Error("备份库选择不属于当前窗口或作品，请重新选择");
    return session;
  }
  #view(session, page = 0) {
    if (!Number.isSafeInteger(page) || page < 0)
      throw new Error("备份列表页码无效");
    const total = session.list.snapshots.length,
      pages = Math.max(1, Math.ceil(total / 50));
    page = Math.min(page, pages - 1);
    return {
      token: session.token,
      path: session.path,
      canCapture: session.bookId === session.list.bookId,
      total,
      page,
      pages,
      snapshots: session.list.snapshots.slice(page * 50, (page + 1) * 50),
      errors: session.list.errors,
      validation: "恢复时逐文件完整校验；此列表仅核对清单",
    };
  }
  async open(owner, bookId, path) {
    this.#check(owner, bookId);
    const list = await this.backups.list(path);
    this.#check(owner, bookId);
    if (this.#sessions.size >= 10)
      this.#sessions.delete(this.#sessions.keys().next().value);
    const session = { token: randomUUID(), owner, bookId, path, list };
    this.#sessions.set(session.token, session);
    return this.#view(session);
  }
  async refresh(owner, bookId, token) {
    const session = this.#session(owner, bookId, token),
      list = await this.backups.list(session.path);
    if (
      list.vaultId !== session.list.vaultId ||
      list.bookId !== session.list.bookId
    )
      throw new Error("所选备份库身份已改变，请重新选择");
    session.list = list;
    return this.#view(session);
  }
  page(owner, bookId, token, page) {
    return this.#view(this.#session(owner, bookId, token), page);
  }
  #start(owner, bookId, path, options = {}) {
    this.#check(owner, bookId);
    if (this.#restoring || [...this.#jobs.values()].some(active))
      throw new Error("已有备份或恢复进行中，请等待或取消");
    for (const job of [...this.#jobs.values()]
      .filter((job) => !active(job))
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
    const pending = this.backups
      .capture(bookId, path, {
        ...options,
        signal: job.controller.signal,
        onProgress: (progress) => {
          if (job.status !== "cancelling" && job.status !== "committing")
            job.status =
              progress.phase === "object-written"
                ? "copying"
                : progress.phase === "ready-to-commit"
                  ? "verifying"
                  : progress.phase === "committed"
                    ? "committing"
                    : progress.phase;
          job.progress = { ...progress };
        },
        onCommitting: () => {
          job.controller.signal.throwIfAborted();
          job.status = "committing";
        },
      })
      .then((result) => {
        job.result = result;
        job.status = "completed";
      })
      .catch((error) => {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = job.status === "failed" ? String(error.message) : null;
      })
      .finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return { id: job.id };
  }
  startNew(owner, bookId, nativeDirectory) {
    return this.#start(owner, bookId, nativeDirectory);
  }
  startSelected(owner, bookId, token) {
    const session = this.#session(owner, bookId, token);
    if (session.list.bookId !== bookId)
      throw new Error("该备份库属于其他作品，只能恢复为新书");
    return this.#start(owner, bookId, session.path, {
      existingVault: true,
      expectedVaultId: session.list.vaultId,
    });
  }
  #ownedJob(owner, bookId, id) {
    const job = this.#jobs.get(id);
    if (!job || job.owner !== owner || job.bookId !== bookId)
      throw new Error("备份任务不属于当前窗口或作品");
    return job;
  }
  status(owner, bookId, id) {
    const job = this.#ownedJob(owner, bookId, id);
    return structuredClone({
      id: job.id,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
    });
  }
  cancel(owner, bookId, id) {
    const job = this.#ownedJob(owner, bookId, id);
    if (!active(job) || job.status === "committing")
      return { cancelled: false, status: job.status };
    job.status = "cancelling";
    job.controller.abort();
    return { cancelled: true, status: job.status };
  }
  async completed(owner, bookId, id) {
    const job = this.#ownedJob(owner, bookId, id);
    if (job.status !== "completed" || !job.result)
      throw new Error("备份尚未完成，不能打开结果");
    return this.open(owner, bookId, job.result.path);
  }
  async restore(owner, bookId, token, id, hash) {
    const session = this.#session(owner, bookId, token);
    if (this.#restoring || [...this.#jobs.values()].some(active))
      throw new Error("请先等待备份或恢复完成，再恢复版本");
    if (
      !session.list.snapshots.some(
        (item) => item.id === id && item.hash === hash,
      )
    )
      throw new Error("恢复版本未在当前已选择清单中，请刷新后重新确认");
    this.#restoring = true;
    let pending;
    try {
      pending = Promise.resolve(
        this.backups.restore(session.path, id, {
          expectedHash: hash,
          expectedVaultId: session.list.vaultId,
        }),
      );
    } catch (error) {
      this.#restoring = false;
      throw error;
    }
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
      this.#restoring = false;
    }
  }
  async cancelAll() {
    for (const job of this.#jobs.values())
      if (active(job) && job.status !== "committing") {
        job.status = "cancelling";
        job.controller.abort();
      }
    await Promise.allSettled([...this.#pending]);
  }
  async stop() {
    this.#stopped = true;
    await this.cancelAll();
    this.#sessions.clear();
  }
}
