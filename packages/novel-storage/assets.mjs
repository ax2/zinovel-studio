import { open, mkdir, readdir, lstat, link, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readUtf8File } from "./encoding.mjs";
import {
  assetId,
  assetHash,
  assetInput,
  assetLimits,
  validateAssetRecord,
} from "../novel-domain/assets.mjs";
import { assetCreationHash } from "../novel-domain/asset-creation-hash.mjs";
import { publicationOriginIds } from "./publication.mjs";
import {
  binaryHash,
  inspectAssetImage,
  copyImageBytes,
} from "./image-decoder.mjs";

const json = (data) => JSON.stringify(data, null, 2) + "\n";
const fields = (record) =>
  Object.fromEntries(
    ["title", "purpose", "source", "rights", "notes", "linkedIds"].map(
      (key) => [key, record[key]],
    ),
  );
export class AssetStore {
  #decoding = 0;
  #decodeWaiters = [];
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
  }
  async context(bookId) {
    const root = await this.storage.bookRoot(assetId(bookId)),
      book = await this.storage.manifest(root);
    if (book.id !== bookId) throw new Error("图像所属作品不符");
    return { root, book, origins: publicationOriginIds(book) };
  }
  async decode(bytes, previewEdge, { wait = false } = {}) {
    const captured = wait ? copyImageBytes(bytes) : bytes;
    if (this.#decoding >= 2) {
      if (!wait) throw new Error("图像处理繁忙，请等待当前预览或导入完成");
      // A received paid candidate can wait for the same two decoding slots.
      // Release transfers a reserved slot, so new previews cannot steal it.
      await new Promise((resolve) => this.#decodeWaiters.push(resolve));
    } else this.#decoding++;
    try {
      return await inspectAssetImage(captured, previewEdge);
    } finally {
      const next = this.#decodeWaiters.shift();
      if (next) next();
      else this.#decoding--;
    }
  }
  async record(ctx, id, historical = null) {
    assetId(id);
    const path = historical
      ? `.zinovel/asset-history/${id}/${this.expected(historical).revision}-${historical.diskHash}.json`
      : `assets/items/${id}.json`;
    const file = await this.storage.path(ctx.root, path);
    if ((await lstat(file)).size > 128 * 1024)
      throw new Error("图像记录过大，请保留原文件");
    const raw = await readUtf8File(file),
      data = JSON.parse(raw),
      diskHash = binaryHash(Buffer.from(raw));
    validateAssetRecord(data, id, ctx.origins);
    if (
      historical &&
      (diskHash !== historical.diskHash ||
        data.revision !== historical.revision)
    )
      throw new Error("图像历史校验失败");
    return { data, raw, diskHash, path };
  }
  expected(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new Error("请重新打开图像资源核对版本");
    return {
      id: assetId(value.id),
      revision: value.revision,
      diskHash: assetHash(value.diskHash),
    };
  }
  async current(ctx, value) {
    const expected = this.expected(value),
      previous = await this.record(ctx, expected.id);
    if (
      previous.data.revision !== expected.revision ||
      previous.diskHash !== expected.diskHash
    )
      throw new Error(
        "图像资源已被其他操作修改，当前调整已保留，请重新读取后对照",
      );
    return previous;
  }
  view(record) {
    return { ...record.data, diskHash: record.diskHash };
  }
  async blobBytes(ctx, blob) {
    const file = await this.storage.path(
      ctx.root,
      `assets/blobs/${blob.sha256}.${blob.format}`,
    );
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.size !== blob.bytes ||
      stat.size > assetLimits.bytes
    )
      throw new Error("原图丢失、大小改变或不能读取，请保留作品目录");
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(blob.bytes + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (
        bytesRead !== blob.bytes ||
        binaryHash(bytes.subarray(0, bytesRead)) !== blob.sha256
      )
        throw new Error("原图字节校验失败，请保留原文件");
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  async putBlob(ctx, image) {
    const path = await this.storage.path(
      ctx.root,
      `assets/blobs/${image.blob.sha256}.${image.blob.format}`,
    );
    await mkdir(dirname(path), { recursive: true });
    try {
      await lstat(path);
      await this.blobBytes(ctx, image.blob);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = await this.storage.path(
      ctx.root,
      `assets/blobs/.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(image.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Hard-link publication is create-only; rename() could overwrite another writer's file.
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw new Error(
          "当前磁盘不能安全创建原图，请保留图像临时文件并选择支持硬链接的本地书库",
        );
    }
    await this.blobBytes(ctx, image.blob);
    await unlink(temporary);
  }
  async links(ctx, input, previous) {
    for (const id of input.linkedIds) {
      if (previous?.linkedIds.includes(id)) continue;
      const target = await this.materials.record(ctx.root, id);
      if (target.data.deletedAt)
        throw new Error("关联资料已删除，请先恢复资料");
    }
  }
  linkOptions(bookId, ids) {
    if (
      !Array.isArray(ids) ||
      ids.length > 32 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("图像关联选择无效");
    const selected = ids.map(assetId);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        items = [];
      for (const id of selected) {
        try {
          const record = await this.materials.record(ctx.root, id);
          items.push({
            id,
            title: record.data.title,
            kind: record.data.kind,
            state: record.data.deletedAt ? "deleted" : "active",
          });
        } catch {
          items.push({ id, title: "关联资料暂不能读取", state: "missing" });
        }
      }
      return items;
    });
  }
  async commit(ctx, next, previous) {
    validateAssetRecord(next, next.id, ctx.origins);
    const raw = json(next);
    if (Buffer.byteLength(raw) > 128 * 1024)
      throw new Error("图像说明保存后过大，请缩短说明；当前调整已保留");
    const path = `assets/items/${next.id}.json`,
      changes = { [path]: raw },
      expectedBefore = { [path]: previous?.raw ?? null };
    if (previous) {
      const history = `.zinovel/asset-history/${next.id}/${previous.data.revision}-${previous.diskHash}.json`;
      changes[history] = previous.raw;
      expectedBefore[history] = null;
    }
    await this.storage.transaction(ctx.root, changes, { expectedBefore });
    return this.view({
      data: next,
      diskHash: binaryHash(Buffer.from(json(next))),
    });
  }
  // Internal preparation; caller holds the shared kernel. No writes or nested lock.
  async prepareImport(ctx, image, input, creationId) {
    const data = assetInput(input),
      creationHash = assetCreationHash(
        creationId,
        ctx.book.id,
        data,
        image.blob,
      );
    let existing;
    try {
      existing = await this.record(ctx, creationId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.data.creationHash !== creationHash)
        throw new Error(
          "该导入身份已经保存其他内容，请先查看已保存图像再开始新的导入",
        );
      return { existing };
    }
    await this.links(ctx, data, null);
    const at = new Date().toISOString(),
      next = {
        schemaVersion: 1,
        id: creationId,
        creationHash,
        bookId: ctx.book.id,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        ...data,
        blob: image.blob,
      };
    validateAssetRecord(next, creationId, ctx.origins);
    const raw = json(next);
    if (Buffer.byteLength(raw) > 128 * 1024)
      throw new Error("图像说明保存后过大，请缩短说明；当前调整已保留");
    return { next, raw, path: `assets/items/${creationId}.json` };
  }
  async import(bookId, bytes, input, creationId = randomUUID()) {
    assetId(creationId);
    const data = assetInput(input),
      capturedBytes = copyImageBytes(bytes);
    await this.storage.exclusive(() => this.context(bookId));
    const image = await this.decode(capturedBytes);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      const prepared = await this.prepareImport(ctx, image, data, creationId);
      if (prepared.existing) return this.view(prepared.existing);
      await this.putBlob(ctx, image);
      return this.commit(ctx, prepared.next, null);
    });
  }
  read(bookId, id) {
    return this.storage.exclusive(async () =>
      this.view(await this.record(await this.context(bookId), assetId(id))),
    );
  }
  creation(bookId, id) {
    assetId(id);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      try {
        return this.view(await this.record(ctx, id));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  async list(bookId, options = {}) {
    const { query = "", purpose = "", deleted = false, offset = 0 } = options;
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      typeof deleted !== "boolean" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (purpose &&
        !["cover", "portrait", "map", "illustration", "reference"].includes(
          purpose,
        ))
    )
      throw new Error("图像检索条件无效");
    const ctx = await this.storage.exclusive(() => this.context(bookId));
    let entries;
    try {
      entries = await readdir(
        await this.storage.path(ctx.root, "assets/items"),
        { withFileTypes: true },
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries = [];
    }
    const items = [],
      errors = [];
    for (let start = 0; start < entries.length; start += 16)
      await this.storage.exclusive(async () => {
        const fresh = await this.context(bookId);
        for (const entry of entries.slice(start, start + 16)) {
          try {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
              throw new Error();
            const record = await this.record(fresh, entry.name.slice(0, -5)),
              data = record.data;
            if (
              !!data.deletedAt !== deleted ||
              (purpose && data.purpose !== purpose) ||
              (query &&
                ![data.title, data.source, data.rights, data.notes]
                  .join("\n")
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()))
            )
              continue;
            items.push(this.view(record));
          } catch {
            errors.push("一份图像资源无法读取，原始文件已保留");
          }
        }
      });
    items.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    return {
      items: items.slice(offset, offset + 40),
      total: items.length,
      errors,
    };
  }
  async preview(bookId, value, historical = false) {
    const expected = this.expected(value);
    if (typeof historical !== "boolean") throw new Error("图像预览条件无效");
    const initial = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      await this.record(ctx, expected.id);
      const record = historical
        ? await this.record(ctx, expected.id, expected)
        : await this.current(ctx, expected);
      return { record, bytes: await this.blobBytes(ctx, record.data.blob) };
    });
    const image = await this.decode(initial.bytes);
    if (
      Object.keys(image.blob).some(
        (key) => image.blob[key] !== initial.record.data.blob[key],
      )
    )
      throw new Error("原图尺寸或格式与记录不符，请保留原件");
    await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      if (historical) await this.record(ctx, expected.id, expected);
      else await this.current(ctx, expected);
      await this.blobBytes(ctx, initial.record.data.blob);
    });
    return {
      id: expected.id,
      diskHash: expected.diskHash,
      blob: image.blob,
      dataUrl: `data:image/png;base64,${image.thumbnail.toString("base64")}`,
    };
  }
  save(bookId, input, value) {
    const data = assetInput(input),
      expected = this.expected(value);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站图像");
      await this.links(ctx, data, previous.data);
      await this.blobBytes(ctx, previous.data.blob);
      return this.commit(
        ctx,
        {
          ...previous.data,
          ...data,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
  async replace(bookId, bytes, value) {
    const expected = this.expected(value),
      capturedBytes = copyImageBytes(bytes);
    await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      const p = await this.current(ctx, expected);
      if (p.data.deletedAt) throw new Error("请先恢复图像");
    });
    const image = await this.decode(capturedBytes);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected);
      if (previous.data.deletedAt) throw new Error("请先恢复图像");
      await this.putBlob(ctx, image);
      return this.commit(
        ctx,
        {
          ...previous.data,
          blob: image.blob,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
  setDeleted(bookId, value, deleted) {
    const expected = this.expected(value);
    if (typeof deleted !== "boolean") throw new Error("图像回收操作无效");
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected);
      const next = {
        ...previous.data,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (deleted) next.deletedAt = new Date().toISOString();
      else delete next.deletedAt;
      return this.commit(ctx, next, previous);
    });
  }
  async restoreVersion(bookId, currentValue, historicalValue) {
    const current = this.expected(currentValue),
      historical = this.expected(historicalValue);
    if (current.id !== historical.id)
      throw new Error("只能采用当前资源自身的历史版本");
    const captured = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, current);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站图像");
      const selected = await this.record(ctx, current.id, historical);
      return { selected, bytes: await this.blobBytes(ctx, selected.data.blob) };
    });
    const image = await this.decode(captured.bytes);
    if (
      Object.keys(image.blob).some(
        (key) => image.blob[key] !== captured.selected.data.blob[key],
      )
    )
      throw new Error("历史原图尺寸或格式与记录不符");
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, current),
        selected = await this.record(ctx, current.id, historical);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站图像");
      await this.blobBytes(ctx, selected.data.blob);
      return this.commit(
        ctx,
        {
          ...previous.data,
          ...fields(selected.data),
          blob: selected.data.blob,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
  history(bookId, id) {
    assetId(id);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      await this.record(ctx, id);
      let names;
      try {
        names = await readdir(
          await this.storage.path(ctx.root, `.zinovel/asset-history/${id}`),
        );
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const items = [];
      for (const name of names
        .filter((n) => /^\d+-[a-f0-9]{64}\.json$/.test(n))
        .sort((a, b) => parseInt(b) - parseInt(a))
        .slice(0, 40)) {
        const expected = {
          id,
          revision: parseInt(name),
          diskHash: name.slice(name.indexOf("-") + 1, -5),
        };
        items.push(this.view(await this.record(ctx, id, expected)));
      }
      return items;
    });
  }
}
