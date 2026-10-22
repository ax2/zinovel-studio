import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  lstat,
  open,
} from "node:fs/promises";
import { join, resolve, dirname, relative, sep, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { orderedChapters } from "../novel-domain/structure.mjs";
import { createAnchor, resolveAnchor } from "../novel-domain/anchors.mjs";

export const digest = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
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
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export class NovelStore {
  #queue = Promise.resolve();
  constructor(root) {
    this.root = resolve(root);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
  }
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {}); // Keep later writes available after a reported failure.
    return result;
  }
  async #bookRoot(bookId) {
    const root = join(this.root, checkedId(bookId));
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("作品目录不能是链接");
    return root;
  }
  async #path(root, relative) {
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
  async #recover(root) {
    const path = await this.#path(root, ".zinovel/pending.json");
    const raw = await readOptional(path);
    if (!raw) return;
    const pending = JSON.parse(raw);
    if (!Array.isArray(pending.entries))
      throw new Error("恢复日志损坏，请保留作品目录");
    for (const entry of pending.entries) {
      const current = await readOptional(await this.#path(root, entry.path));
      if (current !== entry.before && current !== entry.after)
        throw new Error("检测到中断事务与外部修改冲突，请保留当前副本");
    }
    for (const entry of pending.entries)
      await atomic(await this.#path(root, entry.path), entry.after);
    await atomic(
      await this.#path(root, `.zinovel/transactions/${pending.id}.json`),
      raw,
    );
    await atomic(path, "");
  }
  async #transaction(root, changes) {
    await this.#recover(root);
    const entries = [];
    for (const [path, after] of Object.entries(changes))
      entries.push({
        path,
        before: await readOptional(await this.#path(root, path)),
        after,
      });
    const transaction = {
      id: randomUUID(),
      at: new Date().toISOString(),
      entries,
    };
    await atomic(
      await this.#path(root, ".zinovel/pending.json"),
      json(transaction),
    );
    await this.#recover(root);
  }
  async #manifest(root) {
    await this.#recover(root);
    const book = JSON.parse(
      await readFile(await this.#path(root, "book.json"), "utf8"),
    );
    if (book.schemaVersion !== 1 || !Array.isArray(book.chapters))
      throw new Error("不支持的作品格式，请勿覆盖原稿");
    return book;
  }
  listBooks() {
    return this.#exclusive(async () => {
      await this.initialize();
      const books = [],
        errors = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
        try {
          books.push(await this.#manifest(await this.#bookRoot(entry.name)));
        } catch {
          errors.push({
            id: entry.name,
            message: "作品未能读取，原始文件已保留",
          });
        }
      }
      books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { books, errors };
    });
  }
  createBook(title) {
    return this.#exclusive(async () => {
      const name = titleOf(title),
        id = randomUUID();
      const root = join(this.root, id);
      await mkdir(root, { recursive: true });
      const book = {
        schemaVersion: 1,
        id,
        title: name,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        chapters: [],
      };
      await this.#transaction(root, { "book.json": json(book) });
      return book;
    });
  }
  createChapter(bookId, title, volumeId = null) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId),
        book = await this.#manifest(root);
      if (
        volumeId &&
        !(book.volumes || []).some((volume) => volume.id === volumeId)
      )
        throw new Error("分卷不存在");
      const chapter = {
        id: randomUUID(),
        title: titleOf(title),
        volumeId,
        revision: 1,
        hash: digest(""),
        status: "draft",
        updatedAt: new Date().toISOString(),
      };
      book.chapters.push(chapter);
      book.revision++;
      book.updatedAt = chapter.updatedAt;
      await this.#transaction(root, {
        [`manuscript/${chapter.id}.md`]: "",
        "book.json": json(book),
      });
      return { book, chapter: { ...chapter, body: "" } };
    });
  }
  updateStructure(bookId, expectedRevision, mutation) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId),
        book = await this.#manifest(root);
      if (book.revision !== expectedRevision)
        throw new Error("作品目录已经改变，请刷新后重试");
      book.volumes ||= [];
      switch (mutation.type) {
        case "book-metadata": {
          book.title = titleOf(mutation.title);
          for (const field of ["genre", "series", "author"]) {
            if (
              typeof mutation[field] !== "string" ||
              mutation[field].length > 200
            )
              throw new Error("作品信息过长或无效");
            book[field] = mutation[field].trim();
          }
          break;
        }
        case "volume-create":
          book.volumes.push({
            id: randomUUID(),
            title: titleOf(mutation.title),
          });
          break;
        case "volume-rename": {
          const volume = book.volumes.find(
            (item) => item.id === checkedId(mutation.volumeId),
          );
          if (!volume) throw new Error("分卷不存在");
          volume.title = titleOf(mutation.title);
          break;
        }
        case "chapter-move": {
          const chapter = book.chapters.find(
            (item) => item.id === checkedId(mutation.chapterId),
          );
          if (!chapter) throw new Error("章节不存在");
          if (
            mutation.volumeId &&
            !book.volumes.some((item) => item.id === mutation.volumeId)
          )
            throw new Error("分卷不存在");
          chapter.volumeId = mutation.volumeId || null;
          const old = book.chapters.indexOf(chapter);
          const target = mutation.beforeId
            ? book.chapters.find(
                (item) => item.id === checkedId(mutation.beforeId),
              )
            : null;
          if (mutation.beforeId && !target) throw new Error("目标章节不存在");
          if (target !== chapter) {
            book.chapters.splice(old, 1);
            book.chapters.splice(
              target ? book.chapters.indexOf(target) : book.chapters.length,
              0,
              chapter,
            );
          }
          break;
        }
        case "chapter-status":
        case "chapter-trash":
        case "chapter-restore": {
          const chapter = book.chapters.find(
            (item) => item.id === checkedId(mutation.chapterId),
          );
          if (!chapter) throw new Error("章节不存在");
          if (mutation.type === "chapter-status") {
            if (!["draft", "reviewed", "final"].includes(mutation.status))
              throw new Error("章节状态无效");
            chapter.status = mutation.status;
          } else if (mutation.type === "chapter-trash")
            chapter.deletedAt = new Date().toISOString();
          else delete chapter.deletedAt;
          break;
        }
        default:
          throw new Error("未知目录修改");
      }
      book.chapters = orderedChapters(book, { includeDeleted: true });
      book.revision++;
      book.updatedAt = new Date().toISOString();
      await this.#transaction(root, { "book.json": json(book) });
      return book;
    });
  }
  importBook(title, chapters) {
    return this.#exclusive(async () => {
      const name = titleOf(title);
      if (
        !Array.isArray(chapters) ||
        !chapters.length ||
        chapters.length > 2000
      )
        throw new Error("导入需要 1–2000 个章节");
      let bytes = 0;
      for (const chapter of chapters) {
        titleOf(chapter.title);
        if (
          typeof chapter.body !== "string" ||
          Buffer.byteLength(chapter.body) > 8 * 1024 * 1024
        )
          throw new Error("导入正文格式无效或单章过大");
        bytes += Buffer.byteLength(chapter.body);
      }
      if (bytes > 128 * 1024 * 1024)
        throw new Error("本轮导入超过 128 MiB，请分批导入");
      const id = randomUUID(),
        root = join(this.root, id),
        now = new Date().toISOString();
      const book = {
        schemaVersion: 1,
        id,
        title: name,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        chapters: [],
        volumes: [],
      };
      const changes = {},
        volumes = new Map();
      for (const input of chapters) {
        let volumeId = null;
        if (input.volume) {
          const title = titleOf(input.volume);
          if (!volumes.has(title)) {
            const volume = { id: randomUUID(), title };
            volumes.set(title, volume.id);
            book.volumes.push(volume);
          }
          volumeId = volumes.get(title);
        }
        const chapter = {
          id: randomUUID(),
          title: titleOf(input.title),
          volumeId,
          revision: 1,
          hash: digest(input.body),
          status: "draft",
          updatedAt: now,
        };
        book.chapters.push(chapter);
        changes[`manuscript/${chapter.id}.md`] = input.body;
      }
      changes["book.json"] = json(book);
      await mkdir(root, { recursive: true });
      await this.#transaction(root, changes);
      return book;
    });
  }
  search(bookId, query) {
    return this.#exclusive(async () => {
      if (typeof query !== "string" || !query.trim() || query.length > 200)
        throw new Error("请输入 1–200 字的检索词");
      const root = await this.#bookRoot(bookId),
        book = await this.#manifest(root),
        hits = [];
      for (const chapter of orderedChapters(book)) {
        const body = await readFile(
          await this.#path(root, `manuscript/${chapter.id}.md`),
          "utf8",
        );
        let start = body.indexOf(query);
        if (chapter.title.includes(query))
          hits.push({
            chapterId: chapter.id,
            title: chapter.title,
            kind: "title",
            start: 0,
            end: 0,
            excerpt: chapter.title,
            hash: digest(body),
          });
        while (start !== -1 && hits.length < 200) {
          hits.push({
            chapterId: chapter.id,
            title: chapter.title,
            kind: "body",
            start,
            end: start + query.length,
            excerpt: body.slice(
              Math.max(0, start - 30),
              start + query.length + 70,
            ),
            hash: digest(body),
          });
          start = body.indexOf(query, start + query.length);
        }
        if (hits.length >= 200)
          return {
            hits: hits.slice(0, 200),
            truncated: true,
            offsetUnit: "utf16",
          };
      }
      return { hits, truncated: false, offsetUnit: "utf16" };
    });
  }
  async #annotationContext(bookId, chapterId) {
    const root = await this.#bookRoot(bookId),
      book = await this.#manifest(root);
    const chapter = book.chapters.find(
      (item) => item.id === checkedId(chapterId) && !item.deletedAt,
    );
    if (!chapter) throw new Error("章节不存在或已移入回收站");
    const body = await readFile(
      await this.#path(root, `manuscript/${chapterId}.md`),
      "utf8",
    );
    const path = `annotations/${chapterId}.json`,
      raw = await readOptional(await this.#path(root, path));
    const data = raw
      ? JSON.parse(raw)
      : { schemaVersion: 1, revision: 0, items: [] };
    if (
      data.schemaVersion !== 1 ||
      !Number.isSafeInteger(data.revision) ||
      !Array.isArray(data.items)
    )
      throw new Error("批注文件格式不支持，未修改原文件");
    return {
      root,
      path,
      data,
      body,
      hash: digest(body),
      metadataHash: raw === null ? null : digest(raw),
    };
  }
  readAnnotations(bookId, chapterId) {
    return this.#exclusive(async () => {
      const { data, body, hash, metadataHash } = await this.#annotationContext(
        bookId,
        chapterId,
      );
      return {
        ...data,
        bodyHash: hash,
        metadataHash,
        items: data.items.map((item) => ({
          ...item,
          location: resolveAnchor(body, item.anchor, hash),
        })),
      };
    });
  }
  mutateAnnotations(
    bookId,
    chapterId,
    expectedRevision,
    expectedMetadataHash,
    expectedBodyHash,
    mutation,
  ) {
    return this.#exclusive(async () => {
      const { root, path, data, body, hash, metadataHash } =
        await this.#annotationContext(bookId, chapterId);
      if (
        data.revision !== expectedRevision ||
        metadataHash !== expectedMetadataHash
      )
        throw new Error("批注已被修改，请重新打开后重试");
      if (hash !== expectedBodyHash)
        throw new Error("正文已改变，请重新打开批注以核对定位");
      const now = new Date().toISOString();
      if (mutation.type === "create") {
        if (!["note", "bookmark", "scene"].includes(mutation.kind))
          throw new Error("不支持的批注类型");
        if (data.items.length >= 10000)
          throw new Error("本章标记已达到 10000 个，请先整理");
        const anchor = createAnchor(body, mutation.start, mutation.end, hash);
        if (mutation.kind === "scene" && !anchor.quote)
          throw new Error("请选中场景正文再创建场景");
        data.items.push({
          id: randomUUID(),
          chapterId,
          kind: mutation.kind,
          title: titleOf(mutation.title),
          text: this.#annotationText(mutation.text),
          anchor,
          resolved: false,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const item = data.items.find(
          (item) => item.id === checkedId(mutation.id),
        );
        if (!item) throw new Error("批注不存在");
        if (mutation.type === "edit") {
          item.title = titleOf(mutation.title);
          item.text = this.#annotationText(mutation.text);
        } else if (mutation.type === "resolved") {
          if (typeof mutation.value !== "boolean")
            throw new Error("无效的批注状态");
          item.resolved = mutation.value;
        } else if (mutation.type === "trash") item.deletedAt = now;
        else if (mutation.type === "restore") delete item.deletedAt;
        else if (mutation.type === "reanchor") {
          item.anchor = createAnchor(body, mutation.start, mutation.end, hash);
          if (item.kind === "scene" && !item.anchor.quote)
            throw new Error("场景需要选中正文范围");
        } else throw new Error("不支持的批注操作");
        item.updatedAt = now;
      }
      data.revision++;
      await this.#transaction(root, { [path]: json(data) });
      return { revision: data.revision };
    });
  }
  #annotationText(text) {
    if (typeof text !== "string" || text.length > 20000)
      throw new Error("批注内容应不超过 2 万字符");
    return text;
  }
  exportSnapshot(bookId) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId),
        book = await this.#manifest(root),
        chapters = [];
      for (const chapter of orderedChapters(book)) {
        const body = await readFile(
          await this.#path(root, `manuscript/${chapter.id}.md`),
          "utf8",
        );
        chapters.push({ ...chapter, body, diskHash: digest(body) });
      }
      return { book, chapters, capturedAt: new Date().toISOString() };
    });
  }
  createBackup(bookId, destination) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId);
      await this.#manifest(root);
      const parent = resolve(destination),
        inside = relative(root, parent);
      if (
        !inside ||
        (!isAbsolute(inside) &&
          !inside.startsWith(`..${sep}`) &&
          inside !== "..")
      )
        throw new Error("备份位置不能位于作品目录内部");
      const id = randomUUID(),
        staging = join(parent, `.zinovel-backup-${id}.tmp`),
        final = join(parent, `zinovel-backup-${id}`),
        files = [];
      await mkdir(staging, { recursive: true });
      const copy = async (directory, prefix = "") => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink())
            throw new Error("备份不跟随链接，请移除外部链接后重试");
          if (entry.name.endsWith(".tmp")) continue;
          const name = prefix + entry.name,
            source = await this.#path(root, name);
          if (entry.isDirectory()) {
            await mkdir(join(staging, name), { recursive: true });
            await copy(source, name + "/");
          } else {
            const bytes = await readFile(source);
            await writeFile(join(staging, name), bytes);
            files.push({
              path: name,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
        }
      };
      await copy(root);
      for (const file of files) {
        const bytes = await readFile(await this.#path(root, file.path));
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
          throw new Error("备份期间文件被外部修改，请重新备份");
      }
      await atomic(
        join(staging, "backup-manifest.json"),
        json({
          format: "zinovel-backup",
          version: 1,
          id,
          bookId,
          createdAt: new Date().toISOString(),
          files,
        }),
      );
      await rename(staging, final);
      return { path: final, files: files.length };
    });
  }
  restoreBackup(source) {
    return this.#exclusive(async () => {
      const root = resolve(source);
      if ((await lstat(root)).isSymbolicLink())
        throw new Error("备份根目录不能是链接");
      const manifest = JSON.parse(
        await readFile(await this.#path(root, "backup-manifest.json"), "utf8"),
      );
      if (
        manifest.format !== "zinovel-backup" ||
        manifest.version !== 1 ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 100000
      )
        throw new Error("备份清单格式不支持");
      const seen = new Set(),
        contents = new Map();
      let total = 0;
      for (const file of manifest.files) {
        if (seen.has(file.path)) throw new Error("备份清单存在重复路径");
        seen.add(file.path);
        const path = await this.#path(root, file.path),
          stat = await lstat(path);
        total += stat.size;
        if (total > 512 * 1024 * 1024)
          throw new Error("备份超过当前 512 MiB 恢复限制");
        const bytes = await readFile(path);
        if (
          bytes.length !== file.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256
        )
          throw new Error("备份校验失败，未改动现有作品");
        contents.set(file.path, bytes);
      }
      const book = JSON.parse(
        contents.get("book.json")?.toString("utf8") || "{}",
      );
      if (book.schemaVersion !== 1 || !Array.isArray(book.chapters))
        throw new Error("备份作品格式不支持");
      for (const chapter of book.chapters)
        if (!contents.has(`manuscript/${checkedId(chapter.id)}.md`))
          throw new Error("备份缺少章节正文");
      if (contents.get(".zinovel/pending.json")?.toString("utf8").trim())
        throw new Error("备份含有未完成事务，请先在原位置恢复");
      const id = randomUUID(),
        staging = join(this.root, `.restore-${id}`),
        final = join(this.root, id);
      await mkdir(staging, { recursive: true });
      for (const [path, bytes] of contents) {
        const target = await this.#path(staging, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      book.id = id;
      book.title = `${book.title}（恢复）`;
      book.revision++;
      book.updatedAt = new Date().toISOString();
      await atomic(join(staging, "book.json"), json(book));
      await rename(staging, final);
      return book;
    });
  }
  readChapter(bookId, chapterId) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId),
        book = await this.#manifest(root);
      const chapter = book.chapters.find((c) => c.id === checkedId(chapterId));
      if (!chapter) throw new Error("章节不存在");
      const body = await readFile(
        await this.#path(root, `manuscript/${chapterId}.md`),
        "utf8",
      );
      return {
        ...chapter,
        body,
        diskHash: digest(body),
        externalChange: chapter.hash !== digest(body),
      };
    });
  }
  saveChapter(input) {
    return this.#exclusive(async () => {
      if (
        typeof input.body !== "string" ||
        Buffer.byteLength(input.body) > 8 * 1024 * 1024
      )
        throw new Error("单章正文超过 8 MiB 或格式无效");
      const root = await this.#bookRoot(input.bookId),
        book = await this.#manifest(root);
      const chapter = book.chapters.find(
        (c) => c.id === checkedId(input.chapterId),
      );
      if (!chapter) throw new Error("章节不存在");
      const path = `manuscript/${chapter.id}.md`;
      const disk = await readFile(await this.#path(root, path), "utf8");
      if (
        input.expectedRevision !== chapter.revision ||
        input.expectedHash !== digest(disk)
      )
        return {
          status: "conflict",
          current: { ...chapter, body: disk, diskHash: digest(disk) },
        };
      chapter.title = titleOf(input.title);
      chapter.revision++;
      chapter.hash = digest(input.body);
      chapter.updatedAt = new Date().toISOString();
      book.updatedAt = chapter.updatedAt;
      book.revision++;
      await this.#transaction(root, {
        [path]: input.body,
        "book.json": json(book),
      });
      return {
        status: "saved",
        book,
        chapter: {
          ...chapter,
          body: input.body,
          diskHash: chapter.hash,
          externalChange: false,
        },
      };
    });
  }
  history(bookId, chapterId) {
    return this.#exclusive(async () => {
      const root = await this.#bookRoot(bookId),
        path = `manuscript/${checkedId(chapterId)}.md`;
      const directory = await this.#path(root, ".zinovel/transactions");
      const versions = [];
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json")) continue;
        const transaction = JSON.parse(
          await readFile(
            await this.#path(root, `.zinovel/transactions/${file}`),
            "utf8",
          ),
        );
        const change = transaction.entries.find((entry) => entry.path === path);
        if (change) {
          versions.push({
            id: transaction.id,
            at: transaction.at,
            body: change.after,
          });
          // External edits are not necessarily an earlier transaction's after image.
          if (change.before !== null)
            versions.push({
              id: `${transaction.id}-before`,
              at: transaction.at,
              body: change.before,
            });
        }
      }
      const seen = new Set();
      return versions
        .sort((a, b) => b.at.localeCompare(a.at))
        .filter((version) => {
          const hash = digest(version.body);
          if (seen.has(hash)) return false;
          seen.add(hash);
          return true;
        });
    });
  }
}
