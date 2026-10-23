import { mkdir, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteText } from "../novel-storage/atomic.mjs";
import { readStreamPartial } from "./stream-capture.mjs";
import { budgetSummary } from "./budget.mjs";

const identifier =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set([
  "preparing",
  "running",
  "awaiting-review",
  "accepting",
  "acceptance-uncertain",
  "applied",
  "discarded",
  "cancelled",
  "failed",
  "interrupted",
]);
const transitions = {
  preparing: ["running", "cancelled", "failed", "interrupted"],
  running: ["awaiting-review", "cancelled", "failed", "interrupted"],
  "awaiting-review": ["accepting", "applied", "discarded"],
  accepting: ["applied", "awaiting-review", "acceptance-uncertain"],
  "acceptance-uncertain": [
    "applied",
    "awaiting-review",
    "acceptance-uncertain",
    "discarded",
  ],
  interrupted: ["discarded"],
  cancelled: ["discarded"],
  failed: ["discarded"],
  applied: [],
  discarded: [],
};

/** Private task records are independent of manuscripts and never auto-resume a model call. */
export class TaskJournal {
  #queue = Promise.resolve();
  constructor(root) {
    this.root = root;
  }
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #exclusive(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async #directory(id) {
    if (!identifier.test(id)) throw new Error("任务标识无效");
    const directory = join(this.root, id);
    for (const path of [this.root, directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("任务目录不能是链接");
    }
    return directory;
  }
  async #json(id, name, maxBytes = 2 * 1024 * 1024) {
    const path = join(await this.#directory(id), name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
      throw new Error("任务文件无效或过大");
    return JSON.parse(await readFile(path, "utf8"));
  }
  async #record(id) {
    const record = await this.#json(id, "task.json");
    if (
      record.id !== id ||
      !states.has(record.status) ||
      (record.schemaVersion !== undefined && record.schemaVersion !== 1)
    )
      throw new Error("任务记录版本或状态无效");
    return record;
  }
  async #write(id, name, value) {
    const directory = await this.#directory(id);
    await atomicWriteText(
      join(directory, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  }
  async #partial(id) {
    try {
      const proposal = await this.#json(id, "proposal.json");
      if (
        typeof proposal.replacement === "string" &&
        proposal.replacement.trim() &&
        proposal.replacement.length <= 120000
      )
        return { candidate: proposal.replacement, partialCandidate: true };
    } catch {
      /* An incomplete or damaged proposal is preserved on disk. */
    }
    try {
      return readStreamPartial(await this.#json(id, "stream.json"));
    } catch {
      /* Captured text is optional and never grants permission to apply. */
    }
    return {};
  }
  create(record, snapshot) {
    return this.#exclusive(async () => {
      if (!identifier.test(record.id) || record.status !== "preparing")
        throw new Error("初始任务状态无效");
      await mkdir(this.root, { recursive: true });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("任务目录不能是链接");
      await mkdir(join(this.root, record.id));
      // The index is written last: a discoverable task always has its frozen input.
      await this.#write(record.id, "snapshot.json", snapshot);
      await this.#write(record.id, "task.json", {
        ...record,
        schemaVersion: 1,
      });
    });
  }
  transition(id, status, changes = {}) {
    return this.#exclusive(async () => {
      const record = await this.#record(id);
      if (!transitions[record.status].includes(status))
        throw new Error("任务状态已变化，不能重复执行该操作");
      const allowed = [
        "candidate",
        "completedAt",
        "errorCode",
        "usage",
        "appliedHash",
        "reviewedAt",
        "sessionId",
        "acceptedText",
        "acceptance",
        "acceptanceRecovery",
      ];
      if (Object.keys(changes).some((key) => !allowed.includes(key)))
        throw new Error("不支持修改任务身份或范围");
      const partial = ["cancelled", "failed"].includes(status)
        ? await this.#partial(id)
        : {};
      const next = {
        ...record,
        ...partial,
        ...changes,
        schemaVersion: 1,
        status,
      };
      await this.#write(id, "task.json", next);
      return next;
    });
  }
  read(id) {
    return this.#exclusive(async () => {
      const record = await this.#record(id);
      const partial =
        !record.candidate &&
        ["cancelled", "failed", "interrupted"].includes(record.status)
          ? await this.#partial(id)
          : {};
      let reviewDraft = null,
        reviewDraftError;
      try {
        reviewDraft = await this.#reviewDraft(id, record);
      } catch {
        reviewDraftError =
          "审阅草稿无法读取，已保留原文件；原候选仍可核对，不能覆盖损坏草稿。";
      }
      return {
        record: { ...record, ...partial, usage: await this.#usage(id) },
        snapshot: await this.#json(id, "snapshot.json"),
        reviewDraft,
        reviewDraftError,
      };
    });
  }
  async #reviewDraft(id, record) {
    let draft;
    try {
      draft = await this.#json(id, "review.json");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (
      draft.schemaVersion !== 1 ||
      draft.taskId !== id ||
      typeof record.candidate !== "string" ||
      draft.sourceCandidateHash !==
        createHash("sha256").update(record.candidate).digest("hex") ||
      !Number.isSafeInteger(draft.revision) ||
      draft.revision < 1 ||
      typeof draft.text !== "string" ||
      draft.text.length > 120000 ||
      (draft.afterAcceptanceId !== undefined &&
        (typeof draft.afterAcceptanceId !== "string" ||
          !identifier.test(draft.afterAcceptanceId))) ||
      typeof draft.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(draft.updatedAt))
    )
      throw new Error("审阅草稿无效或来源不一致");
    return draft;
  }
  saveReviewDraft(id, text, expectedRevision) {
    return this.#exclusive(async () => {
      if (
        typeof text !== "string" ||
        text.length > 120000 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        throw new Error("审阅草稿文本或版本无效");
      const record = await this.#record(id);
      if (
        record.status !== "awaiting-review" ||
        !record.bookId ||
        (!record.chapterId && !record.materialId) ||
        typeof record.candidate !== "string"
      )
        throw new Error("此任务当前不能保存审阅草稿");
      const previous = await this.#reviewDraft(id, record);
      if ((previous?.revision || 0) !== expectedRevision)
        throw new Error("审阅草稿已改变，请关闭后重新审阅；本次内容尚未保存");
      if (expectedRevision >= Number.MAX_SAFE_INTEGER)
        throw new Error("审阅草稿版本超出范围");
      const draft = {
        schemaVersion: 1,
        taskId: id,
        ...(record.acceptance?.id
          ? { afterAcceptanceId: record.acceptance.id }
          : {}),
        sourceCandidateHash: createHash("sha256")
          .update(record.candidate)
          .digest("hex"),
        revision: expectedRevision + 1,
        text,
        updatedAt: new Date().toISOString(),
      };
      await this.#write(id, "review.json", draft);
      return draft;
    });
  }
  async #usage(id) {
    try {
      return budgetSummary(await this.#json(id, "usage.json", 256 * 1024));
    } catch {
      return undefined;
    }
  }
  usage(id) {
    return this.#exclusive(() => this.#usage(id));
  }
  list(
    bookId,
    limit = 100,
    { unbound = false, offset = 0, materialId = "" } = {},
  ) {
    return this.#exclusive(async () => {
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000)
        throw new Error("任务分页无效");
      const result = [];
      let entries;
      try {
        entries = await readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !identifier.test(entry.name)) continue;
        try {
          const record = await this.#record(entry.name);
          if (
            unbound
              ? record.bookId && (record.chapterId || record.materialId)
              : bookId && record.bookId !== bookId
          )
            continue;
          if (
            materialId &&
            (record.kind !== "material" || record.materialId !== materialId)
          )
            continue;
          const { candidate, acceptedText, acceptance, ...metadata } = record;
          result.push({
            ...metadata,
            hasCandidate: typeof candidate === "string" && candidate.length > 0,
          });
        } catch {
          /* A damaged or unsupported record is preserved, never executed. */
        }
      }
      return result
        .sort(
          (a, b) =>
            String(b.startedAt).localeCompare(String(a.startedAt)) ||
            a.id.localeCompare(b.id),
        )
        .slice(offset, offset + Math.max(1, Math.min(200, limit)));
    });
  }
  recoverInterrupted() {
    // Startup only, before accepting generation requests. Never restart the provider.
    return this.#exclusive(async () => {
      let entries;
      try {
        entries = await readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
      let recovered = 0;
      // Recovery must not inherit the UI list's page limit.
      for (const entry of entries) {
        if (!entry.isDirectory() || !identifier.test(entry.name)) continue;
        let record;
        try {
          record = await this.#record(entry.name);
        } catch {
          continue;
        }
        if (["preparing", "running"].includes(record.status)) {
          const partial = await this.#partial(record.id);
          await this.#write(record.id, "task.json", {
            ...record,
            ...partial,
            schemaVersion: 1,
            status: "interrupted",
            errorCode: "application-restarted",
            completedAt: new Date().toISOString(),
          });
          recovered++;
        }
      }
      return recovered;
    });
  }
  pendingAcceptanceIds() {
    return this.#exclusive(async () => {
      let entries;
      try {
        entries = await readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const ids = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !identifier.test(entry.name)) continue;
        try {
          const record = await this.#record(entry.name);
          if (["accepting", "acceptance-uncertain"].includes(record.status))
            ids.push(record.id);
        } catch {
          /* Preserve malformed records for manual recovery. */
        }
      }
      return ids;
    });
  }
}
