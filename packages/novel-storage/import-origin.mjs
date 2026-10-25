import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { decodeUtf8 } from "./encoding.mjs";
import { publicationOriginIds } from "./publication.mjs";

export const importOriginPath = ".zinovel/import-origin.json";
const maxBytes = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function keys(value, allowed) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}
function text(value, maximum, optional = false) {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    value.length <= maximum &&
    (optional || !!value.trim()) &&
    !/[\r\n\0]/.test(value)
  );
}
function valid(record) {
  if (
    !keys(record, [
      "schemaVersion",
      "importedBookId",
      "importedAt",
      "applicationVersion",
      "encoding",
      "automaticSplit",
      "originalChapterCount",
      "manualAdjustmentCount",
      "sources",
      "chapters",
    ]) ||
    record.schemaVersion !== 1 ||
    !uuid.test(record.importedBookId || "") ||
    typeof record.importedAt !== "string" ||
    !Number.isFinite(Date.parse(record.importedAt)) ||
    !(
      record.applicationVersion === null || text(record.applicationVersion, 80)
    ) ||
    !["utf-8", "gb18030", "utf-16le", "utf-16be"].includes(record.encoding) ||
    typeof record.automaticSplit !== "boolean" ||
    !Number.isSafeInteger(record.originalChapterCount) ||
    record.originalChapterCount < 1 ||
    record.originalChapterCount > 2000 ||
    !Number.isSafeInteger(record.manualAdjustmentCount) ||
    record.manualAdjustmentCount < 0 ||
    !Array.isArray(record.sources) ||
    record.sources.length < 1 ||
    record.sources.length > 2000 ||
    !Array.isArray(record.chapters) ||
    record.chapters.length < 1 ||
    record.chapters.length > 2000
  )
    return false;
  let total = 0;
  for (const source of record.sources) {
    if (
      !keys(source, ["name", "bytes", "sha256"]) ||
      !text(source.name, 255) ||
      /[\\/]/.test(source.name) ||
      !Number.isSafeInteger(source.bytes) ||
      source.bytes < 0 ||
      source.bytes > 32 * 1024 * 1024 ||
      !sha.test(source.sha256 || "")
    )
      return false;
    total += source.bytes;
  }
  const ids = new Set();
  for (const chapter of record.chapters) {
    if (
      !keys(chapter, ["id", "title", "volume", "sha256"]) ||
      !uuid.test(chapter.id || "") ||
      ids.has(chapter.id) ||
      !text(chapter.title, 200) ||
      !text(chapter.volume, 200, true) ||
      !sha.test(chapter.sha256 || "")
    )
      return false;
    ids.add(chapter.id);
  }
  return total <= 128 * 1024 * 1024;
}

export function createImportOrigin(book, metadata) {
  if (!metadata || !Array.isArray(metadata.sources))
    throw new Error("导入来源说明无效，未创建作品");
  const record = {
    schemaVersion: 1,
    importedBookId: book.id,
    importedAt: book.createdAt,
    applicationVersion: metadata.applicationVersion ?? null,
    encoding: metadata.encoding,
    automaticSplit: metadata.automaticSplit,
    originalChapterCount: metadata.originalChapterCount,
    manualAdjustmentCount: metadata.manualAdjustmentCount,
    sources: metadata.sources.map((source) => ({
      name: source.name,
      bytes: source.bytes,
      sha256: source.sha256,
    })),
    chapters: book.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      volume:
        book.volumes.find((volume) => volume.id === chapter.volumeId)?.title ||
        "",
      sha256: chapter.hash,
    })),
  };
  if (!valid(record)) throw new Error("导入来源说明无效，未创建作品");
  const raw = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(raw) > maxBytes)
    throw new Error("导入来源说明过大，请分批导入");
  return raw;
}

async function boundedRecord(file) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.size > maxBytes)
    throw new Error("导入来源说明过大或不是普通文件，原件已保留");
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const same = (stat) =>
      stat.isFile() &&
      stat.ino === before.ino &&
      stat.dev === before.dev &&
      stat.size === before.size &&
      stat.mtimeMs === before.mtimeMs &&
      stat.ctimeMs === before.ctimeMs;
    if (!same(await handle.stat()))
      throw new Error("导入来源说明正在变化，请稍后重试");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (
      length !== before.size ||
      !same(await handle.stat()) ||
      !same(await lstat(file))
    )
      throw new Error("导入来源说明正在变化，请稍后重试");
    return decodeUtf8(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

export class ImportOriginStore {
  constructor(storage) {
    this.storage = storage;
  }
  read(bookId) {
    return this.storage.exclusive(async () => {
      const root = await this.storage.bookRoot(bookId),
        book = await this.storage.manifest(root);
      const raw = await boundedRecord(
        await this.storage.path(root, importOriginPath),
      );
      if (raw === null) return { origin: null, restoredCopy: false };
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        throw new Error("导入来源说明损坏，原件已保留");
      }
      if (!valid(record))
        throw new Error("导入来源说明格式损坏或版本不支持，原件已保留");
      if (!publicationOriginIds(book).includes(record.importedBookId))
        throw new Error("导入来源说明属于其他作品，原件已保留");
      return {
        origin: record,
        restoredCopy: record.importedBookId !== book.id,
      };
    });
  }
}
