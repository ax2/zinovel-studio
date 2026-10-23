import { randomUUID } from "node:crypto";
import { digest } from "../novel-storage/store.mjs";

/** Coordinates author-approved manuscript writes and a recoverable acceptance receipt. */
export class TaskAcceptance {
  #queue = Promise.resolve();
  constructor(journal, store, checkpoint = async () => {}) {
    this.journal = journal;
    this.store = store;
    this.checkpoint = checkpoint;
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
  async whenIdle() {
    await this.#queue;
  }
  async #reconcile(id) {
    const { record, snapshot } = await this.journal.read(id);
    if (record.kind === "material") return record;
    if (!["accepting", "acceptance-uncertain"].includes(record.status))
      return record;
    const intent = record.acceptance,
      target = snapshot.target;
    let chapter, receipt;
    try {
      if (
        !intent ||
        !target ||
        typeof intent.acceptedText !== "string" ||
        intent.beforeHash !== digest(target.body) ||
        intent.afterHash !==
          digest(
            target.body.slice(0, target.start) +
              intent.acceptedText +
              target.body.slice(target.end),
          )
      )
        throw new Error("Invalid acceptance intent");
      // This read first rolls forward the manuscript's existing transaction;
      // its receipt proves acceptance even if the author later edited/undid it.
      receipt = await this.store.readAcceptanceReceipt(
        target.bookId,
        intent.id,
      );
      if (receipt) {
        if (
          receipt.schemaVersion !== 1 ||
          receipt.id !== intent.id ||
          receipt.taskId !== id ||
          receipt.chapterId !== target.chapterId ||
          receipt.beforeHash !== intent.beforeHash ||
          receipt.afterHash !== intent.afterHash
        )
          throw new Error("Receipt does not match the intent");
      } else {
        chapter = await this.store.readChapter(target.bookId, target.chapterId);
        if (chapter.deletedAt) throw new Error("Chapter is archived");
      }
    } catch {
      return this.journal.transition(id, "acceptance-uncertain", {
        errorCode: "acceptance-target-unavailable",
      });
    }
    if (receipt) {
      return this.journal.transition(id, "applied", {
        appliedHash: intent.afterHash,
        acceptedText: intent.acceptedText,
        reviewedAt: intent.preparedAt,
        acceptanceRecovery: "receipt-confirmed",
        errorCode: undefined,
      });
    }
    if (chapter.diskHash === intent.beforeHash) {
      return this.journal.transition(id, "awaiting-review", {
        acceptanceRecovery: "original-text-retained",
        errorCode: undefined,
      });
    }
    return this.journal.transition(id, "acceptance-uncertain", {
      errorCode: "acceptance-text-diverged",
    });
  }
  reconcile(id) {
    return this.#exclusive(() => this.#reconcile(id));
  }
  recoverAll() {
    return this.#exclusive(async () => {
      const ids = await this.journal.pendingAcceptanceIds();
      for (const id of ids) await this.#reconcile(id);
      return ids.length;
    });
  }
  async #savedResult(target, receiptPending = false) {
    const chapter = await this.store.readChapter(
      target.bookId,
      target.chapterId,
    );
    const { books } = await this.store.listBooks();
    const book = books.find((book) => book.id === target.bookId);
    if (!book) throw new Error("作品暂时无法读取，请从任务记录核对接受结果");
    return { status: "saved", chapter, book, receiptPending };
  }
  accept(id, candidate) {
    return this.#exclusive(async () => {
      let task = await this.journal.read(id);
      if (["accepting", "acceptance-uncertain"].includes(task.record.status)) {
        await this.#reconcile(id);
        task = await this.journal.read(id);
      }
      const { record, snapshot } = task,
        target = snapshot.target;
      if (
        !target ||
        typeof candidate !== "string" ||
        !candidate.trim() ||
        candidate.length > 120000
      )
        throw new Error("候选内容或绑定章节无效");
      const chapter = await this.store.readChapter(
        target.bookId,
        target.chapterId,
      );
      if (
        record.status === "applied" &&
        record.acceptedText === candidate &&
        chapter.diskHash === record.appliedHash
      )
        return this.#savedResult(target);
      if (record.status !== "awaiting-review")
        throw new Error("任务状态已变化，请从任务记录核对接受结果");
      if (chapter.deletedAt || chapter.body !== target.body)
        throw new Error("原章正文已改变，未接受旧候选");
      const body =
        target.body.slice(0, target.start) +
        candidate +
        target.body.slice(target.end);
      const acceptance = {
        id: randomUUID(),
        beforeHash: chapter.diskHash,
        afterHash: digest(body),
        acceptedText: candidate,
        preparedAt: new Date().toISOString(),
      };
      await this.journal.transition(id, "accepting", {
        acceptance,
        acceptanceRecovery: undefined,
      });
      await this.checkpoint("intent-written");
      let result;
      try {
        result = await this.store.saveChapter(
          {
            bookId: target.bookId,
            chapterId: target.chapterId,
            title: chapter.title,
            body,
            expectedRevision: chapter.revision,
            expectedHash: chapter.diskHash,
          },
          { ...acceptance, taskId: id },
        );
      } catch (error) {
        // A durable manuscript transaction may have landed before I/O reported
        // failure. Reconcile its actual state; never blindly retry the write.
        const recovered = await this.#reconcile(id);
        if (recovered.status === "applied") return this.#savedResult(target);
        throw new Error("接受尚未确认，请从任务记录核对；没有自动重试改稿", {
          cause: error,
        });
      }
      if (result.status === "conflict") {
        await this.#reconcile(id);
        return result;
      }
      await this.checkpoint("manuscript-saved");
      try {
        await this.journal.transition(id, "applied", {
          appliedHash: result.chapter.diskHash,
          acceptedText: candidate,
          reviewedAt: acceptance.preparedAt,
        });
      } catch {
        // The editor must display the saved text even if only the receipt write
        // failed. Startup (or explicit reconciliation) can complete the receipt.
        return { ...result, receiptPending: true };
      }
      return result;
    });
  }
}
