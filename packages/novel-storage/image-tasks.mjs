import { lstat, open, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { decodeUtf8, readUtf8File } from "./encoding.mjs";
import { binaryHash, copyImageBytes } from "./image-decoder.mjs";
import { assetId, assetHash, assetInput } from "../novel-domain/assets.mjs";
import { assetCreationHash } from "../novel-domain/asset-creation-hash.mjs";
import { imageGenerationLimits } from "../novel-domain/image-generation.mjs";
import {
  imageTaskInput,
  imageTaskCreationHash,
  imageTaskOutcome,
  imageTaskResponseHash,
  validateImageTask,
} from "../novel-domain/image-tasks.mjs";

const MAX_RECORD = 256 * 1024,
  MAX_TASKS = 1000;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const taskPath = (id) => `.zinovel/image-tasks/${assetId(id)}.json`;
const expectedValue = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["id", "revision", "diskHash"].includes(key),
    ) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error("请重新打开图像任务核对修订");
  return {
    id: assetId(value.id),
    revision: value.revision,
    diskHash: assetHash(value.diskHash),
  };
};

/** Book-local image ledger. Every mutation uses the injected unique book kernel.
 * No network, automatic retry or independent writer is created here.
 */
export class ImageTaskStore {
  #active = new Set();
  #receiving = new Set();
  constructor(storage, assets, materials) {
    if (assets.storage !== storage || materials.storage !== storage)
      throw new Error("图像任务必须共享唯一作品写入内核");
    this.storage = storage;
    this.assets = assets;
    this.materials = materials;
  }
  context(bookId) {
    return this.assets.context(bookId);
  }
  async record(ctx, id) {
    const path = await this.storage.path(ctx.root, taskPath(id)),
      stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD)
      throw new Error("图像任务文件无效或过大，原文件已保留");
    const file = await open(path, "r"),
      buffer = Buffer.alloc(MAX_RECORD + 1);
    let count = 0;
    try {
      while (count < buffer.length) {
        const chunk = await file.read(
          buffer,
          count,
          buffer.length - count,
          count,
        );
        if (!chunk.bytesRead) break;
        count += chunk.bytesRead;
      }
    } finally {
      await file.close();
    }
    if (count > MAX_RECORD) throw new Error("图像任务读取时超限，原文件已保留");
    const bytes = buffer.subarray(0, count),
      raw = decodeUtf8(bytes),
      data = JSON.parse(raw);
    validateImageTask(data, id, ctx.origins);
    return { data, raw, diskHash: binaryHash(bytes) };
  }
  view(ctx, record) {
    const own = record.data.bookId === ctx.book.id,
      active = this.#active.has(`${ctx.book.id}/${record.data.id}`);
    return {
      ...structuredClone(record.data),
      status:
        record.data.status === "send-intent"
          ? own && active
            ? "sending"
            : "remote-unknown"
          : record.data.status === "receive-intent"
            ? this.#receiving.has(`${ctx.book.id}/${record.data.id}`)
              ? "saving-candidates"
              : "received-pending-check"
            : record.data.status,
      storedStatus: record.data.status,
      diskHash: record.diskHash,
      restoredSource: !own,
      dispatchState: record.data.candidates.length
        ? "response-received"
        : record.data.outcome?.dispatched === true
          ? "attempted"
          : record.data.outcome?.dispatched === false
            ? "not-sent"
            : record.data.attemptId
              ? "unknown"
              : "not-sent",
    };
  }
  async current(ctx, expected) {
    const checked = expectedValue(expected),
      record = await this.record(ctx, checked.id);
    if (
      record.data.revision !== checked.revision ||
      record.diskHash !== checked.diskHash
    )
      throw new Error("图像任务已改变，请保留当前调整并刷新");
    return record;
  }
  async commit(ctx, next, previous) {
    validateImageTask(next, next.id, ctx.origins);
    const raw = json(next);
    if (Buffer.byteLength(raw) > MAX_RECORD)
      throw new Error("图像任务记录超限，未覆盖原记录");
    await this.storage.transaction(
      ctx.root,
      { [taskPath(next.id)]: raw },
      { expectedBefore: { [taskPath(next.id)]: previous?.raw ?? null } },
    );
    return { data: next, raw, diskHash: binaryHash(Buffer.from(raw)) };
  }
  async target(ctx, target) {
    if (ctx.book.deletedAt || ctx.book.archivedAt)
      throw new Error("作品已回收或归档，未发送图像请求");
    if (target.material) {
      const record = await this.materials.record(ctx.root, target.material.id);
      if (
        record.data.deletedAt ||
        record.data.revision !== target.material.revision ||
        record.diskHash !== target.material.diskHash
      )
        throw new Error("图像目标资料已改变，请重新核对");
      if (target.purpose === "portrait" && record.data.kind !== "character")
        throw new Error("人物定妆只能关联明确的角色资料");
    }
    if (target.chapter) {
      const chapter = ctx.book.chapters.find(
        (item) => item.id === target.chapter.id && !item.deletedAt,
      );
      if (!chapter || chapter.revision !== target.chapter.revision)
        throw new Error("图像目标章节已改变");
      const raw = await readUtf8File(
        await this.storage.path(ctx.root, `manuscript/${chapter.id}.md`),
      );
      if (binaryHash(Buffer.from(raw)) !== target.chapter.diskHash)
        throw new Error("图像目标正文已改变");
    }
  }
  async names(ctx) {
    try {
      return await readdir(
        await this.storage.path(ctx.root, ".zinovel/image-tasks"),
        { withFileTypes: true },
      );
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async create(bookId, input) {
    const captured = imageTaskInput(input);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        creationHash = imageTaskCreationHash(bookId, captured);
      let existing;
      try {
        existing = await this.record(ctx, captured.id);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing) {
        if (existing.data.creationHash !== creationHash)
          throw new Error("该图像任务身份已有其他输入");
        return this.view(ctx, existing);
      }
      if ((await this.names(ctx)).length >= MAX_TASKS)
        throw new Error("作品图像任务达到当前保护上限，未发送请求");
      await this.target(ctx, captured.target);
      const at = new Date().toISOString();
      return this.view(
        ctx,
        await this.commit(
          ctx,
          {
            format: "zinovel-image-task",
            schemaVersion: 1,
            bookId,
            creationHash,
            ...captured,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            status: "prepared",
            candidates: [],
            usage: null,
            interruptedAfterResponse: false,
          },
          null,
        ),
      );
    });
  }
  read(bookId, id) {
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      return this.view(ctx, await this.record(ctx, assetId(id)));
    });
  }
  async markSending(bookId, expected) {
    const requested = expectedValue(expected);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, requested);
      if (
        previous.data.bookId !== bookId ||
        previous.data.status !== "prepared"
      )
        throw new Error("图像任务不是当前作品的待发送任务，不会自动重试");
      await this.target(ctx, previous.data.target);
      const next = {
        ...previous.data,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
        status: "send-intent",
        attemptId: randomUUID(),
      };
      const saved = await this.commit(ctx, next, previous);
      this.#active.add(`${bookId}/${next.id}`);
      return this.view(ctx, saved);
    });
  }
  async receive(bookId, expected, attemptId, response) {
    assetId(bookId);
    assetId(attemptId);
    const requested = expectedValue(expected);
    if (
      !response ||
      !Array.isArray(response.candidates) ||
      response.candidates.length < 1 ||
      response.candidates.length > imageGenerationLimits.count ||
      typeof response.interruptedAfterResponse !== "boolean"
    )
      throw new Error("图像返回清单无效");
    const capturedUsage = structuredClone(response.usage ?? null),
      interrupted = response.interruptedAfterResponse;
    const captured = response.candidates.map((item) => {
      const bytes = copyImageBytes(item.bytes);
      if (bytes.length > imageGenerationLimits.imageBytes)
        throw new Error("图像候选超过生成上限");
      if (
        item.revisedPrompt !== undefined &&
        (typeof item.revisedPrompt !== "string" ||
          !item.revisedPrompt.isWellFormed() ||
          item.revisedPrompt.length > imageGenerationLimits.prompt)
      )
        throw new Error("图像候选说明无效");
      return { bytes, revisedPrompt: item.revisedPrompt };
    });
    const initial = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        record = await this.current(ctx, requested);
      if (
        record.data.bookId !== bookId ||
        !["send-intent", "receive-intent"].includes(record.data.status) ||
        record.data.attemptId !== assetId(attemptId) ||
        (record.data.status === "send-intent" &&
          !this.#active.has(`${bookId}/${record.data.id}`))
      )
        throw new Error("图像返回与当前发送会话不符");
      return record.data;
    });
    if (captured.length !== initial.request.n)
      throw new Error("图像返回清单无效");
    const key = `${bookId}/${requested.id}`;
    if (this.#receiving.has(key))
      throw new Error("候选正在保存，请等待当前操作");
    this.#receiving.add(key);
    let receiptSaved = false;
    try {
      const decoded = [];
      for (const item of captured)
        decoded.push({
          image: await this.assets.decode(item.bytes, undefined, {
            wait: true,
          }),
          revisedPrompt: item.revisedPrompt,
        });
      return await this.storage.exclusive(async () => {
        const ctx = await this.context(bookId),
          previous = await this.current(ctx, requested);
        if (
          !["send-intent", "receive-intent"].includes(previous.data.status) ||
          previous.data.attemptId !== attemptId
        )
          throw new Error("图像返回状态已改变，未覆盖记录");
        const candidates = decoded.map((item, index) => ({
          index,
          blob: item.image.blob,
          decision: "pending",
          assetId: randomUUID(),
          ...(item.revisedPrompt !== undefined
            ? { revisedPrompt: item.revisedPrompt }
            : {}),
        }));
        const next = {
          ...previous.data,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
          status: "receive-intent",
          candidates,
          usage: capturedUsage,
          interruptedAfterResponse: interrupted,
        };
        let receipt;
        if (previous.data.status === "send-intent") {
          next.responseHash = imageTaskResponseHash(next);
          receipt = await this.commit(ctx, next, previous);
        } else {
          for (let index = 0; index < decoded.length; index++) {
            const expectedBlob = previous.data.candidates[index].blob,
              actual = decoded[index].image.blob;
            if (
              Object.keys(expectedBlob).some(
                (field) => expectedBlob[field] !== actual[field],
              )
            )
              throw new Error("重试保存的图像与已记录回执不符，未覆盖候选");
          }
          receipt = previous;
        }
        receiptSaved = true;
        for (const item of decoded) await this.assets.putBlob(ctx, item.image);
        const saved = await this.commit(
          ctx,
          {
            ...receipt.data,
            status: "received",
            revision: receipt.data.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          receipt,
        );
        return this.view(ctx, saved);
      });
    } finally {
      this.#receiving.delete(key);
      if (receiptSaved) this.#active.delete(key);
    }
  }
  async reconcileReceived(bookId, expected) {
    const requested = expectedValue(expected),
      key = `${assetId(bookId)}/${requested.id}`;
    const captured = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        record = await this.current(ctx, requested);
      if (!["receive-intent", "received"].includes(record.data.status))
        throw new Error("该任务没有已返回图像的本地回执");
      if (this.#receiving.has(key)) throw new Error("候选仍在保存，请稍后核对");
      const images = [],
        issues = [];
      for (const candidate of record.data.candidates) {
        try {
          images.push({
            index: candidate.index,
            bytes: await this.assets.blobBytes(ctx, candidate.blob),
            blob: candidate.blob,
          });
        } catch {
          issues.push({
            index: candidate.index,
            message: "候选原图尚未保存或校验失败，未伪报完成",
          });
        }
      }
      return { images, issues, task: this.view(ctx, record) };
    });
    if (captured.issues.length)
      return {
        status: "incomplete",
        task: captured.task,
        issues: captured.issues,
      };
    this.#receiving.add(key);
    try {
      for (const image of captured.images) {
        const decoded = await this.assets.decode(image.bytes, undefined, {
          wait: true,
        });
        if (
          Object.keys(image.blob).some(
            (field) => image.blob[field] !== decoded.blob[field],
          )
        )
          throw new Error("候选实际图像与接收回执不符");
      }
      return await this.storage.exclusive(async () => {
        const ctx = await this.context(bookId),
          previous = await this.current(ctx, requested);
        if (previous.data.status === "received")
          return {
            status: "received",
            task: this.view(ctx, previous),
            issues: [],
          };
        const saved = await this.commit(
          ctx,
          {
            ...previous.data,
            status: "received",
            revision: previous.data.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          previous,
        );
        return { status: "received", task: this.view(ctx, saved), issues: [] };
      });
    } finally {
      this.#receiving.delete(key);
      this.#active.delete(key);
    }
  }
  async finishFailure(bookId, expected, outcome) {
    const captured = imageTaskOutcome(outcome),
      requested = expectedValue(expected);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, requested);
      if (
        previous.data.bookId !== bookId ||
        !["prepared", "send-intent"].includes(previous.data.status) ||
        (previous.data.status === "prepared" && captured.dispatched)
      )
        throw new Error("图像任务状态与失败事实不符");
      if (
        previous.data.status === "send-intent" &&
        !this.#active.has(`${bookId}/${previous.data.id}`) &&
        (!captured.dispatched || captured.remoteResult !== "unknown")
      )
        throw new Error("重启后的发送结果未知，不能伪报未发送或确定失败");
      const status =
        captured.remoteResult === "unknown"
          ? "unknown"
          : !captured.dispatched && captured.code === "CANCELLED"
            ? "cancelled"
            : "failed";
      const saved = await this.commit(
        ctx,
        {
          ...previous.data,
          status,
          outcome: captured,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
      this.#active.delete(`${bookId}/${previous.data.id}`);
      return this.view(ctx, saved);
    });
  }
  async discard(bookId, expected) {
    const requested = expectedValue(expected);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, requested);
      if (this.#receiving.has(`${bookId}/${previous.data.id}`))
        throw new Error("候选正在保存，不能中断本地落盘");
      if (
        previous.data.status === "send-intent" &&
        this.#active.has(`${bookId}/${previous.data.id}`)
      )
        throw new Error(
          "请先核对已发送或未知结果，不能把进行中任务当作未发送放弃",
        );
      if (previous.data.status === "discarded") return this.view(ctx, previous);
      const next = {
        ...previous.data,
        status: "discarded",
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
        candidates: previous.data.candidates.map((item) => ({
          ...item,
          decision: item.decision === "accepted" ? "accepted" : "discarded",
        })),
      };
      return this.view(ctx, await this.commit(ctx, next, previous));
    });
  }
  async adopt(bookId, expected, index, input) {
    const requested = expectedValue(expected),
      data = assetInput(input);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= imageGenerationLimits.count
    )
      throw new Error("图像候选不存在");
    const capture = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, requested),
        item = previous.data.candidates[index];
      if (
        previous.data.status !== "received" ||
        !item ||
        item.decision === "discarded"
      )
        throw new Error("请先完成候选本地核对，已放弃任务不能采用");
      if (
        data.purpose !== previous.data.target.purpose ||
        (previous.data.target.material &&
          !data.linkedIds.includes(previous.data.target.material.id))
      )
        throw new Error("采用用途或关联人物与已确认目标不符");
      if (item.decision === "accepted") {
        if (
          assetCreationHash(
            item.assetId,
            item.adoption.bookId,
            data,
            item.blob,
          ) !== item.adoption.creationHash
        )
          throw new Error("该候选已经按另一份说明采用，请编辑现有资源");
        // Receipt lookup only. Never recreate a removed resource or overwrite later edits.
        const asset = await this.assets.record(ctx, item.assetId);
        if (asset.data.creationHash !== item.adoption.creationHash)
          throw new Error("已采用资源身份不符，请保留原文件");
        return {
          result: {
            task: this.view(ctx, previous),
            asset: this.assets.view(asset),
            alreadyAccepted: true,
          },
        };
      }
      await this.target(ctx, previous.data.target);
      return {
        bytes: await this.assets.blobBytes(ctx, item.blob),
        blob: item.blob,
      };
    });
    if (capture.result) return capture.result;
    const image = await this.assets.decode(capture.bytes);
    if (
      Object.keys(capture.blob).some(
        (field) => capture.blob[field] !== image.blob[field],
      )
    )
      throw new Error("候选实际图像与接收回执不符");
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, requested),
        item = previous.data.candidates[index];
      await this.target(ctx, previous.data.target);
      // Check bytes again after decoding outside the queue; external edits cannot be hidden by a cached preview.
      await this.assets.blobBytes(ctx, item.blob);
      const prepared = await this.assets.prepareImport(
        ctx,
        image,
        data,
        item.assetId,
      );
      if (prepared.existing)
        throw new Error("候选预留身份已有资源，请保留文件并核对采用记录");
      const next = structuredClone(previous.data);
      next.revision++;
      next.updatedAt = new Date().toISOString();
      next.candidates[index].decision = "accepted";
      next.candidates[index].adoption = {
        bookId,
        input: data,
        creationHash: prepared.next.creationHash,
        adoptedAt: next.updatedAt,
      };
      validateImageTask(next, next.id, ctx.origins);
      const raw = json(next),
        path = taskPath(next.id);
      if (Buffer.byteLength(raw) > MAX_RECORD)
        throw new Error("图像采用说明超限，未覆盖原记录");
      // The kernel journal commits both records together. Recovery completes the exact confirmed adoption without network.
      await this.storage.transaction(
        ctx.root,
        { [prepared.path]: prepared.raw, [path]: raw },
        { expectedBefore: { [prepared.path]: null, [path]: previous.raw } },
      );
      return {
        task: this.view(ctx, {
          data: next,
          raw,
          diskHash: binaryHash(Buffer.from(raw)),
        }),
        asset: this.assets.view({
          data: prepared.next,
          diskHash: binaryHash(Buffer.from(prepared.raw)),
        }),
        alreadyAccepted: false,
      };
    });
  }
  async preview(bookId, id, index) {
    const captured = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        record = await this.record(ctx, assetId(id));
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= record.data.candidates.length
      )
        throw new Error("图像候选不存在");
      const candidate = record.data.candidates[index];
      return {
        bytes: await this.assets.blobBytes(ctx, candidate.blob),
        blob: candidate.blob,
        diskHash: record.diskHash,
      };
    });
    const decoded = await this.assets.decode(captured.bytes);
    if (
      Object.keys(captured.blob).some(
        (field) => captured.blob[field] !== decoded.blob[field],
      )
    )
      throw new Error("候选实际图像与接收回执不符");
    return {
      blob: captured.blob,
      diskHash: captured.diskHash,
      thumbnail: decoded.thumbnail,
    };
  }
  async list(bookId, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TASKS)
      throw new Error("图像任务分页无效");
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        names = await this.names(ctx),
        tasks = [],
        errors = [];
      if (names.length > MAX_TASKS)
        throw new Error("图像任务清单超限，原文件已保留");
      for (const entry of names) {
        if (!entry.name.endsWith(".json")) continue;
        try {
          const id = assetId(entry.name.slice(0, -5));
          if (!entry.isFile() || entry.isSymbolicLink())
            throw new Error("invalid record");
          const value = this.view(ctx, await this.record(ctx, id));
          tasks.push({
            id,
            status: value.status,
            revision: value.revision,
            diskHash: value.diskHash,
            purpose: value.target.purpose,
            createdAt: value.createdAt,
            candidateCount: value.candidates.length,
            restoredSource: value.restoredSource,
          });
        } catch {
          errors.push({ message: "有图像任务不能读取，原文件已保留" });
        }
      }
      tasks.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
      return {
        tasks: tasks.slice(offset, offset + 40),
        total: tasks.length,
        errors,
        offset,
        limit: 40,
      };
    });
  }
}
