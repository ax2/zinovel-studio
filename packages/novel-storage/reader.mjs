import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { orderedChapters } from "../novel-domain/structure.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export class ReaderStore {
  constructor(storage) {
    this.storage = storage;
  }
  projection(book, options = {}) {
    const ids = new Set(),
      volumeIds = new Set();
    if (
      !uuid(book.id) ||
      typeof book.title !== "string" ||
      !Number.isSafeInteger(book.revision) ||
      book.revision < 1 ||
      (book.author !== undefined && typeof book.author !== "string") ||
      !Array.isArray(book.chapters) ||
      (book.volumes !== undefined && !Array.isArray(book.volumes))
    )
      throw new Error("阅读目录格式不支持，原文件已保留");
    for (const chapter of book.chapters) {
      if (
        !chapter ||
        typeof chapter !== "object" ||
        Array.isArray(chapter) ||
        !uuid(chapter.id) ||
        ids.has(chapter.id) ||
        typeof chapter.title !== "string" ||
        !Number.isSafeInteger(chapter.revision) ||
        chapter.revision < 1 ||
        (chapter.volumeId != null && !uuid(chapter.volumeId)) ||
        (chapter.status !== undefined && typeof chapter.status !== "string")
      )
        throw new Error("阅读章节身份或格式无效，原文件已保留");
      ids.add(chapter.id);
    }
    for (const volume of book.volumes || []) {
      if (
        !volume ||
        typeof volume !== "object" ||
        Array.isArray(volume) ||
        !uuid(volume.id) ||
        volumeIds.has(volume.id) ||
        typeof volume.title !== "string"
      )
        throw new Error("阅读分卷身份或格式无效，原文件已保留");
      volumeIds.add(volume.id);
    }
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !["status", "volumeId"].includes(key))
    )
      throw new Error("阅读范围无效");
    const status = options.status ?? "all",
      volumeId = options.volumeId ?? null;
    if (
      !["all", "final"].includes(status) ||
      (volumeId !== null &&
        (!uuid(volumeId) ||
          !book.volumes?.some((volume) => volume.id === volumeId)))
    )
      throw new Error("阅读范围或分卷已失联，请重新选择");
    const catalog = {
      schemaVersion: 1,
      book: { id: book.id, title: book.title, author: book.author || "" },
      revision: book.revision,
      options: { status, volumeId },
      chapters: orderedChapters(book)
        .filter(
          (chapter) =>
            (status === "all" || chapter.status === "final") &&
            (volumeId === null || chapter.volumeId === volumeId),
        )
        .map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          revision: chapter.revision,
          status: chapter.status || "draft",
          volumeId: chapter.volumeId || null,
          volumeTitle: chapter.volumeId
            ? book.volumes?.find((volume) => volume.id === chapter.volumeId)
                ?.title || "分卷失联"
            : "未分卷",
        })),
      volumes: (book.volumes || []).map((volume) => ({
        id: volume.id,
        title: volume.title,
      })),
    };
    return { ...catalog, hash: hash(JSON.stringify(catalog)) };
  }
  catalog(bookId, options) {
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId);
      const book = await this.storage.manifest(root);
      if (book.id !== bookId) throw new Error("作品目录身份不符，原文件已保留");
      return this.projection(book, options);
    });
  }
  chapter(bookId, chapterId, expectedCatalogHash, options) {
    if (!uuid(chapterId) || !validHash(expectedCatalogHash))
      throw new Error("请选择目录中的章节");
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId),
        book = await this.storage.manifest(root);
      if (book.id !== bookId) throw new Error("作品目录身份不符，原文件已保留");
      const catalog = this.projection(book, options);
      if (catalog.hash !== expectedCatalogHash)
        throw new Error("目录或章节版本已改变，请刷新阅读目录后继续");
      const chapter = catalog.chapters.find((item) => item.id === chapterId);
      if (!chapter) throw new Error("章节不在本次阅读范围内或已失联");
      let body;
      try {
        body = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(
          await readFile(
            await this.storage.path(root, `manuscript/${chapterId}.md`),
          ),
        );
      } catch (error) {
        if (error.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
          throw new Error("正文UTF-8编码无法读取，原文件已保留");
        if (error.code === "ENOENT")
          throw new Error("正文文件失联，未作修改，请刷新目录核对");
        throw error;
      }
      const bodyHash = hash(body);
      return {
        bookId,
        catalogHash: catalog.hash,
        ...chapter,
        body,
        bodyHash,
        externalChange:
          bodyHash !== book.chapters.find((item) => item.id === chapterId).hash,
      };
    });
  }
}
