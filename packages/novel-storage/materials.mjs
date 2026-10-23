import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolveAnchor } from "../novel-domain/anchors.mjs";
import { checkedEvidenceSource } from "./evidence-source.mjs";
import { evidenceInput, validateEvidence } from "../novel-domain/evidence.mjs";
import {
  validateMaterialInput,
  materialKind,
  materialMarkdown,
} from "../novel-domain/materials.mjs";
import { materialContextText } from "../novel-domain/material-context.mjs";
import { contextProof } from "./context-proof.mjs";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
// Evidence-only updates must not recursively invalidate cycles of related characters.
const definitionHash = (data) =>
  hash(JSON.stringify(validateMaterialInput(data)));
export { definitionHash as materialDefinitionHash };
const id = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
    throw new Error("无效的资料标识");
  return value;
};
export class MaterialStore {
  constructor(storage) {
    this.storage = storage;
  }
  async context(bookId) {
    const root = await this.storage.bookRoot(bookId);
    return { root, book: await this.storage.manifest(root) };
  }
  async record(root, materialId) {
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(
      await readFile(
        await this.storage.path(root, `materials/${id(materialId)}.json`),
      ),
    );
    const data = JSON.parse(raw);
    if (
      data.schemaVersion !== 1 ||
      data.id !== materialId ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      typeof data.updatedAt !== "string" ||
      (data.deletedAt !== undefined && typeof data.deletedAt !== "string")
    )
      throw new Error("资料格式损坏或版本不支持，请保留原文件");
    validateMaterialInput(data);
    validateEvidence(data.evidence, data.kind);
    return { data, raw, diskHash: hash(raw) };
  }
  async view(record, book, root) {
    const bodies = new Map();
    // One view holds the shared read queue. Reuse each related definition only
    // within that view; a later read must check the filesystem again.
    const definitions = new Map();
    const evidence = [];
    for (const item of record.data.evidence || []) {
      const chapter = book.chapters.find(
        (chapter) => chapter.id === item.chapterId,
      );
      let resolution = { status: "missing", start: null, end: null },
        freshness = "missing";
      if (chapter && !chapter.deletedAt) {
        if (!bodies.has(chapter.id)) {
          try {
            bodies.set(
              chapter.id,
              await readFile(
                await this.storage.path(
                  root,
                  `manuscript/${id(chapter.id)}.md`,
                ),
                "utf8",
              ),
            );
          } catch {
            bodies.set(chapter.id, null);
          }
        }
        const body = bodies.get(chapter.id);
        if (body !== null) {
          const currentHash = hash(body);
          resolution = resolveAnchor(body, item.anchor, currentHash);
          freshness =
            currentHash === item.anchor.hash && resolution.status === "exact"
              ? "current"
              : "stale";
        }
      }
      const related = [];
      for (const targetId of item.relatedIds) {
        const baseline = item.dependencies?.find(
          (entry) => entry.id === targetId,
        );
        try {
          if (!definitions.has(targetId))
            definitions.set(targetId, this.record(root, targetId));
          const target = await definitions.get(targetId);
          related.push({
            id: targetId,
            title: target.data.title,
            kind: target.data.kind,
            state: target.data.deletedAt ? "deleted" : "active",
            revision: target.data.revision,
            baselineRevision: baseline?.revision ?? null,
            freshness: target.data.deletedAt
              ? "missing"
              : !baseline
                ? "unknown"
                : baseline.definitionHash === definitionHash(target.data)
                  ? "current"
                  : "stale",
          });
        } catch {
          related.push({
            id: targetId,
            title: "资料不可读取",
            state: "missing",
            baselineRevision: baseline?.revision ?? null,
            freshness: "missing",
          });
        }
      }
      evidence.push({
        ...item,
        chapterTitle: chapter?.title || "章节不存在",
        resolution,
        sourceFreshness: freshness,
        freshness:
          freshness === "current" &&
          related.some((entry) => entry.freshness !== "current")
            ? "stale"
            : freshness,
        related,
      });
    }
    return {
      ...record.data,
      evidence,
      diskHash: record.diskHash,
      chapters: record.data.chapterIds.map((chapterId) => {
        const chapter = book.chapters.find(
          (chapter) => chapter.id === chapterId,
        );
        return {
          id: chapterId,
          title: chapter?.title || "章节不存在",
          state: !chapter
            ? "missing"
            : chapter.deletedAt
              ? "deleted"
              : "active",
        };
      }),
    };
  }
  read(bookId, materialId) {
    return this.storage.exclusive(async () => {
      const { root, book } = await this.context(bookId);
      return this.view(await this.record(root, materialId), book, root);
    });
  }
  async list(bookId, options = {}) {
    const { kind = "", query = "", deleted = false, offset = 0 } = options;
    if (kind) materialKind(kind);
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      typeof deleted !== "boolean" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("资料检索条件无效");
    const items = [],
      needle = query.toLocaleLowerCase();
    const errors = await this.scan(bookId, (data) => {
      if (!!data.deletedAt !== deleted || (kind && data.kind !== kind)) return;
      if (
        needle &&
        ![data.title, data.notes, ...Object.values(data.fields)]
          .join("\n")
          .toLocaleLowerCase()
          .includes(needle)
      )
        return;
      items.push({
        id: data.id,
        kind: data.kind,
        title: data.title,
        status: data.status,
        revision: data.revision,
        updatedAt: data.updatedAt,
        deletedAt: data.deletedAt,
      });
    });
    items.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    return {
      items: items.slice(offset, offset + 40),
      total: items.length,
      errors,
    };
  }
  // Internal visitor is synchronous and receives validated data, never IPC input.
  async scan(bookId, visit, { signal } = {}) {
    signal?.throwIfAborted();
    const { root, entries } = await this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      try {
        const entries = await readdir(
          await this.storage.path(root, "materials"),
          {
            withFileTypes: true,
          },
        );
        return {
          root,
          entries: entries.filter((entry) => entry.name.endsWith(".json")),
        };
      } catch (error) {
        if (error.code === "ENOENT") return { root, entries: [] };
        throw error;
      }
    });
    const errors = [];
    // Bound each read transaction so queued manuscript saves run between batches.
    // Listings may span revisions; opening and AI snapshots still reread under one lock.
    for (let offset = 0; offset < entries.length; offset += 32) {
      signal?.throwIfAborted();
      await this.storage.exclusive(async () => {
        signal?.throwIfAborted();
        await this.storage.bookRoot(bookId);
        await this.storage.recover(root);
        await Promise.all(
          entries.slice(offset, offset + 32).map(async (entry) => {
            try {
              visit((await this.record(root, entry.name.slice(0, -5))).data);
            } catch {
              errors.push("一份资料无法读取，原始文件已保留");
            }
          }),
        );
      });
    }
    signal?.throwIfAborted();
    return errors;
  }
  save(bookId, input, expected = null, acceptance = null) {
    return this.storage.exclusive(async () => {
      const { root, book } = await this.context(bookId),
        data = validateMaterialInput(input);
      const previous = expected
        ? await this.record(root, id(expected.id))
        : null;
      if (
        previous &&
        (previous.data.revision !== expected.revision ||
          previous.diskHash !== expected.diskHash)
      )
        throw new Error(
          "资料已被其他操作或外部编辑修改。当前调整已保留，请重新读取后对照。",
        );
      if (previous?.data.deletedAt) throw new Error("请先恢复回收站资料再编辑");
      if (previous && previous.data.kind !== data.kind)
        throw new Error("已保存资料不能改变类型，请新建另一份资料");
      for (const chapterId of data.chapterIds) {
        // Preserve broken historical references visibly; never create new references to deleted/missing chapters.
        if (
          !previous?.data.chapterIds.includes(chapterId) &&
          !book.chapters.some(
            (chapter) => chapter.id === chapterId && !chapter.deletedAt,
          )
        )
          throw new Error("关联章节不存在于当前作品或已删除");
      }
      const next = {
        schemaVersion: 1,
        id: previous?.data.id || randomUUID(),
        revision: (previous?.data.revision || 0) + 1,
        ...data,
        evidence: previous?.data.evidence || [],
        createdAt: previous?.data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      let receipt = null;
      if (acceptance) {
        if (
          !previous ||
          acceptance.beforeHash !== previous.diskHash ||
          acceptance.materialId !== previous.data.id ||
          acceptance.acceptedHash !== hash(JSON.stringify(data))
        )
          throw new Error("资料接受回执与当前版本不一致");
        id(acceptance.id);
        id(acceptance.taskId);
        receipt = {
          schemaVersion: 1,
          ...acceptance,
          afterHash: hash(json(next)),
        };
      }
      await this.commit(root, next, previous, receipt);
      return this.view({ data: next, diskHash: hash(json(next)) }, book, root);
    });
  }
  async commit(root, next, previous, receipt = null) {
    const changes = { [`materials/${next.id}.json`]: json(next) };
    if (previous)
      changes[
        `.zinovel/material-history/${next.id}/${previous.data.revision}-${previous.diskHash}.json`
      ] = previous.raw;
    if (receipt)
      changes[`.zinovel/material-acceptance/${receipt.id}.json`] =
        json(receipt);
    await this.storage.transaction(root, changes);
  }
  acceptanceReceipt(bookId, acceptanceId) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      try {
        return JSON.parse(
          await readFile(
            await this.storage.path(
              root,
              `.zinovel/material-acceptance/${id(acceptanceId)}.json`,
            ),
            "utf8",
          ),
        );
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  setDeleted(bookId, expected, deleted) {
    return this.storage.exclusive(async () => {
      if (typeof deleted !== "boolean") throw new Error("回收站操作无效");
      const { root, book } = await this.context(bookId),
        previous = await this.record(root, id(expected.id));
      if (
        previous.data.revision !== expected.revision ||
        previous.diskHash !== expected.diskHash
      )
        throw new Error("资料已经改变，请重新读取");
      const next = {
        ...previous.data,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (deleted) next.deletedAt = new Date().toISOString();
      else delete next.deletedAt;
      await this.commit(root, next, previous);
      return this.view({ data: next, diskHash: hash(json(next)) }, book, root);
    });
  }
  contextPack(bookId, materialIds) {
    return this.storage.exclusive(async () => {
      if (
        !Array.isArray(materialIds) ||
        materialIds.length > 8 ||
        new Set(materialIds).size !== materialIds.length
      )
        throw new Error("请选择最多 8 份不同资料");
      const { root, book } = await this.context(bookId),
        materials = [],
        cache = new Map();
      for (const materialId of materialIds) {
        const record = await this.record(root, id(materialId));
        if (record.data.deletedAt)
          throw new Error("所选资料已移入回收站，请调整选择");
        const view = await this.view(record, book, root);
        materials.push({
          id: view.id,
          title: view.title,
          kind: view.kind,
          revision: view.revision,
          diskHash: view.diskHash,
          content: materialMarkdown(view),
          proofHash: await contextProof(
            this.storage,
            root,
            book,
            record.data,
            record.diskHash,
            null,
            cache,
          ),
        });
      }
      const pack = { schemaVersion: 1, bookId, materials };
      const text = materialContextText(pack);
      return {
        ...pack,
        characters: text.length,
        hash: hash(json(pack)),
        truncated: false,
      };
    });
  }
  mutateEvidence(bookId, expected, mutation) {
    return this.storage.exclusive(async () => {
      const { root, book } = await this.context(bookId),
        previous = await this.record(root, id(expected.id));
      if (
        previous.data.revision !== expected.revision ||
        previous.diskHash !== expected.diskHash
      )
        throw new Error("资料已改变，请先重新读取再绑定证据");
      if (previous.data.deletedAt) throw new Error("请先恢复资料");
      const records = structuredClone(previous.data.evidence || []);
      const existing = mutation.eventId
        ? records.find((item) => item.id === id(mutation.eventId))
        : null;
      if (!["add", "reconfirm", "retire"].includes(mutation.action))
        throw new Error("证据操作无效");
      if (mutation.action !== "add" && !existing) throw new Error("证据不存在");
      if (mutation.action === "retire") {
        existing.status = "retired";
        existing.updatedAt = new Date().toISOString();
      } else {
        if (mutation.action === "add" && records.length >= 250)
          throw new Error("单份资料最多 250 条证据，请拆分资料");
        const data = evidenceInput(
          mutation.action === "reconfirm" ? existing : mutation,
          previous.data.kind,
        );
        const dependencies = [];
        for (const targetId of data.relatedIds) {
          if (targetId === previous.data.id)
            throw new Error("关联对象应为另一份资料");
          const target = await this.record(root, targetId);
          if (target.data.deletedAt)
            throw new Error("关联资料已删除，请先恢复");
          dependencies.push({
            id: targetId,
            revision: target.data.revision,
            definitionHash: definitionHash(target.data),
          });
        }
        const { chapterId, anchor } = await checkedEvidenceSource(
          this.storage,
          root,
          book,
          mutation.source,
        );
        const record = {
          ...data,
          id: existing?.id || randomUUID(),
          chapterId,
          anchor,
          dependencies,
          status: "active",
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (existing) records[records.indexOf(existing)] = record;
        else records.push(record);
      }
      const next = {
        ...previous.data,
        evidence: records,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      validateEvidence(records, next.kind);
      await this.commit(root, next, previous);
      return this.view({ data: next, diskHash: hash(json(next)) }, book, root);
    });
  }
  history(bookId, materialId) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      await this.record(root, materialId);
      const path = `.zinovel/material-history/${id(materialId)}`;
      let names;
      try {
        names = await readdir(await this.storage.path(root, path));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const history = [];
      for (const name of names
        .filter((name) => /^\d+-[a-f0-9]{64}\.json$/.test(name))
        .sort((a, b) => parseInt(b) - parseInt(a))
        .slice(0, 40)) {
        const raw = await readFile(
          await this.storage.path(root, `${path}/${name}`),
          "utf8",
        );
        if (hash(raw) !== name.slice(name.indexOf("-") + 1, -5))
          throw new Error("历史资料校验失败，请保留原文件");
        const data = JSON.parse(raw);
        if (data.id !== materialId || data.schemaVersion !== 1)
          throw new Error("历史资料身份无效");
        validateMaterialInput(data);
        validateEvidence(data.evidence, data.kind);
        history.push(data);
      }
      return history;
    });
  }
}
