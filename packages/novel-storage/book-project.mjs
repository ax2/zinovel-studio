import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { decodeUtf8 } from "./encoding.mjs";
import { publicationOriginIds } from "./publication.mjs";
import {
  captureProjectDocuments,
  projectDocumentKind,
  projectScaffold,
  PROJECT_DOCUMENT_BYTES,
} from "../novel-domain/book-project.mjs";

const manifestPath = ".zinovel/project-assets.json";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const uuid = (id) =>
  typeof id === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const revision = (v) => Number.isSafeInteger(v) && v > 0 && v <= 1000000;
const historyPath = (id, rev) => `.zinovel/project-history/${id}/${rev}.json`;

async function readText(
  storage,
  root,
  path,
  optional = false,
  limit = PROJECT_DOCUMENT_BYTES,
) {
  let file;
  try {
    file = await open(
      await storage.path(root, path),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const before = await file.stat();
    if (!before.isFile() || before.size > limit)
      throw new Error("创作资产文件过大或不是普通文件");
    const bytes = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const after = await file.stat();
    if (
      read !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("创作资产在读取期间改变，请重新打开");
    return decodeUtf8(bytes.subarray(0, read));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

function validateManifest(value, book) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !publicationOriginIds(book).includes(value.bookId) ||
    !revision(value.revision) ||
    !Array.isArray(value.documents) ||
    !value.documents.length ||
    value.documents.length > 512
  )
    throw new Error("创作工程清单版本或来源无效，原文件已保留");
  const ids = new Set(),
    paths = new Set();
  let bytes = 0;
  for (const d of value.documents) {
    if (
      !d ||
      !uuid(d.id) ||
      !revision(d.revision) ||
      !sha(d.hash) ||
      d.kind !== projectDocumentKind(d.path) ||
      !["scaffold", "imported", "authored", "generated"].includes(d.origin) ||
      typeof d.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(d.updatedAt)) ||
      ids.has(d.id) ||
      paths.has(d.path.toLowerCase())
    )
      throw new Error("创作工程文档清单无效，原文件已保留");
    if (
      !Number.isSafeInteger(d.bytes) ||
      d.bytes < 0 ||
      d.bytes > PROJECT_DOCUMENT_BYTES
    )
      throw new Error("创作资产容量清单无效");
    bytes += d.bytes;
    ids.add(d.id);
    paths.add(d.path.toLowerCase());
  }
  if (bytes > 32 * 1024 * 1024) throw new Error("创作资产总量超过 32 MiB");
  return value;
}

export function createProjectChanges(book, documents, origin = "scaffold") {
  documents = captureProjectDocuments(documents);
  if (!["scaffold", "imported", "generated"].includes(origin))
    throw new Error("创作工程来源无效");
  const manifest = {
      schemaVersion: 1,
      bookId: book.id,
      revision: 1,
      documents: [],
    },
    changes = {};
  for (const { path, kind, text } of documents) {
    const entry = {
      id: randomUUID(),
      path,
      kind,
      revision: 1,
      hash: hash(text),
      bytes: Buffer.byteLength(text),
      origin,
      updatedAt: book.updatedAt,
    };
    manifest.documents.push(entry);
    changes[path] = text;
    changes[historyPath(entry.id, 1)] = json({
      schemaVersion: 1,
      bookId: book.id,
      writtenInBookId: book.id,
      document: entry,
      text,
    });
  }
  changes[manifestPath] = json(manifest);
  return { changes, manifest };
}

export class BookProjectStore {
  constructor(storage) {
    this.storage = storage;
  }
  async context(bookId) {
    const root = await this.storage.bookRoot(bookId),
      { book, raw: bookRaw } = await this.storage.manifestRecord(root);
    if (book.id !== bookId) throw new Error("作品身份不符");
    const raw = await readText(this.storage, root, manifestPath, true);
    const manifest =
      raw === null ? null : validateManifest(JSON.parse(raw), book);
    return { root, book, bookRaw, raw, manifest };
  }
  list(bookId) {
    return this.storage.exclusive(async () => {
      const { manifest } = await this.context(bookId);
      return manifest
        ? {
            initialized: true,
            revision: manifest.revision,
            documents: manifest.documents,
          }
        : { initialized: false, documents: [] };
    });
  }
  initialize(bookId) {
    return this.storage.exclusive(async () => {
      const c = await this.context(bookId);
      if (c.manifest) throw new Error("创作工程已经存在，请刷新");
      const { changes, manifest } = createProjectChanges(
        c.book,
        projectScaffold(c.book.title),
      );
      await this.storage.transaction(c.root, changes, {
        expectedBefore: Object.fromEntries(
          Object.keys(changes).map((p) => [p, null]),
        ),
        expectedReadOnly: { "book.json": c.bookRaw },
      });
      return manifest;
    });
  }
  async current(bookId, id) {
    const c = await this.context(bookId),
      entry = c.manifest?.documents.find((d) => d.id === id);
    if (!entry) throw new Error("创作资产不存在");
    const text = await readText(this.storage, c.root, entry.path);
    return { ...c, entry, text, diskHash: hash(text) };
  }
  read(bookId, id) {
    return this.storage.exclusive(async () => {
      const c = await this.current(bookId, id);
      return {
        ...c.entry,
        text: c.text,
        diskHash: c.diskHash,
        externalChange: c.entry.hash !== c.diskHash,
      };
    });
  }
  create(bookId, input) {
    let document;
    try {
      document = captureProjectDocuments([
        { path: input?.path, text: input?.text },
      ])[0];
    } catch (error) {
      return Promise.reject(error);
    }
    return this.storage.exclusive(async () => {
      const c = await this.context(bookId);
      if (!c.manifest) throw new Error("请先建立创作工程");
      if (
        c.manifest.documents.length >= 512 ||
        c.manifest.documents.some(
          (d) => d.path.toLowerCase() === document.path.toLowerCase(),
        )
      )
        throw new Error("资产已存在或数量达到上限");
      const entry = {
        id: randomUUID(),
        path: document.path,
        kind: document.kind,
        revision: 1,
        hash: hash(document.text),
        bytes: Buffer.byteLength(document.text),
        origin: "authored",
        updatedAt: new Date().toISOString(),
      };
      c.manifest.documents.push(entry);
      c.manifest.revision++;
      validateManifest(c.manifest, c.book);
      const hp = historyPath(entry.id, 1);
      await this.storage.transaction(
        c.root,
        {
          [entry.path]: document.text,
          [manifestPath]: json(c.manifest),
          [hp]: json({
            schemaVersion: 1,
            bookId: c.manifest.bookId,
            writtenInBookId: c.book.id,
            document: entry,
            text: document.text,
          }),
        },
        {
          expectedBefore: {
            [entry.path]: null,
            [hp]: null,
            [manifestPath]: c.raw,
          },
          expectedReadOnly: { "book.json": c.bookRaw },
        },
      );
      return {
        ...entry,
        text: document.text,
        diskHash: entry.hash,
        externalChange: false,
      };
    });
  }
  save(bookId, input) {
    // Snapshot exactly the fields consumed, before joining the single writer queue.
    try {
      input = {
        id: input?.id,
        revision: input?.revision,
        diskHash: input?.diskHash,
        text: input?.text,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    return this.storage.exclusive(async () => {
      const c = await this.current(bookId, input.id);
      if (
        input.revision !== c.entry.revision ||
        input.diskHash !== c.diskHash ||
        !sha(input.diskHash)
      )
        throw new Error("创作资产已改变，未覆盖磁盘；请保留编辑内容后重新读取");
      captureProjectDocuments([{ path: c.entry.path, text: input.text }]);
      if (c.entry.revision >= 1000000 || c.manifest.revision >= 1000000)
        throw new Error("创作资产版本达到上限");
      const previous = { ...c.entry };
      Object.assign(c.entry, {
        revision: c.entry.revision + 1,
        hash: hash(input.text),
        bytes: Buffer.byteLength(input.text),
        origin: "authored",
        updatedAt: new Date().toISOString(),
      });
      c.manifest.revision++;
      validateManifest(c.manifest, c.book);
      const path = historyPath(c.entry.id, c.entry.revision);
      await this.storage.transaction(
        c.root,
        {
          [c.entry.path]: input.text,
          [manifestPath]: json(c.manifest),
          [path]: json({
            schemaVersion: 1,
            bookId: c.manifest.bookId,
            writtenInBookId: c.book.id,
            document: c.entry,
            text: input.text,
            before: { document: previous, diskHash: c.diskHash, text: c.text },
          }),
        },
        {
          expectedBefore: {
            [c.entry.path]: c.text,
            [manifestPath]: c.raw,
            [path]: null,
          },
          expectedReadOnly: { "book.json": c.bookRaw },
        },
      );
      return {
        ...c.entry,
        text: input.text,
        diskHash: c.entry.hash,
        externalChange: false,
      };
    });
  }
  history(bookId, id, rev) {
    return this.storage.exclusive(async () => {
      const c = await this.context(bookId),
        entry = c.manifest?.documents.find((d) => d.id === id);
      if (!entry || !revision(rev) || rev > entry.revision)
        throw new Error("创作资产历史版本无效");
      const value = JSON.parse(
        await readText(
          this.storage,
          c.root,
          historyPath(id, rev),
          false,
          128 * 1024 * 1024,
        ),
      );
      if (
        value.schemaVersion !== 1 ||
        value.bookId !== c.manifest.bookId ||
        !publicationOriginIds(c.book).includes(value.writtenInBookId) ||
        value.document?.id !== id ||
        value.document?.path !== entry.path ||
        value.document?.revision !== rev ||
        typeof value.text !== "string" ||
        hash(value.text) !== value.document?.hash
      )
        throw new Error("创作资产历史校验失败，原文件已保留");
      if (
        value.before &&
        (typeof value.before.text !== "string" ||
          hash(value.before.text) !== value.before.diskHash)
      )
        throw new Error("创作资产外部修改历史校验失败");
      return value;
    });
  }
}
