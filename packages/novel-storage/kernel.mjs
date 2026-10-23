import { readUtf8File } from "./encoding.mjs";
import { mkdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteText as atomic } from "./atomic.mjs";
const idPattern = /^[0-9a-f-]{36}$/;
const checkedId = (id) => {
  if (!idPattern.test(id)) throw new Error("无效的作品或章节标识");
  return id;
};
const titleOf = (value) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new Error("标题应为 1–200 个字符");
  return value.trim();
};
const json = (value) => JSON.stringify(value, null, 2) + "\n";
async function readOptional(path) {
  try {
    return await readUtf8File(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** All book services share this single queue. Call recovery and transactions only inside exclusive(). */
export class BookStorageKernel {
  #queue = Promise.resolve();
  constructor(root) {
    this.root = resolve(root);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
  }
  async whenIdle() {
    await this.#queue;
  }
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
  async bookRoot(bookId) {
    const root = join(this.root, checkedId(bookId));
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("作品目录不能是链接");
    return root;
  }
  async path(root, relative) {
    const parts = relative.split("/");
    if (
      parts.some(
        (part) => !part || part === ".." || part === "." || /[\\:]/.test(part),
      )
    )
      throw new Error("无效的作品内路径");
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("作品文件不能是链接");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return current;
  }
  async recover(root) {
    const path = await this.path(root, ".zinovel/pending.json");
    const raw = await readOptional(path);
    if (!raw) return;
    const pending = JSON.parse(raw);
    if (
      !pending ||
      typeof pending.id !== "string" ||
      !pending.id ||
      !Array.isArray(pending.entries) ||
      pending.entries.some(
        (entry) =>
          !entry ||
          typeof entry.path !== "string" ||
          !entry.path.isWellFormed() ||
          typeof entry.after !== "string" ||
          !entry.after.isWellFormed() ||
          (entry.before !== null &&
            (typeof entry.before !== "string" || !entry.before.isWellFormed())),
      )
    )
      throw new Error("恢复日志损坏，请保留作品目录");
    const archivePath = await this.path(
        root,
        `.zinovel/transactions/${pending.id}.json`,
      ),
      seen = new Set();
    for (const entry of pending.entries) {
      const key =
        process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
      if (seen.has(key)) throw new Error("恢复日志路径重复，请保留作品目录");
      seen.add(key);
      const current = await readOptional(await this.path(root, entry.path));
      if (current !== entry.before && current !== entry.after)
        throw new Error("检测到中断事务与外部修改冲突，请保留当前副本");
    }
    for (const entry of pending.entries)
      await atomic(await this.path(root, entry.path), entry.after);
    await atomic(archivePath, raw);
    await atomic(path, "");
  }
  async transaction(root, changes, options = {}) {
    const requested = Object.entries(changes);
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "expectedBefore")
    )
      throw new Error("事务前像条件无效，原文件已保留");
    const expected =
      options.expectedBefore === undefined ? {} : options.expectedBefore;
    if (
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      Object.entries(expected).some(
        ([path, before]) =>
          !Object.hasOwn(changes, path) ||
          (before !== null &&
            (typeof before !== "string" || !before.isWellFormed())),
      )
    )
      throw new Error("事务前像条件无效，原文件已保留");
    const seen = new Set();
    for (const [path, after] of requested) {
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) throw new Error("事务路径重复，未创建恢复日志");
      seen.add(key);
      if (
        !path.isWellFormed() ||
        typeof after !== "string" ||
        !after.isWellFormed()
      )
        throw new Error("事务文本格式无效或包含不完整Unicode，原文件已保留");
      await this.path(root, path);
    }
    await this.recover(root);
    const entries = [];
    for (const [path, after] of requested) {
      const before = await readOptional(await this.path(root, path));
      if (Object.hasOwn(expected, path) && before !== expected[path])
        throw new Error("事务前像已改变，未覆盖现有文件");
      entries.push({
        path,
        before,
        after,
      });
    }
    const transaction = {
      id: randomUUID(),
      at: new Date().toISOString(),
      entries,
    };
    await atomic(
      await this.path(root, ".zinovel/pending.json"),
      json(transaction),
    );
    await this.recover(root);
  }
  async manifest(root) {
    await this.recover(root);
    const book = JSON.parse(
      await readUtf8File(await this.path(root, "book.json")),
    );
    if (book.schemaVersion !== 1 || !Array.isArray(book.chapters))
      throw new Error("不支持的作品格式，请勿覆盖原稿");
    return book;
  }
}
