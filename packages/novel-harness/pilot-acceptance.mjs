import { randomUUID, createHash } from "node:crypto";
import { pilotReplacement } from "../novel-domain/pilots.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Reconcile only a transactional receipt. Recovery must never replay model output over later author edits. */
export class PilotTaskAcceptance {
  #queue = Promise.resolve();
  constructor(journal, pilots, checkpoint = async () => {}) {
    this.journal = journal;
    this.pilots = pilots;
    this.checkpoint = checkpoint;
  }
  #exclusive(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }
  async whenIdle() {
    await this.#queue;
  }
  async #reconcile(id) {
    const { record, snapshot } = await this.journal.read(id);
    if (
      record.kind !== "pilot" ||
      !["accepting", "acceptance-uncertain"].includes(record.status)
    )
      return record;
    const target = snapshot.pilotTarget,
      intent = record.acceptance;
    try {
      if (
        !target ||
        !intent ||
        intent.pilotId !== target.id ||
        intent.beforeHash !== target.diskHash ||
        intent.beforeBodyHash !== target.bodyHash ||
        intent.briefHash !== target.briefHash ||
        intent.acceptedHash !== hash(pilotReplacement(intent.acceptedText))
      )
        throw new Error("试写接受意图无效");
      const receipt = await this.pilots.acceptanceReceipt(
        target.bookId,
        intent.id,
      );
      if (receipt) {
        if (
          receipt.schemaVersion !== 1 ||
          receipt.id !== intent.id ||
          receipt.taskId !== id ||
          receipt.pilotId !== target.id ||
          receipt.groupId !== target.groupId ||
          receipt.beforeHash !== target.diskHash ||
          receipt.beforeBodyHash !== target.bodyHash ||
          receipt.briefHash !== target.briefHash ||
          receipt.acceptedHash !== intent.acceptedHash ||
          !/^[a-f0-9]{64}$/.test(receipt.afterHash)
        )
          throw new Error("试写接受回执无效");
        return this.journal.transition(id, "applied", {
          appliedHash: receipt.afterHash,
          acceptedText: intent.acceptedText,
          reviewedAt: intent.preparedAt,
          acceptanceRecovery: "receipt-confirmed",
          errorCode: undefined,
        });
      }
      const current = await this.pilots.read(target.bookId, target.id);
      if (
        !current.deletedAt &&
        current.diskHash === target.diskHash &&
        current.bodyHash === target.bodyHash
      )
        return this.journal.transition(id, "awaiting-review", {
          acceptanceRecovery: "original-text-retained",
          errorCode: undefined,
        });
    } catch {
      /* Preserve uncertain state for explicit review. */
    }
    return this.journal.transition(id, "acceptance-uncertain", {
      errorCode: "pilot-acceptance-unconfirmed",
    });
  }
  reconcile(id) {
    return this.#exclusive(() => this.#reconcile(id));
  }
  recoverAll() {
    return this.#exclusive(async () => {
      for (const id of await this.journal.pendingAcceptanceIds())
        await this.#reconcile(id);
    });
  }
  accept(id, candidate) {
    pilotReplacement(candidate);
    return this.#exclusive(async () => {
      let task = await this.journal.read(id);
      if (task.record.kind !== "pilot" || !task.snapshot.pilotTarget)
        throw new Error("任务不是试写候选");
      if (["accepting", "acceptance-uncertain"].includes(task.record.status)) {
        await this.#reconcile(id);
        task = await this.journal.read(id);
      }
      const {
        record,
        snapshot: { pilotTarget: target },
      } = task;
      if (record.status !== "awaiting-review")
        throw new Error("试写任务状态已改变，请重新核对");
      // Host snapshot validates metadata AND body before preparing an intent.
      const current = await this.pilots.taskSnapshot(target.bookId, target);
      if (current.target.briefHash !== target.briefHash)
        throw new Error("实验场景或来源已改变，请保留候选并重新生成");
      const intent = {
        id: randomUUID(),
        pilotId: target.id,
        beforeHash: target.diskHash,
        beforeBodyHash: target.bodyHash,
        briefHash: target.briefHash,
        acceptedHash: hash(candidate),
        acceptedText: candidate,
        preparedAt: new Date().toISOString(),
      };
      await this.journal.transition(id, "accepting", {
        acceptance: intent,
        acceptanceRecovery: undefined,
      });
      await this.checkpoint("intent-written");
      let result;
      try {
        result = await this.pilots.save(
          target.bookId,
          target.groupId,
          { ...target.input, body: candidate },
          target,
          null,
          { ...intent, taskId: id },
        );
      } catch (error) {
        await this.#reconcile(id);
        throw new Error("试写接受尚未确认，请核对任务与稿件；未自动重试", {
          cause: error,
        });
      }
      await this.checkpoint("pilot-saved");
      try {
        await this.journal.transition(id, "applied", {
          appliedHash: result.diskHash,
          acceptedText: candidate,
          reviewedAt: intent.preparedAt,
        });
      } catch {
        return { pilot: result, receiptPending: true };
      }
      return { pilot: result, receiptPending: false };
    });
  }
}
