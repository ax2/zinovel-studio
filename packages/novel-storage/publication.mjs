import { readdir, readFile, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { decodeUtf8, readUtf8File } from "./encoding.mjs";
import {
  makePublicationSnapshot,
  verifyPublicationSnapshot,
  publicationMetadata,
} from "../novel-domain/publication.mjs";

const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const fileOf = (id) => {
  if (!uuid(id)) throw new Error("发布快照身份无效");
  return `.zinovel/publications/${id}.json`;
};

/** A restored book keeps immutable snapshot provenance instead of rewriting its content hash. */
export function publicationOriginIds(book) {
  const inherited = book.restoredFromBookIds ?? [];
  if (
    !uuid(book.id) ||
    !Array.isArray(inherited) ||
    inherited.length > 128 ||
    inherited.some((id) => !uuid(id) || id === book.id) ||
    new Set(inherited).size !== inherited.length
  )
    throw new Error("作品恢复来源链无效，原记录已保留");
  return [book.id, ...inherited];
}

export class PublicationStore {
  constructor(
    storage,
    reader,
    { batchSize = 16, maxBytes = 32 * 1024 * 1024 } = {},
  ) {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 64 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error("快照容量或批量设置无效");
    this.storage = storage;
    this.reader = reader;
    this.batchSize = batchSize;
    this.maxBytes = maxBytes;
  }
  async book(root, bookId) {
    const book = await this.storage.manifest(root);
    if (book.id !== bookId) throw new Error("作品目录身份不符，原文件已保留");
    publicationOriginIds(book);
    return book;
  }
  projection(book) {
    const projected = this.reader.projection(book);
    const volumeIds = new Set(projected.volumes.map((volume) => volume.id));
    const savedHashes = new Map(
      book.chapters.map((chapter) => [chapter.id, chapter.hash]),
    );
    const source = {
      schemaVersion: 1,
      bookId: book.id,
      bookRevision: book.revision,
      title: book.title,
      author: book.author || "",
      chapters: projected.chapters.map((chapter) => {
        if (!uuid(chapter.id))
          throw new Error("发布章节身份无效，原目录已保留");
        if (chapter.volumeId && !volumeIds.has(chapter.volumeId))
          throw new Error("发布章节分卷失联，请先修复目录");
        const savedHash = savedHashes.get(chapter.id);
        if (!validHash(savedHash))
          throw new Error("发布章节保存hash无效，原目录已保留");
        return { ...chapter, savedHash };
      }),
    };
    return { ...source, hash: digest(JSON.stringify(source)) };
  }
  catalog(bookId) {
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId);
      return this.projection(await this.book(root, bookId));
    });
  }
  async capture(bookId, input, { signal, onProgress, onCommitting } = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 3 ||
      Object.keys(input).some(
        (key) => !["catalogHash", "chapterIds", "metadata"].includes(key),
      ) ||
      !validHash(input.catalogHash) ||
      !Array.isArray(input.chapterIds) ||
      !input.chapterIds.length ||
      input.chapterIds.length > 10000 ||
      input.chapterIds.some((id) => !uuid(id)) ||
      new Set(input.chapterIds).size !== input.chapterIds.length
    )
      throw new Error("请选择有效且不重复的发布章节与目录基线");
    const metadata = publicationMetadata(input.metadata);
    const expectedCatalogHash = input.catalogHash,
      chapterIds = [...input.chapterIds];
    let bytes = Buffer.byteLength(json(metadata));
    const ensureBudget = () => {
      if (bytes > this.maxBytes)
        throw new Error("出版文本快照超过当前容量限制，原稿未作修改");
    };
    ensureBudget();
    signal?.throwIfAborted();
    const catalog = await this.catalog(bookId);
    if (catalog.hash !== expectedCatalogHash)
      throw new Error("出版目录已改变，请刷新后重新冻结");
    const members = new Map(
      catalog.chapters.map((chapter) => [chapter.id, chapter]),
    );
    const selected = chapterIds.map((id) => {
      const item = members.get(id);
      if (!item) throw new Error("发布章节不属于当前作品有效范围");
      return item;
    });
    const readBatch = (items) =>
      this.storage.exclusive(async () => {
        signal?.throwIfAborted();
        const root = await this.storage.bookRoot(bookId);
        if (
          this.projection(await this.book(root, bookId)).hash !== catalog.hash
        )
          throw new Error("出版目录已改变，请重新冻结");
        const result = [];
        for (const item of items) {
          signal?.throwIfAborted();
          const path = await this.storage.path(
            root,
            `manuscript/${item.id}.md`,
          );
          if ((await stat(path)).size > this.maxBytes)
            throw new Error("正文超过当前快照容量限制，原稿未改动");
          const body = await readUtf8File(path);
          result.push({
            id: item.id,
            title: item.title,
            volumeTitle: item.volumeId ? item.volumeTitle : "",
            revision: item.revision,
            savedHash: item.savedHash,
            bodyHash: digest(body),
            body,
          });
        }
        return result;
      });
    const chapters = [];
    for (let offset = 0; offset < selected.length; offset += this.batchSize) {
      const batch = await readBatch(
        selected.slice(offset, offset + this.batchSize),
      );
      for (const chapter of batch) {
        bytes += Buffer.byteLength(chapter.body);
        ensureBudget();
        chapters.push(chapter);
      }
      await onProgress?.({
        phase: "capturing",
        completed: chapters.length,
        total: selected.length,
      });
      signal?.throwIfAborted();
    }
    for (let offset = 0; offset < selected.length; offset += this.batchSize) {
      const batch = await readBatch(
        selected.slice(offset, offset + this.batchSize),
      );
      if (
        batch.some(
          (chapter, index) =>
            chapter.bodyHash !== chapters[offset + index].bodyHash,
        )
      )
        throw new Error("冻结期间正文已改变，未保存快照，请重新捕获");
      await onProgress?.({
        phase: "verifying",
        completed: Math.min(offset + this.batchSize, selected.length),
        total: selected.length,
      });
      signal?.throwIfAborted();
    }
    const snapshot = makePublicationSnapshot({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      bookId,
      bookRevision: catalog.bookRevision,
      metadata,
      chapters,
    });
    const serialized = json(snapshot);
    if (Buffer.byteLength(serialized) > this.maxBytes)
      throw new Error("出版文本快照超过当前容量限制，未创建快照");
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId);
      if (this.projection(await this.book(root, bookId)).hash !== catalog.hash)
        throw new Error("提交前出版目录已改变，请重新冻结");
      signal?.throwIfAborted();
      // The caller synchronously closes cancellation here. No awaited callbacks inside the queue.
      const committing = onCommitting?.();
      if (committing?.then) {
        Promise.resolve(committing).catch(() => {});
        throw new Error("提交状态回调必须同步执行");
      }
      const path = fileOf(snapshot.id);
      await this.storage.transaction(
        root,
        { [path]: serialized },
        { expectedBefore: { [path]: null } },
      );
      const loaded = await this.load(
        root,
        await this.book(root, bookId),
        snapshot.id,
      );
      if (loaded.hash !== snapshot.hash)
        throw new Error("快照落盘核验失败，请保留作品目录");
      return loaded;
    });
  }
  async load(root, book, id) {
    const path = await this.storage.path(root, fileOf(id));
    if ((await stat(path)).size > this.maxBytes)
      throw new Error("发布快照超过当前读取容量限制");
    const bytes = await readFile(path);
    if (bytes.length > this.maxBytes)
      throw new Error("发布快照超过当前读取容量限制");
    const snapshot = verifyPublicationSnapshot(JSON.parse(decodeUtf8(bytes)));
    if (
      snapshot.id !== id ||
      !publicationOriginIds(book).includes(snapshot.content.bookId)
    )
      throw new Error("快照身份或原书不属于当前作品及恢复来源，原文件已保留");
    return snapshot;
  }
  read(bookId, id, expectedHash) {
    fileOf(id);
    if (expectedHash !== undefined && !validHash(expectedHash))
      throw new Error("发布快照预览hash无效");
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId),
        book = await this.book(root, bookId);
      const snapshot = await this.load(root, book, id);
      if (expectedHash !== undefined && snapshot.hash !== expectedHash)
        throw new Error("发布快照已改变，请重新核对预览");
      return snapshot;
    });
  }
  async list(bookId) {
    const names = await this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId);
      await this.book(root, bookId);
      try {
        return await readdir(
          await this.storage.path(root, ".zinovel/publications"),
          { withFileTypes: true },
        );
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    });
    const snapshots = [],
      errors = [];
    for (const entry of names) {
      if (entry.name.endsWith(".tmp")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (!entry.isFile() || !entry.name.endsWith(".json") || !uuid(id)) {
        errors.push({ file: entry.name, error: "无效快照条目，原文件已保留" });
        continue;
      }
      try {
        const snapshot = await this.read(bookId, id);
        snapshots.push({
          id,
          hash: snapshot.hash,
          createdAt: snapshot.createdAt,
          metadata: snapshot.content.metadata,
          sourceBookId: snapshot.content.bookId,
          bookRevision: snapshot.content.bookRevision,
          chapterCount: snapshot.content.chapters.length,
          bodyBytes: snapshot.content.chapters.reduce(
            (sum, chapter) => sum + Buffer.byteLength(chapter.body),
            0,
          ),
          externalChapterIds: snapshot.content.chapters
            .filter((chapter) => chapter.savedHash !== chapter.bodyHash)
            .map((chapter) => chapter.id),
        });
      } catch (error) {
        errors.push({ id, error: error.message });
      }
    }
    snapshots.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
    return { snapshots, errors };
  }
}
