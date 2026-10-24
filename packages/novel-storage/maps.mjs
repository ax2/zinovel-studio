import { lstat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  mapId,
  mapHash,
  mapInput,
  mapLimits,
  validateMapRecord,
} from "../novel-domain/maps.mjs";
import { binaryHash } from "./image-decoder.mjs";
import { readUtf8File } from "./encoding.mjs";
import { publicationOriginIds } from "./publication.mjs";

const fields = (value) =>
  Object.fromEntries(
    ["title", "notes", "era", "canvas", "scale", "elements"].map((key) => [
      key,
      value[key],
    ]),
  );
const json = (data) => JSON.stringify(data, null, 2) + "\n";
export class MapStore {
  constructor(storage, materials, assets) {
    this.storage = storage;
    this.materials = materials;
    this.assets = assets;
  }
  async context(bookId) {
    const root = await this.storage.bookRoot(mapId(bookId)),
      book = await this.storage.manifest(root);
    if (book.id !== bookId) throw new Error("地图所属作品不符");
    return { root, book, origins: publicationOriginIds(book) };
  }
  expected(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new Error("请重新打开地图核对版本");
    return {
      id: mapId(value.id),
      revision: value.revision,
      diskHash: mapHash(value.diskHash),
    };
  }
  async record(ctx, id, historical = null) {
    mapId(id);
    const path = historical
      ? `.zinovel/map-history/${id}/${this.expected(historical).revision}-${historical.diskHash}.json`
      : `world/maps/${id}.json`;
    const file = await this.storage.path(ctx.root, path),
      stat = await lstat(file);
    if (!stat.isFile() || stat.size > mapLimits.bytes)
      throw new Error("地图文件过大或不能读取，请保留原文件");
    const raw = await readUtf8File(file),
      data = JSON.parse(raw),
      diskHash = binaryHash(Buffer.from(raw));
    validateMapRecord(data, id, ctx.origins);
    if (
      historical &&
      (data.revision !== historical.revision ||
        diskHash !== historical.diskHash)
    )
      throw new Error("地图历史校验失败，请保留原文件");
    return { data, raw, diskHash, path };
  }
  async current(ctx, value) {
    const expected = this.expected(value),
      previous = await this.record(ctx, expected.id);
    if (
      previous.data.revision !== expected.revision ||
      previous.diskHash !== expected.diskHash
    )
      throw new Error("地图已被其他操作修改，当前调整已保留，请重新读取后对照");
    return previous;
  }
  view(record) {
    return { ...record.data, diskHash: record.diskHash };
  }
  async links(ctx, data, previous) {
    const prior = new Map((previous?.elements ?? []).map((e) => [e.id, e])),
      next = new Map(data.elements.map((e) => [e.id, e])),
      checkedLocations = new Set();
    for (const old of prior.values()) {
      const current = next.get(old.id);
      if (!current)
        throw new Error("请回收已保存的地图对象以保留身份，不要直接移除");
      if (current.kind !== old.kind)
        throw new Error("地图对象不能沿用同一身份改变类型");
    }
    for (const element of data.elements) {
      const old = prior.get(element.id);
      if (element.kind === "route") {
        for (const key of ["fromId", "toId"]) {
          if (old?.[key] === element[key]) continue;
          const endpoint = next.get(element[key]);
          if (!endpoint || endpoint.kind !== "place" || endpoint.deletedAt)
            throw new Error("新路线端点必须是本图未回收地点");
        }
      } else if (
        element.locationId &&
        old?.locationId !== element.locationId &&
        !checkedLocations.has(element.locationId)
      ) {
        const target = await this.materials.record(
          ctx.root,
          element.locationId,
        );
        if (target.data.kind !== "location" || target.data.deletedAt)
          throw new Error("新关联必须是本书未回收的地点资料");
        checkedLocations.add(element.locationId);
      }
    }
  }
  normalize(data, previous) {
    const prior = new Map((previous?.elements ?? []).map((e) => [e.id, e]));
    return {
      ...data,
      elements: data.elements.map((e) => {
        if (!e.deletedAt) return e;
        return {
          ...e,
          deletedAt: prior.get(e.id)?.deletedAt ?? new Date().toISOString(),
        };
      }),
    };
  }
  async commit(ctx, next, previous) {
    validateMapRecord(next, next.id, ctx.origins);
    const raw = json(next);
    if (Buffer.byteLength(raw) > mapLimits.bytes)
      throw new Error("地图保存后超过1MiB，请拆分地图；当前调整已保留");
    const path = `world/maps/${next.id}.json`,
      changes = { [path]: raw },
      expectedBefore = { [path]: previous?.raw ?? null };
    if (previous) {
      const history = `.zinovel/map-history/${next.id}/${previous.data.revision}-${previous.diskHash}.json`;
      changes[history] = previous.raw;
      expectedBefore[history] = null;
    }
    await this.storage.transaction(ctx.root, changes, { expectedBefore });
    return this.view({ data: next, diskHash: binaryHash(Buffer.from(raw)) });
  }
  /** @param {string} bookId @param {unknown} input @param {string} [creationId] */
  create(bookId, input, creationId = randomUUID()) {
    mapId(creationId);
    const data = mapInput(input),
      creationHash = binaryHash(
        Buffer.from(JSON.stringify({ id: creationId, bookId, input: data })),
      );
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      let existing;
      try {
        existing = await this.record(ctx, creationId);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing) {
        if (existing.data.creationHash !== creationHash)
          throw new Error("此地图创建身份已保存其他内容，请先查看已保存地图");
        return this.view(existing);
      }
      await this.links(ctx, data, null);
      const at = new Date().toISOString();
      return this.commit(
        ctx,
        {
          schemaVersion: 1,
          id: creationId,
          bookId,
          creationHash,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          ...this.normalize(data),
          background: null,
        },
        null,
      );
    });
  }
  read(bookId, id) {
    mapId(id);
    return this.storage.exclusive(async () =>
      this.view(await this.record(await this.context(bookId), id)),
    );
  }
  creation(bookId, id) {
    mapId(id);
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
  save(bookId, input, value) {
    const data = mapInput(input),
      expected = this.expected(value);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站地图");
      const frameChanged =
        data.canvas.width !== previous.data.canvas.width ||
        data.canvas.height !== previous.data.canvas.height;
      if (previous.data.background && frameChanged)
        throw new Error("冻结底图的画布尺寸不可直接修改，请先移除底图");
      if (frameChanged && data.scale)
        throw new Error("改变画布尺寸时请明确清除比例尺，保存后重新标定");
      await this.links(ctx, data, previous.data);
      return this.commit(
        ctx,
        {
          ...previous.data,
          ...this.normalize(data, previous.data),
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
  setDeleted(bookId, value, deleted) {
    const expected = this.expected(value);
    if (typeof deleted !== "boolean") throw new Error("地图回收操作无效");
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected);
      const next = {
        ...previous.data,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (deleted)
        next.deletedAt = previous.data.deletedAt ?? new Date().toISOString();
      else delete next.deletedAt;
      return this.commit(ctx, next, previous);
    });
  }
  async list(bookId, options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !["query", "deleted", "offset"].includes(key),
      )
    )
      throw new Error("地图检索条件无效");
    const { query = "", deleted = false, offset = 0 } = options;
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      typeof deleted !== "boolean" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("地图检索条件无效");
    const entries = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      try {
        return await readdir(await this.storage.path(ctx.root, "world/maps"), {
          withFileTypes: true,
        });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    });
    const items = [],
      errors = [];
    for (let start = 0; start < entries.length; start += 4)
      await this.storage.exclusive(async () => {
        const ctx = await this.context(bookId);
        for (const entry of entries.slice(start, start + 4)) {
          try {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
              throw new Error();
            const record = await this.record(ctx, entry.name.slice(0, -5)),
              data = record.data;
            if (
              !!data.deletedAt !== deleted ||
              (query &&
                ![data.title, data.era, data.notes]
                  .join("\n")
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()))
            )
              continue;
            items.push({
              id: data.id,
              title: data.title,
              era: data.era,
              revision: data.revision,
              diskHash: record.diskHash,
              updatedAt: data.updatedAt,
              deletedAt: data.deletedAt,
              backgroundTitle: data.background?.record.title ?? null,
              places: data.elements.filter(
                (e) => e.kind === "place" && !e.deletedAt,
              ).length,
              regions: data.elements.filter(
                (e) => e.kind === "region" && !e.deletedAt,
              ).length,
              routes: data.elements.filter(
                (e) => e.kind === "route" && !e.deletedAt,
              ).length,
            });
          } catch {
            errors.push("一份地图无法读取，原始文件已保留");
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
  history(bookId, id) {
    mapId(id);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      await this.record(ctx, id);
      let names;
      try {
        names = await readdir(
          await this.storage.path(ctx.root, `.zinovel/map-history/${id}`),
        );
      } catch (error) {
        if (error.code === "ENOENT") return { items: [], errors: [] };
        throw error;
      }
      const items = [],
        errors = [],
        supported = names.filter((name) =>
          /^[1-9]\d*-[a-f0-9]{64}\.json$/.test(name),
        );
      if (supported.length !== names.length)
        errors.push("有不支持的地图历史文件，原件已保留");
      for (const name of supported
        .sort((a, b) => parseInt(b) - parseInt(a))
        .slice(0, 40)) {
        try {
          const expected = {
            id,
            revision: parseInt(name),
            diskHash: name.slice(name.indexOf("-") + 1, -5),
          };
          items.push(this.view(await this.record(ctx, id, expected)));
        } catch {
          errors.push("一份地图历史校验失败，原件已保留");
        }
      }
      return { items, errors };
    });
  }
  async setBackground(bookId, value, assetValue, historical = false) {
    const expected = this.expected(value);
    if (typeof historical !== "boolean") throw new Error("底图选择条件无效");
    if (assetValue === null)
      return this.storage.exclusive(async () => {
        const ctx = await this.context(bookId),
          previous = await this.current(ctx, expected);
        if (previous.data.deletedAt) throw new Error("请先恢复地图");
        return this.commit(
          ctx,
          {
            ...previous.data,
            background: null,
            revision: previous.data.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          previous,
        );
      });
    const assetExpected = this.assets.expected(assetValue);
    const selected = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected),
        currentAsset = await this.assets.record(ctx, assetExpected.id);
      if (previous.data.deletedAt || currentAsset.data.deletedAt)
        throw new Error("请先恢复地图和原图资源");
      const asset = historical
        ? await this.assets.record(ctx, assetExpected.id, assetExpected)
        : await this.assets.current(ctx, assetExpected);
      return {
        record: asset,
        bytes: await this.assets.blobBytes(ctx, asset.data.blob),
      };
    });
    await this.verifyImage(selected.record.data.blob, selected.bytes);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected),
        currentAsset = await this.assets.record(ctx, assetExpected.id);
      if (previous.data.deletedAt || currentAsset.data.deletedAt)
        throw new Error("请先恢复地图和原图资源");
      const asset = historical
        ? await this.assets.record(ctx, assetExpected.id, assetExpected)
        : await this.assets.current(ctx, assetExpected);
      await this.assets.blobBytes(ctx, asset.data.blob);
      const changed =
        previous.data.background?.record.blob.sha256 !== asset.data.blob.sha256;
      return this.commit(
        ctx,
        {
          ...previous.data,
          background: { record: asset.data, diskHash: asset.diskHash },
          canvas: {
            width: asset.data.blob.displayWidth,
            height: asset.data.blob.displayHeight,
          },
          scale: changed ? null : previous.data.scale,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
  async verifyImage(blob, bytes, previewEdge) {
    const image = await this.assets.decode(bytes, previewEdge);
    if (Object.keys(image.blob).some((key) => image.blob[key] !== blob[key]))
      throw new Error("冻结地图底图尺寸或格式与记录不符，请保留原件");
    return image;
  }
  async backgroundPreview(bookId, value, historical = false) {
    if (typeof historical !== "boolean") throw new Error("地图预览条件无效");
    const expected = this.expected(value),
      initial = await this.storage.exclusive(async () => {
        const ctx = await this.context(bookId);
        await this.record(ctx, expected.id);
        const record = historical
          ? await this.record(ctx, expected.id, expected)
          : await this.current(ctx, expected);
        if (!record.data.background) return null;
        return {
          record,
          bytes: await this.assets.blobBytes(
            ctx,
            record.data.background.record.blob,
          ),
        };
      });
    if (!initial) return { background: null };
    const image = await this.verifyImage(
      initial.record.data.background.record.blob,
      initial.bytes,
      2048,
    );
    await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId);
      if (historical) await this.record(ctx, expected.id, expected);
      else await this.current(ctx, expected);
      await this.assets.blobBytes(
        ctx,
        initial.record.data.background.record.blob,
      );
    });
    return {
      background: initial.record.data.background,
      dataUrl: `data:image/png;base64,${image.thumbnail.toString("base64")}`,
    };
  }
  async restoreVersion(bookId, value, historyValue) {
    const expected = this.expected(value),
      historical = this.expected(historyValue);
    if (expected.id !== historical.id)
      throw new Error("只能采用当前地图自身的历史版本");
    const initial = await this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected),
        selected = await this.record(ctx, expected.id, historical);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站地图");
      return {
        selected,
        bytes: selected.data.background
          ? await this.assets.blobBytes(
              ctx,
              selected.data.background.record.blob,
            )
          : null,
      };
    });
    if (initial.bytes)
      await this.verifyImage(
        initial.selected.data.background.record.blob,
        initial.bytes,
      );
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId),
        previous = await this.current(ctx, expected),
        selected = await this.record(ctx, expected.id, historical);
      if (previous.data.deletedAt) throw new Error("请先恢复回收站地图");
      if (selected.data.background)
        await this.assets.blobBytes(ctx, selected.data.background.record.blob);
      return this.commit(
        ctx,
        {
          ...previous.data,
          ...fields(selected.data),
          background: selected.data.background,
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
}
