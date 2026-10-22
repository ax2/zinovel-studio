import { mkdir, readFile, writeFile, rename, readdir, lstat, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const idPattern = /^[0-9a-f-]{36}$/;
const checkedId = id => { if (!idPattern.test(id)) throw new Error('无效的作品或章节标识'); return id; };
const titleOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('标题应为 1–200 个字符');
  return value.trim();
};
const json = value => JSON.stringify(value, null, 2) + '\n';
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

export class NovelStore {
  #queue = Promise.resolve();
  constructor(root) { this.root = resolve(root); }
  async initialize() { await mkdir(this.root, { recursive: true }); }
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {}); // Keep later writes available after a reported failure.
    return result;
  }
  async #bookRoot(bookId) {
    const root = join(this.root, checkedId(bookId));
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('作品目录不能是链接');
    return root;
  }
  async #path(root, relative) {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '..' || part === '.' || /[\\:]/.test(part))) throw new Error('无效的作品内路径');
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('作品文件不能是链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
  }
  async #recover(root) {
    const path = await this.#path(root, '.zinovel/pending.json');
    const raw = await readOptional(path);
    if (!raw) return;
    const pending = JSON.parse(raw);
    if (!Array.isArray(pending.entries)) throw new Error('恢复日志损坏，请保留作品目录');
    for (const entry of pending.entries) {
      const current = await readOptional(await this.#path(root, entry.path));
      if (current !== entry.before && current !== entry.after) throw new Error('检测到中断事务与外部修改冲突，请保留当前副本');
    }
    for (const entry of pending.entries) await atomic(await this.#path(root, entry.path), entry.after);
    await atomic(await this.#path(root, `.zinovel/transactions/${pending.id}.json`), raw);
    await atomic(path, '');
  }
  async #transaction(root, changes) {
    await this.#recover(root);
    const entries = [];
    for (const [path, after] of Object.entries(changes)) entries.push({ path, before: await readOptional(await this.#path(root, path)), after });
    const transaction = { id: randomUUID(), at: new Date().toISOString(), entries };
    await atomic(await this.#path(root, '.zinovel/pending.json'), json(transaction));
    await this.#recover(root);
  }
  async #manifest(root) {
    await this.#recover(root);
    const book = JSON.parse(await readFile(await this.#path(root, 'book.json'), 'utf8'));
    if (book.schemaVersion !== 1 || !Array.isArray(book.chapters)) throw new Error('不支持的作品格式，请勿覆盖原稿');
    return book;
  }
  listBooks() {
    return this.#exclusive(async () => {
      await this.initialize();
      const books = [], errors = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
        try { books.push(await this.#manifest(await this.#bookRoot(entry.name))); }
        catch { errors.push({ id: entry.name, message: '作品未能读取，原始文件已保留' }); }
      }
      books.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
      return { books, errors };
    });
  }
  createBook(title) {
    return this.#exclusive(async () => {
      const name = titleOf(title), id = randomUUID();
      const root = join(this.root, id);
      await mkdir(root, { recursive: true });
      const book = { schemaVersion: 1, id, title: name, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), chapters: [] };
      await this.#transaction(root, { 'book.json': json(book) });
      return book;
    });
  }
  createChapter(bookId, title) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId), book = await this.#manifest(root);
      const chapter = { id: randomUUID(), title: titleOf(title), revision: 1, hash: digest(''), status: 'draft', updatedAt: new Date().toISOString() };
      book.chapters.push(chapter); book.revision++; book.updatedAt = chapter.updatedAt;
      await this.#transaction(root, { [`manuscript/${chapter.id}.md`]: '', 'book.json': json(book) });
      return { book, chapter: { ...chapter, body: '' } };
    });
  }
  readChapter(bookId, chapterId) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId), book = await this.#manifest(root);
      const chapter = book.chapters.find(c => c.id === checkedId(chapterId));
      if (!chapter) throw new Error('章节不存在');
      const body = await readFile(await this.#path(root, `manuscript/${chapterId}.md`), 'utf8');
      return { ...chapter, body, diskHash: digest(body), externalChange: chapter.hash !== digest(body) };
    });
  }
  saveChapter(input) {
    return this.#exclusive(async () => {
      if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 8 * 1024 * 1024) throw new Error('单章正文超过 8 MiB 或格式无效');
      const root = await this.#bookRoot(input.bookId), book = await this.#manifest(root);
      const chapter = book.chapters.find(c => c.id === checkedId(input.chapterId));
      if (!chapter) throw new Error('章节不存在');
      const path = `manuscript/${chapter.id}.md`;
      const disk = await readFile(await this.#path(root, path), 'utf8');
      if (input.expectedRevision !== chapter.revision || input.expectedHash !== digest(disk)) return { status: 'conflict', current: { ...chapter, body: disk, diskHash: digest(disk) } };
      chapter.title = titleOf(input.title); chapter.revision++; chapter.hash = digest(input.body);
      chapter.updatedAt = new Date().toISOString();
      book.updatedAt = chapter.updatedAt; book.revision++;
      await this.#transaction(root, { [path]: input.body, 'book.json': json(book) });
      return { status: 'saved', book, chapter: { ...chapter, body: input.body, diskHash: chapter.hash, externalChange: false } };
    });
  }
  history(bookId, chapterId) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId), path = `manuscript/${checkedId(chapterId)}.md`;
      const directory = await this.#path(root, '.zinovel/transactions');
      const versions = [];
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.json')) continue;
        const transaction = JSON.parse(await readFile(await this.#path(root, `.zinovel/transactions/${file}`), 'utf8'));
        const change = transaction.entries.find(entry => entry.path === path);
        if (change) {
          versions.push({ id: transaction.id, at: transaction.at, body: change.after });
          // External edits are not necessarily an earlier transaction's after image.
          if (change.before !== null) versions.push({ id: `${transaction.id}-before`, at: transaction.at, body: change.before });
        }
      }
      const seen = new Set();
      return versions.sort((a,b) => b.at.localeCompare(a.at)).filter(version => {
        const hash = digest(version.body);
        if (seen.has(hash)) return false;
        seen.add(hash); return true;
      });
    });
  }
}
