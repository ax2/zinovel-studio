import { randomUUID, createHash } from "node:crypto";
import { materialProposal } from "../novel-domain/material-proposal.mjs";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A material write and receipt share the book transaction; task recovery only reconciles facts. */
export class MaterialTaskAcceptance {
  #queue = Promise.resolve();
  constructor(journal, materials, checkpoint = async () => {}) {
    this.journal = journal;
    this.materials = materials;
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
      record.kind !== "material" ||
      !["accepting", "acceptance-uncertain"].includes(record.status)
    )
      return record;
    const target = snapshot.materialTarget,
      intent = record.acceptance;
    try {
      if (
        !target ||
        !intent ||
        intent.beforeHash !== target.diskHash ||
        intent.materialId !== target.id ||
        intent.acceptedHash !==
          hash(materialProposal(JSON.parse(intent.acceptedText), target.input))
      )
        throw new Error("资料接受意图无效");
      const receipt = await this.materials.acceptanceReceipt(
        target.bookId,
        intent.id,
      );
      if (receipt) {
        if (
          receipt.schemaVersion !== 1 ||
          receipt.id !== intent.id ||
          receipt.taskId !== id ||
          receipt.materialId !== target.id ||
          receipt.beforeHash !== intent.beforeHash ||
          receipt.acceptedHash !== intent.acceptedHash ||
          !/^[a-f0-9]{64}$/.test(receipt.afterHash)
        )
          throw new Error("资料接受回执无效");
        return this.journal.transition(id, "applied", {
          appliedHash: receipt.afterHash,
          acceptedText: intent.acceptedText,
          reviewedAt: intent.preparedAt,
          acceptanceRecovery: "receipt-confirmed",
          errorCode: undefined,
        });
      }
      const current = await this.materials.read(target.bookId, target.id);
      if (current.diskHash === intent.beforeHash && !current.deletedAt)
        return this.journal.transition(id, "awaiting-review", {
          acceptanceRecovery: "original-text-retained",
          errorCode: undefined,
        });
    } catch {
      /* Unknown state is preserved for explicit review, never retried. */
    }
    return this.journal.transition(id, "acceptance-uncertain", {
      errorCode: "material-acceptance-unconfirmed",
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
  accept(id, proposal) {
    return this.#exclusive(async () => {
      let task = await this.journal.read(id);
      if (task.record.kind !== "material" || !task.snapshot.materialTarget)
        throw new Error("任务不是结构化资料提案");
      if (["accepting", "acceptance-uncertain"].includes(task.record.status)) {
        await this.#reconcile(id);
        task = await this.journal.read(id);
      }
      const {
        record,
        snapshot: { materialTarget: target },
      } = task;
      if (record.status !== "awaiting-review")
        throw new Error("资料任务状态已改变，请重新核对");
      const input = materialProposal(proposal, target.input);
      const current = await this.materials.read(target.bookId, target.id);
      if (
        current.diskHash !== target.diskHash ||
        current.revision !== target.revision ||
        current.deletedAt
      )
        throw new Error(
          "资料在生成后已改变，未覆盖当前版本；请保留候选并重新生成",
        );
      const intent = {
        id: randomUUID(),
        materialId: target.id,
        beforeHash: target.diskHash,
        acceptedHash: hash(input),
        acceptedText: JSON.stringify(proposal),
        preparedAt: new Date().toISOString(),
      };
      await this.journal.transition(id, "accepting", {
        acceptance: intent,
        acceptanceRecovery: undefined,
      });
      await this.checkpoint("intent-written");
      let result;
      try {
        result = await this.materials.save(target.bookId, input, target, {
          ...intent,
          taskId: id,
        });
      } catch (error) {
        await this.#reconcile(id);
        throw new Error("资料接受尚未确认，请核对任务与资料；未自动重试", {
          cause: error,
        });
      }
      await this.checkpoint("material-saved");
      try {
        await this.journal.transition(id, "applied", {
          appliedHash: result.diskHash,
          acceptedText: intent.acceptedText,
          reviewedAt: intent.preparedAt,
        });
      } catch {
        return { material: result, receiptPending: true };
      }
      return { material: result, receiptPending: false };
    });
  }
}
