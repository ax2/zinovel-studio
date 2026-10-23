import { mkdir, lstat, readFile } from "node:fs/promises";
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
    return await readFile(path, "utf8");
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
    if (!Array.isArray(pending.entries))
      throw new Error("恢复日志损坏，请保留作品目录");
    for (const entry of pending.entries) {
      const current = await readOptional(await this.path(root, entry.path));
      if (current !== entry.before && current !== entry.after)
        throw new Error("检测到中断事务与外部修改冲突，请保留当前副本");
    }
    for (const entry of pending.entries)
      await atomic(await this.path(root, entry.path), entry.after);
    await atomic(
      await this.path(root, `.zinovel/transactions/${pending.id}.json`),
      raw,
    );
    await atomic(path, "");
  }
  async transaction(root, changes) {
    await this.recover(root);
    const entries = [];
    for (const [path, after] of Object.entries(changes))
      entries.push({
        path,
        before: await readOptional(await this.path(root, path)),
        after,
      });
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
      await readFile(await this.path(root, "book.json"), "utf8"),
    );
    if (book.schemaVersion !== 1 || !Array.isArray(book.chapters))
      throw new Error("不支持的作品格式，请勿覆盖原稿");
    return book;
  }
}
