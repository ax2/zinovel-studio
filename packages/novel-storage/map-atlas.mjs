import { lstat, readdir } from "node:fs/promises";
import { mapId, mapHash } from "../novel-domain/maps.mjs";
import {
  mapAtlasInput,
  validateMapAtlasRecord,
  atlasLimits,
} from "../novel-domain/map-atlas.mjs";
import { binaryHash } from "./image-decoder.mjs";
import { readUtf8File } from "./encoding.mjs";

const currentPath = "world/map-atlas.json",
  historyFolder = ".zinovel/map-atlas-history";
const fields = (value) => ({
  notes: value.notes,
  epochs: value.epochs,
  entries: value.entries,
});
const json = (value) => JSON.stringify(value, null, 2) + "\n";
export class MapAtlasStore {
  constructor(storage, maps) {
    this.storage = storage;
    this.maps = maps;
  }
  expected(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new Error("请重新读取地图册核对版本");
    return { revision: value.revision, diskHash: mapHash(value.diskHash) };
  }
  async record(ctx, historical = null) {
    const expected = historical && this.expected(historical),
      path = expected
        ? `${historyFolder}/${expected.revision}-${expected.diskHash}.json`
        : currentPath;
    const file = await this.storage.path(ctx.root, path);
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT" && !expected) return null;
      throw error;
    }
    if (!stat.isFile() || stat.size > atlasLimits.bytes)
      throw new Error("地图册文件过大或不能读取，请保留原件");
    const raw = await readUtf8File(file),
      data = JSON.parse(raw),
      diskHash = binaryHash(Buffer.from(raw));
    validateMapAtlasRecord(data, ctx.origins);
    if (
      expected &&
      (data.revision !== expected.revision || diskHash !== expected.diskHash)
    )
      throw new Error("地图册历史校验失败，请保留原件");
    return { data, raw, diskHash, path };
  }
  view(record) {
    return record ? { ...record.data, diskHash: record.diskHash } : null;
  }
  async current(ctx, value) {
    const expected = value === null ? null : this.expected(value),
      record = await this.record(ctx);
    if (
      (record === null) !== (expected === null) ||
      (record &&
        (record.data.revision !== expected.revision ||
          record.diskHash !== expected.diskHash))
    )
      throw new Error("地图册已被其他操作修改，当前调整已保留，请读取后对照");
    return record;
  }
  read(bookId) {
    return this.storage.exclusive(async () =>
      this.view(await this.record(await this.maps.context(bookId))),
    );
  }
  async dependencies(ctx, data, previous) {
    const prior = new Map((previous?.entries || []).map((e) => [e.mapId, e]));
    const changed = data.entries.filter((e) => {
      const old = prior.get(e.mapId);
      return (
        !old ||
        e.parentId !== old.parentId ||
        e.anchorId !== old.anchorId ||
        e.epochId !== old.epochId
      );
    });
    if (changed.length > 40)
      throw new Error("一次最多调整40个地图引用，请分次保存以保持正文响应");
    const cache = new Map();
    const get = async (id) => {
      if (!cache.has(id)) cache.set(id, await this.maps.record(ctx, id));
      const result = cache.get(id).data;
      if (result.deletedAt) throw new Error("新关联须使用未回收地图");
      return result;
    };
    for (const item of changed) {
      // Clearing a broken relationship does not require the missing map to reappear.
      const old = prior.get(item.mapId);
      const parentChanged =
        !old ||
        item.parentId !== old.parentId ||
        item.anchorId !== old.anchorId;
      if (
        !old ||
        (item.parentId !== null && parentChanged) ||
        (item.epochId !== null && item.epochId !== old.epochId)
      )
        await get(item.mapId);
      if (item.parentId !== null && parentChanged) {
        const parent = await get(item.parentId),
          anchor = parent.elements.find((e) => e.id === item.anchorId);
        if (
          !anchor ||
          anchor.deletedAt ||
          !["place", "region"].includes(anchor.kind)
        )
          throw new Error("父图锚点必须是该图未回收的地点或区域");
      }
    }
  }
  async commit(ctx, data, previous) {
    validateMapAtlasRecord(data, ctx.origins);
    const raw = json(data);
    if (Buffer.byteLength(raw) > atlasLimits.bytes)
      throw new Error("地图册超过1MiB，请缩减说明后重试，原件未改动");
    const changes = { [currentPath]: raw },
      expectedBefore = { [currentPath]: previous?.raw ?? null };
    if (previous) {
      const path = `${historyFolder}/${previous.data.revision}-${previous.diskHash}.json`,
        file = await this.storage.path(ctx.root, path);
      let old = null;
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > atlasLimits.bytes)
          throw new Error("地图册历史无效，请保留原件");
        old = await readUtf8File(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (old !== null && old !== previous.raw)
        throw new Error("地图册历史已改变，请保留原件");
      changes[path] = previous.raw;
      expectedBefore[path] = old;
    }
    await this.storage.transaction(ctx.root, changes, { expectedBefore });
    return { ...data, diskHash: binaryHash(Buffer.from(raw)) };
  }
  save(bookId, input, value) {
    const data = mapAtlasInput(input),
      expected = value === null ? null : this.expected(value);
    if (Buffer.byteLength(json(data)) > atlasLimits.bytes)
      throw new Error("地图册超过1MiB，请缩减说明后重试，原件未改动");
    return this.storage.exclusive(async () => {
      const ctx = await this.maps.context(bookId),
        previous = await this.current(ctx, expected);
      if (previous && json(data) === json(fields(previous.data)))
        return this.view(previous);
      await this.dependencies(ctx, data, previous?.data);
      const at = new Date().toISOString();
      return this.commit(
        ctx,
        {
          schemaVersion: 1,
          bookId: previous?.data.bookId ?? ctx.book.id,
          revision: (previous?.data.revision || 0) + 1,
          createdAt: previous?.data.createdAt ?? at,
          updatedAt: at,
          ...data,
        },
        previous,
      );
    });
  }
  inspect(bookId, options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (k) =>
          !["offset", "parentId", "epochId", "anchorId", "historical"].includes(
            k,
          ),
      )
    )
      throw new Error("地图册筛选条件无效");
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("地图册分页无效");
    const filters = {};
    for (const field of ["parentId", "epochId", "anchorId"])
      if (Object.hasOwn(options, field))
        filters[field] = options[field] === null ? null : mapId(options[field]);
    const historical =
      options.historical === undefined
        ? null
        : this.expected(options.historical);
    return this.storage.exclusive(async () => {
      const ctx = await this.maps.context(bookId),
        record = await this.record(ctx, historical);
      const entries = (record?.data.entries || []).filter((e) =>
        Object.entries(filters).every(([key, value]) => e[key] === value),
      );
      const page = entries.slice(offset, offset + 40),
        cache = new Map();
      const get = (id) => {
        if (!cache.has(id))
          cache.set(
            id,
            this.maps
              .record(ctx, id)
              .then((r) => ({
                state: r.data.deletedAt ? "retired" : "ready",
                data: r.data,
                error: null,
              }))
              .catch((error) => ({
                state: error.code === "ENOENT" ? "missing" : "unreadable",
                data: null,
                error: error.message,
              })),
          );
        return cache.get(id);
      };
      const rows = [];
      for (let i = 0; i < page.length; i += 4)
        rows.push(
          ...(await Promise.all(
            page.slice(i, i + 4).map(async (entry) => {
              const map = await get(entry.mapId),
                parent = entry.parentId ? await get(entry.parentId) : null;
              const anchor = parent?.data?.elements.find(
                (e) => e.id === entry.anchorId,
              );
              return {
                entry,
                title: map.data?.title ?? null,
                state: map.state,
                error: map.error,
                parentTitle: parent?.data?.title ?? null,
                parentState: parent?.state ?? null,
                parentError: parent?.error ?? null,
                anchorTitle: anchor?.title ?? null,
                anchorState: !parent
                  ? null
                  : parent.state !== "ready"
                    ? "parent-unavailable"
                    : !anchor
                      ? "missing"
                      : anchor.deletedAt
                        ? "retired"
                        : !["place", "region"].includes(anchor.kind)
                          ? "invalid"
                          : "ready",
              };
            }),
          )),
        );
      return {
        record: this.view(record),
        rows,
        total: entries.length,
        offset,
        limit: 40,
        mapNames: "current",
      };
    });
  }
  history(bookId) {
    return this.storage.exclusive(async () => {
      const ctx = await this.maps.context(bookId);
      await this.record(ctx);
      const folder = await this.storage.path(ctx.root, historyFolder);
      let files;
      try {
        files = await readdir(folder);
      } catch (error) {
        if (error.code === "ENOENT") return { items: [], errors: [] };
        throw error;
      }
      if (files.length > 10000)
        throw new Error("地图册历史目录过大，请保留原件");
      const names = files
        .filter((n) => /^\d+-[a-f0-9]{64}\.json$/.test(n))
        .sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
      const known = new Set(names);
      const items = [],
        errors = files
          .filter((n) => !known.has(n))
          .slice(0, 40)
          .map(() => "发现无法识别的地图册历史文件，已保留");
      for (const name of names.slice(0, 40))
        try {
          items.push(
            this.view(
              await this.record(ctx, {
                revision: Number(name.split("-")[0]),
                diskHash: name.slice(name.indexOf("-") + 1, -5),
              }),
            ),
          );
        } catch (error) {
          errors.push(error.message);
        }
      return { items, errors };
    });
  }
  restoreVersion(bookId, value, historical) {
    const expected = this.expected(value),
      selected = this.expected(historical);
    return this.storage.exclusive(async () => {
      const ctx = await this.maps.context(bookId),
        previous = await this.current(ctx, expected),
        old = await this.record(ctx, selected);
      // Known historical broken references remain visible; never guess replacement targets.
      return this.commit(
        ctx,
        {
          ...previous.data,
          ...fields(old.data),
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        previous,
      );
    });
  }
}
