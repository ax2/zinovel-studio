import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import {
  validateMaterialInput,
  materialKind,
} from "../novel-domain/materials.mjs";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
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
    const raw = await readFile(
      await this.storage.path(root, `materials/${id(materialId)}.json`),
      "utf8",
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
    return { data, raw, diskHash: hash(raw) };
  }
  view(record, book) {
    return {
      ...record.data,
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
      return this.view(await this.record(root, materialId), book);
    });
  }
  list(bookId, options = {}) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
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
      let entries;
      try {
        entries = await readdir(await this.storage.path(root, "materials"), {
          withFileTypes: true,
        });
      } catch (error) {
        if (error.code === "ENOENT") return { items: [], total: 0, errors: [] };
        throw error;
      }
      const items = [],
        errors = [],
        needle = query.toLocaleLowerCase();
      for (const entry of entries) {
        if (!entry.name.endsWith(".json")) continue;
        try {
          const record = await this.record(root, entry.name.slice(0, -5)),
            data = record.data;
          if (!!data.deletedAt !== deleted || (kind && data.kind !== kind))
            continue;
          if (
            needle &&
            ![data.title, data.notes, ...Object.values(data.fields)]
              .join("\n")
              .toLocaleLowerCase()
              .includes(needle)
          )
            continue;
          items.push({
            id: data.id,
            kind: data.kind,
            title: data.title,
            status: data.status,
            revision: data.revision,
            updatedAt: data.updatedAt,
            deletedAt: data.deletedAt,
          });
        } catch {
          errors.push("一份资料无法读取，原始文件已保留");
        }
      }
      items.sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
      return {
        items: items.slice(offset, offset + 40),
        total: items.length,
        errors,
      };
    });
  }
  save(bookId, input, expected = null) {
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
        createdAt: previous?.data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.commit(root, next, previous);
      return this.view({ data: next, diskHash: hash(json(next)) }, book);
    });
  }
  async commit(root, next, previous) {
    const changes = { [`materials/${next.id}.json`]: json(next) };
    if (previous)
      changes[
        `.zinovel/material-history/${next.id}/${previous.data.revision}-${previous.diskHash}.json`
      ] = previous.raw;
    await this.storage.transaction(root, changes);
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
      return this.view({ data: next, diskHash: hash(json(next)) }, book);
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
        history.push(data);
      }
      return history;
    });
  }
}
