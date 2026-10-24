import { readUtf8File, decodeUtf8 } from "./encoding.mjs";
import { BookStorageKernel } from "./kernel.mjs";
import { MaterialStore } from "./materials.mjs";
import { PlanningStore } from "./planning.mjs";
import { PilotStore } from "./pilots.mjs";
import { ContinuityStore } from "./continuity.mjs";
import { KnowledgeStore } from "./knowledge.mjs";
import { MixedContext } from "./context.mjs";
import { ReaderStore } from "./reader.mjs";
import { PublicationStore, publicationOriginIds } from "./publication.mjs";
import { AssetStore } from "./assets.mjs";
import { PublicationResources } from "./publication-resources.mjs";
import { MapStore } from "./maps.mjs";
import { MapAtlasStore } from "./map-atlas.mjs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import {
  join,
  resolve,
  dirname,
  basename,
  relative,
  sep,
  isAbsolute,
} from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { orderedChapters } from "../novel-domain/structure.mjs";
import { createAnchor, resolveAnchor } from "../novel-domain/anchors.mjs";
import { atomicWriteText as atomic } from "./atomic.mjs";

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
    return await readUtf8File(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/** Resolve existing ancestors too, so a not-yet-created child cannot conceal a Junction. */
async function canonicalDestination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
function withinDirectory(root, path) {
  const inside = relative(root, path);
  return (
    !inside ||
    (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))
  );
}
export class NovelStore {
  #storage;
  constructor(root) {
    this.root = resolve(root);
    this.#storage = new BookStorageKernel(this.root);
    this.materials = new MaterialStore(this.#storage);
    this.assets = new AssetStore(this.#storage, this.materials);
    this.publicationResources = new PublicationResources(
      this.#storage,
      this.assets,
    );
    this.maps = new MapStore(this.#storage, this.materials, this.assets);
    this.atlas = new MapAtlasStore(this.#storage, this.maps);
    this.reader = new ReaderStore(this.#storage);
    this.publication = new PublicationStore(this.#storage, this.reader, {
      resources: this.publicationResources,
    });
    this.planning = new PlanningStore(this.#storage, this.materials);
    this.pilots = new PilotStore(this.#storage, this.materials);
    this.continuity = new ContinuityStore(this.#storage, this.materials);
    this.knowledge = new KnowledgeStore(this.#storage, this.materials);
    this.context = new MixedContext(
      this.#storage,
      this.materials,
      this.knowledge,
    );
  }
  initialize() {
    return this.#storage.initialize();
  }
  whenIdle() {
    return this.#storage.whenIdle();
  }
  listBooks() {
    return this.#storage.exclusive(async () => {
      await this.initialize();
      const books = [],
        errors = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
        try {
          books.push(
            await this.#storage.manifest(
              await this.#storage.bookRoot(entry.name),
            ),
          );
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
    return this.#storage.exclusive(async () => {
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
      await this.#storage.transaction(root, { "book.json": json(book) });
      return book;
    });
  }
  createChapter(bookId, title, volumeId = null) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId),
        book = await this.#storage.manifest(root);
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
      await this.#storage.transaction(root, {
        [`manuscript/${chapter.id}.md`]: "",
        "book.json": json(book),
      });
      return { book, chapter: { ...chapter, body: "" } };
    });
  }
  updateStructure(bookId, expectedRevision, mutation) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId),
        book = await this.#storage.manifest(root);
      if (book.revision !== expectedRevision)
        throw new Error("作品目录已经改变，请刷新后重试");
      book.volumes ||= [];
      switch (mutation.type) {
        case "book-archive":
          if (typeof mutation.archived !== "boolean")
            throw new Error("归档状态无效");
          if (mutation.archived) book.archivedAt = new Date().toISOString();
          else delete book.archivedAt;
          break;
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
        case "volume-move": {
          const volume = book.volumes.find(
            (item) => item.id === checkedId(mutation.volumeId),
          );
          const target = mutation.beforeId
            ? book.volumes.find(
                (item) => item.id === checkedId(mutation.beforeId),
              )
            : null;
          if (!volume || (mutation.beforeId && !target))
            throw new Error("分卷不存在");
          if (volume !== target) {
            book.volumes.splice(book.volumes.indexOf(volume), 1);
            book.volumes.splice(
              target ? book.volumes.indexOf(target) : book.volumes.length,
              0,
              volume,
            );
          }
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
      await this.#storage.transaction(root, { "book.json": json(book) });
      return book;
    });
  }
  importBook(title, chapters) {
    return this.#storage.exclusive(async () => {
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
          !chapter.body.isWellFormed() ||
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
      await this.#storage.transaction(root, changes);
      return book;
    });
  }
  search(bookId, query) {
    return this.#storage.exclusive(async () => {
      if (typeof query !== "string" || !query.trim() || query.length > 200)
        throw new Error("请输入 1–200 字的检索词");
      const root = await this.#storage.bookRoot(bookId),
        book = await this.#storage.manifest(root),
        hits = [];
      for (const chapter of orderedChapters(book)) {
        const body = await readUtf8File(
          await this.#storage.path(root, `manuscript/${chapter.id}.md`),
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
    const root = await this.#storage.bookRoot(bookId),
      book = await this.#storage.manifest(root);
    const chapter = book.chapters.find(
      (item) => item.id === checkedId(chapterId) && !item.deletedAt,
    );
    if (!chapter) throw new Error("章节不存在或已移入回收站");
    const body = await readUtf8File(
      await this.#storage.path(root, `manuscript/${chapterId}.md`),
    );
    const path = `annotations/${chapterId}.json`,
      raw = await readOptional(await this.#storage.path(root, path));
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
    return this.#storage.exclusive(async () => {
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
    return this.#storage.exclusive(async () => {
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
      await this.#storage.transaction(root, { [path]: json(data) });
      return { revision: data.revision };
    });
  }
  #annotationText(text) {
    if (typeof text !== "string" || text.length > 20000)
      throw new Error("批注内容应不超过 2 万字符");
    return text;
  }
  exportSnapshot(bookId) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId),
        book = await this.#storage.manifest(root),
        chapters = [];
      for (const chapter of orderedChapters(book)) {
        const body = await readUtf8File(
          await this.#storage.path(root, `manuscript/${chapter.id}.md`),
        );
        chapters.push({ ...chapter, body, diskHash: digest(body) });
      }
      return { book, chapters, capturedAt: new Date().toISOString() };
    });
  }
  createBackup(bookId, destination, { maxBytes = 512 * 1024 * 1024 } = {}) {
    return this.#storage.exclusive(async () => {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 512 * 1024 * 1024
      )
        throw new Error("备份容量限制无效");
      const root = await this.#storage.bookRoot(bookId);
      await this.#storage.manifest(root);
      const requestedParent = resolve(destination);
      if (withinDirectory(root, requestedParent))
        throw new Error("备份位置不能位于作品目录内部");
      if (withinDirectory(this.root, requestedParent))
        throw new Error("备份位置不能位于受管书库内部，请选择独立目录");
      const [canonicalLibrary, parent] = await Promise.all([
        realpath(this.root),
        canonicalDestination(requestedParent),
      ]);
      if (withinDirectory(canonicalLibrary, parent))
        throw new Error("备份位置经目录别名指向受管书库内部，未创建备份");
      const inventory = async () => {
        const found = [];
        let total = 0;
        const walk = async (directory, prefix = "") => {
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          })) {
            if (entry.isSymbolicLink())
              throw new Error("备份不跟随链接，请移除外部链接后重试");
            if (entry.name.endsWith(".tmp")) continue;
            const name = prefix + entry.name,
              source = await this.#storage.path(root, name);
            if (entry.isDirectory()) await walk(source, name + "/");
            else {
              const info = await lstat(source);
              if (!entry.isFile() || !info.isFile())
                throw new Error("备份包含不能安全读取的文件");
              total += info.size;
              if (total > maxBytes)
                throw new Error(
                  "备份超过当前容量限制（最多512MiB），未生成正式备份，请减少资源或另行保留完整目录副本",
                );
              if (found.length >= 100000)
                throw new Error("备份文件数量超过当前恢复上限");
              found.push({ path: name, bytes: info.size });
            }
          }
        };
        await walk(root);
        return found;
      };
      // Check capacity before creating a staging directory; images must not produce an unrestorable backup.
      const planned = await inventory(),
        id = randomUUID(),
        staging = join(parent, ".zinovel-backup-" + id + ".tmp"),
        final = join(parent, "zinovel-backup-" + id),
        files = [];
      await mkdir(staging, { recursive: true });
      let copied = 0;
      for (const item of planned) {
        const source = await this.#storage.path(root, item.path),
          info = await lstat(source);
        if (!info.isFile() || info.size !== item.bytes)
          throw new Error("备份期间文件被外部修改，请重新备份");
        const bytes = await readFile(source);
        copied += bytes.length;
        if (bytes.length !== item.bytes || copied > maxBytes)
          throw new Error("备份期间文件大小改变，未生成正式备份");
        const target = join(staging, item.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        files.push({
          path: item.path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      for (const file of files) {
        const bytes = await readFile(await this.#storage.path(root, file.path));
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
          throw new Error("备份期间文件被外部修改，请重新备份");
      }
      const current = await inventory(),
        before = new Map(planned.map((item) => [item.path, item.bytes]));
      if (
        current.length !== planned.length ||
        current.some((item) => before.get(item.path) !== item.bytes)
      )
        throw new Error("备份期间目录被外部修改，请重新备份");
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
    return this.#storage.exclusive(async () => {
      const root = resolve(source);
      if ((await lstat(root)).isSymbolicLink())
        throw new Error("备份根目录不能是链接");
      const manifest = JSON.parse(
        await readUtf8File(
          await this.#storage.path(root, "backup-manifest.json"),
        ),
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
        const path = await this.#storage.path(root, file.path),
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
        decodeUtf8(contents.get("book.json") || Buffer.from("{}")),
      );
      if (book.schemaVersion !== 1 || !Array.isArray(book.chapters))
        throw new Error("备份作品格式不支持");
      const sourceBookIds = publicationOriginIds(book);
      if (sourceBookIds.length > 128)
        throw new Error("恢复来源链达到当前上限，原备份已保留");
      for (const chapter of book.chapters)
        if (!contents.has(`manuscript/${checkedId(chapter.id)}.md`))
          throw new Error("备份缺少章节正文");
      if (
        decodeUtf8(
          contents.get(".zinovel/pending.json") || Buffer.alloc(0),
        ).trim()
      )
        throw new Error("备份含有未完成事务，请先在原位置恢复");
      const id = randomUUID(),
        staging = join(this.root, `.restore-${id}`),
        final = join(this.root, id);
      await mkdir(staging, { recursive: true });
      for (const [path, bytes] of contents) {
        const target = await this.#storage.path(staging, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      book.id = id;
      book.restoredFromBookIds = sourceBookIds;
      book.title = `${book.title}（恢复）`;
      book.revision++;
      book.updatedAt = new Date().toISOString();
      await atomic(join(staging, "book.json"), json(book));
      await rename(staging, final);
      return book;
    });
  }
  readChapter(bookId, chapterId) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId),
        book = await this.#storage.manifest(root);
      const chapter = book.chapters.find((c) => c.id === checkedId(chapterId));
      if (!chapter) throw new Error("章节不存在");
      const body = await readUtf8File(
        await this.#storage.path(root, `manuscript/${chapterId}.md`),
      );
      return {
        ...chapter,
        body,
        diskHash: digest(body),
        externalChange: chapter.hash !== digest(body),
      };
    });
  }
  readAcceptanceReceipt(bookId, receiptId) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId);
      await this.#storage.manifest(root);
      const path = await this.#storage.path(
        root,
        `.zinovel/task-receipts/${checkedId(receiptId)}.json`,
      );
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 16384)
          throw new Error("接受回执格式无效");
        return JSON.parse(await readUtf8File(path));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  saveChapter(input, acceptanceReceipt = undefined) {
    return this.#storage.exclusive(async () => {
      if (
        typeof input.body !== "string" ||
        !input.body.isWellFormed() ||
        Buffer.byteLength(input.body) > 8 * 1024 * 1024
      )
        throw new Error("单章正文超过 8 MiB 或格式无效");
      const root = await this.#storage.bookRoot(input.bookId),
        book = await this.#storage.manifest(root);
      const chapter = book.chapters.find(
        (c) => c.id === checkedId(input.chapterId),
      );
      if (!chapter) throw new Error("章节不存在");
      const path = `manuscript/${chapter.id}.md`;
      const disk = await readUtf8File(await this.#storage.path(root, path));
      if (
        input.expectedRevision !== chapter.revision ||
        input.expectedHash !== digest(disk)
      )
        return {
          status: "conflict",
          current: { ...chapter, body: disk, diskHash: digest(disk) },
        };
      let receiptChanges = {};
      if (acceptanceReceipt) {
        const receipt = acceptanceReceipt;
        checkedId(receipt.id);
        checkedId(receipt.taskId);
        if (
          receipt.beforeHash !== digest(disk) ||
          receipt.afterHash !== digest(input.body)
        )
          throw new Error("接受回执与正文版本不匹配");
        const receiptPath = `.zinovel/task-receipts/${receipt.id}.json`;
        if (await readOptional(await this.#storage.path(root, receiptPath)))
          throw new Error("接受回执已存在，不能重复改稿");
        receiptChanges = {
          [receiptPath]: json({
            schemaVersion: 1,
            id: receipt.id,
            taskId: receipt.taskId,
            chapterId: chapter.id,
            beforeHash: receipt.beforeHash,
            afterHash: receipt.afterHash,
            at: new Date().toISOString(),
          }),
        };
      }
      chapter.title = titleOf(input.title);
      chapter.revision++;
      chapter.hash = digest(input.body);
      chapter.updatedAt = new Date().toISOString();
      book.updatedAt = chapter.updatedAt;
      book.revision++;
      await this.#storage.transaction(root, {
        [path]: input.body,
        "book.json": json(book),
        ...receiptChanges,
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
  archiveConflict(input) {
    return this.#storage.exclusive(async () => {
      for (const value of [input.localBody, input.baseBody ?? ""])
        if (
          typeof value !== "string" ||
          !value.isWellFormed() ||
          Buffer.byteLength(value) > 8 * 1024 * 1024
        )
          throw new Error("冲突副本格式无效或过大");
      const root = await this.#storage.bookRoot(input.bookId),
        book = await this.#storage.manifest(root);
      const chapter = book.chapters.find(
        (item) => item.id === checkedId(input.chapterId) && !item.deletedAt,
      );
      if (!chapter) throw new Error("章节不存在或已回收");
      const remoteBody = await readUtf8File(
        await this.#storage.path(root, `manuscript/${chapter.id}.md`),
      );
      if (
        digest(remoteBody) !== input.expectedRemoteHash ||
        chapter.revision !== input.expectedRemoteRevision
      )
        throw new Error(
          "磁盘稿再次改变，请重新打开章节核对；当前编辑仍在缓存中",
        );
      const record = {
        schemaVersion: 1,
        id: randomUUID(),
        chapterId: chapter.id,
        at: new Date().toISOString(),
        baseBody: input.baseBody ?? null,
        localBody: input.localBody,
        localTitle: titleOf(input.localTitle),
        remoteBody,
        remoteTitle: chapter.title,
        remoteHash: digest(remoteBody),
      };
      await this.#storage.transaction(root, {
        [`.zinovel/conflicts/${record.id}.json`]: json(record),
      });
      return {
        archiveId: record.id,
        current: { ...chapter, body: remoteBody, diskHash: record.remoteHash },
      };
    });
  }
  history(bookId, chapterId) {
    return this.#storage.exclusive(async () => {
      const root = await this.#storage.bookRoot(bookId),
        path = `manuscript/${checkedId(chapterId)}.md`;
      const directory = await this.#storage.path(root, ".zinovel/transactions");
      const versions = [];
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json")) continue;
        const transaction = JSON.parse(
          await readUtf8File(
            await this.#storage.path(root, `.zinovel/transactions/${file}`),
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
        for (const entry of transaction.entries) {
          if (!entry.path.startsWith(".zinovel/conflicts/") || !entry.after)
            continue;
          const record = JSON.parse(entry.after);
          if (record.chapterId !== chapterId) continue;
          for (const [key, label] of [
            ["localBody", "冲突前当前稿"],
            ["remoteBody", "冲突前磁盘稿"],
            ["baseBody", "冲突共同基线"],
          ])
            if (typeof record[key] === "string")
              versions.push({
                id: `${record.id}-${key}`,
                at: record.at,
                body: record[key],
                label,
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
