import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pilotInput, pilotText } from "../novel-domain/pilots.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const id = (value) => {
  if (!validId(value)) throw new Error("无效的试写标识");
  return value;
};
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const version = (record) => ({
  id: record.data.id,
  revision: record.data.revision,
  diskHash: record.diskHash,
  bodyHash: record.bodyHash,
});
const snapshot = (record) => ({
  ...version(record),
  data: record.data,
  body: record.body,
});
const groupPath = (groupId) => `pilots/groups/${id(groupId)}.json`;
const metaPath = (pilotId) => `pilots/${id(pilotId)}.json`;
const bodyPath = (pilotId) => `pilots/${id(pilotId)}.md`;
const snapshotKey = (record) =>
  `${record.data.revision}-${hash(record.diskHash + record.bodyHash)}`;

/** Trial documents use the same book transaction queue as manuscript, materials and planning. */
export class PilotStore {
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
  }
  async text(root, path) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(await this.storage.path(root, path)),
    );
  }
  async context(bookId) {
    const root = await this.storage.bookRoot(bookId);
    return { root, book: await this.storage.manifest(root) };
  }
  checkVersion(record, expected, body = true) {
    if (
      !expected ||
      expected.id !== record.data.id ||
      expected.revision !== record.data.revision ||
      expected.diskHash !== record.diskHash ||
      (body && expected.bodyHash !== record.bodyHash)
    )
      throw new Error(
        "试写已被其他操作或外部编辑修改，未覆盖原文件。请保留当前调整并重新读取对照。",
      );
  }
  async record(root, pilotId) {
    const raw = await this.text(root, metaPath(pilotId)),
      data = JSON.parse(raw),
      body = await this.text(root, bodyPath(pilotId));
    if (
      data.schemaVersion !== 1 ||
      data.id !== pilotId ||
      !validId(data.groupId) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !validHash(data.hash) ||
      typeof data.createdAt !== "string" ||
      typeof data.updatedAt !== "string" ||
      (data.deletedAt !== undefined && typeof data.deletedAt !== "string")
    )
      throw new Error("试写格式损坏或版本不支持，原文件已保留");
    pilotInput({ ...data, body });
    if (
      data.parent !== null &&
      (!data.parent ||
        !validId(data.parent.id) ||
        !Number.isSafeInteger(data.parent.revision) ||
        data.parent.revision < 1 ||
        !validHash(data.parent.diskHash) ||
        !validHash(data.parent.bodyHash))
    )
      throw new Error("试写分支来源损坏，原文件已保留");
    return { data, raw, body, diskHash: hash(raw), bodyHash: hash(body) };
  }
  async groupRecord(root, groupId) {
    const raw = await this.text(root, groupPath(groupId)),
      data = JSON.parse(raw);
    if (
      data.schemaVersion !== 1 ||
      data.id !== groupId ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !Array.isArray(data.sources) ||
      data.sources.length > 8
    )
      throw new Error("试写实验格式损坏或版本不支持，原文件已保留");
    pilotText(data.title, "实验标题", 200, true);
    pilotText(data.scene, "共同场景任务", 20_000, true);
    const ids = new Set();
    for (const source of data.sources) {
      if (
        !source ||
        !validId(source.id) ||
        !validHash(source.diskHash) ||
        !Number.isSafeInteger(source.revision) ||
        source.revision < 1 ||
        !source.data ||
        source.data.id !== source.id ||
        ids.has(source.id)
      )
        throw new Error("试写来源快照损坏，原文件已保留");
      ids.add(source.id);
    }
    if (data.selection !== null) {
      const s = data.selection;
      if (
        !s ||
        !s.snapshot ||
        !validId(s.snapshot.id) ||
        !validHash(s.snapshot.diskHash) ||
        !validHash(s.snapshot.bodyHash) ||
        !s.snapshot.data ||
        s.snapshot.data.groupId !== groupId ||
        s.snapshot.data.id !== s.snapshot.id ||
        hash(s.snapshot.body) !== s.snapshot.bodyHash
      )
        throw new Error("试写选择记录损坏，原文件已保留");
      pilotText(s.reason, "选定理由", 20_000, true);
    }
    return { data, raw, diskHash: hash(raw) };
  }
  async groupView(root, record) {
    const sources = [];
    for (const source of record.data.sources) {
      let freshness = "missing",
        currentRevision = null;
      try {
        const current = await this.materials.record(root, source.id);
        currentRevision = current.data.revision;
        freshness = current.data.deletedAt
          ? "deleted"
          : current.diskHash === source.diskHash
            ? "current"
            : "stale";
      } catch {}
      sources.push({ ...source, freshness, currentRevision });
    }
    let selectionState = "none";
    if (record.data.selection) {
      selectionState = "missing";
      try {
        const current = await this.record(
            root,
            record.data.selection.snapshot.id,
          ),
          chosen = record.data.selection.snapshot;
        selectionState = current.data.deletedAt
          ? "deleted"
          : current.diskHash === chosen.diskHash &&
              current.bodyHash === chosen.bodyHash
            ? "current"
            : "stale";
      } catch {}
    }
    return {
      ...record.data,
      diskHash: record.diskHash,
      sources,
      selectionState,
    };
  }
  createGroup(bookId, input) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId),
        title = pilotText(input?.title, "实验标题", 200, true).trim(),
        scene = pilotText(input?.scene, "共同场景任务", 20_000, true),
        sourceIds = input?.sourceIds ?? [];
      if (
        !Array.isArray(sourceIds) ||
        sourceIds.length > 8 ||
        new Set(sourceIds).size !== sourceIds.length
      )
        throw new Error("每组可关联最多八份不同资料");
      const sources = [];
      let size = 0;
      for (const sourceId of sourceIds) {
        const source = await this.materials.record(root, id(sourceId));
        if (source.data.deletedAt) throw new Error("不能关联已删除资料");
        size += source.raw.length;
        if (size > 120_000) throw new Error("所选资料快照过长，请减少关联资料");
        sources.push({
          id: sourceId,
          revision: source.data.revision,
          diskHash: source.diskHash,
          data: source.data,
        });
      }
      const data = {
        schemaVersion: 1,
        id: randomUUID(),
        revision: 1,
        title,
        scene,
        sources,
        selection: null,
        createdAt: new Date().toISOString(),
      };
      await this.storage.transaction(root, {
        [groupPath(data.id)]: json(data),
      });
      return this.groupView(root, await this.groupRecord(root, data.id));
    });
  }
  readGroup(bookId, groupId) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      return this.groupView(root, await this.groupRecord(root, groupId));
    });
  }
  async scan(bookId, directory, reader) {
    const { root, entries } = await this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      let entries = [];
      try {
        entries = await readdir(await this.storage.path(root, directory));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      return {
        root,
        entries: entries
          .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
          .sort(),
      };
    });
    const items = [],
      errors = [];
    // Listings can span revisions; writes and explicit reads always revalidate under one lock.
    for (let offset = 0; offset < entries.length; offset += 32)
      await this.storage.exclusive(async () => {
        await this.context(bookId);
        for (const name of entries.slice(offset, offset + 32)) {
          try {
            const item = await reader(root, name.slice(0, -5));
            if (item) items.push(item);
          } catch {
            errors.push({
              id: name.slice(0, -5),
              message: "一份试写记录无法读取，原文件已保留",
            });
          }
        }
      });
    return { items, errors };
  }
  listGroups(bookId) {
    return this.scan(bookId, "pilots/groups", async (root, groupId) => {
      const { data, diskHash } = await this.groupRecord(root, groupId);
      return {
        id: data.id,
        title: data.title,
        revision: data.revision,
        diskHash,
      };
    });
  }
  list(bookId, groupId) {
    id(groupId);
    return this.scan(bookId, "pilots", async (root, pilotId) => {
      const record = await this.record(root, pilotId);
      if (record.data.groupId !== groupId) return null;
      return {
        ...record.data,
        ...version(record),
        externalChange: record.data.hash !== record.bodyHash,
      };
    });
  }
  read(bookId, pilotId) {
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId),
        record = await this.record(root, pilotId);
      return {
        ...record.data,
        ...version(record),
        body: record.body,
        externalChange: record.data.hash !== record.bodyHash,
      };
    });
  }
  historyChange(record) {
    return {
      [`.zinovel/pilot-history/${record.data.id}/${snapshotKey(record)}.json`]:
        json(snapshot(record)),
    };
  }
  save(bookId, groupId, input, expected = null, parent = null) {
    const clean = pilotInput(input);
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      await this.groupRecord(root, groupId);
      const previous = expected
        ? await this.record(root, id(expected.id))
        : null;
      let origin = null;
      if (previous) {
        this.checkVersion(previous, expected);
        if (previous.data.groupId !== groupId || previous.data.deletedAt)
          throw new Error("试写不属于该实验或已删除");
      }
      if (parent) {
        if (previous) throw new Error("已有试写不能更换分支来源");
        origin = await this.record(root, id(parent.id));
        this.checkVersion(origin, parent);
        if (origin.data.groupId !== groupId || origin.data.deletedAt)
          throw new Error("分支来源不属于该实验或已删除");
      }
      const { body, ...fields } = clean,
        now = new Date().toISOString(),
        data = {
          schemaVersion: 1,
          id: previous?.data.id || randomUUID(),
          groupId,
          revision: (previous?.data.revision || 0) + 1,
          ...fields,
          hash: hash(body),
          parent: previous?.data.parent || (origin ? version(origin) : null),
          createdAt: previous?.data.createdAt || now,
          updatedAt: now,
        };
      await this.storage.transaction(root, {
        ...(previous ? this.historyChange(previous) : {}),
        ...(origin ? this.historyChange(origin) : {}),
        [metaPath(data.id)]: json(data),
        [bodyPath(data.id)]: body,
      });
      return {
        ...data,
        diskHash: hash(json(data)),
        bodyHash: hash(body),
        body,
        externalChange: false,
      };
    });
  }
  setDeleted(bookId, expected, deleted) {
    if (typeof deleted !== "boolean") throw new Error("无效的删除状态");
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId),
        previous = await this.record(root, id(expected?.id));
      this.checkVersion(previous, expected);
      const next = {
        ...previous.data,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (deleted) next.deletedAt = next.updatedAt;
      else delete next.deletedAt;
      await this.storage.transaction(root, {
        ...this.historyChange(previous),
        [metaPath(next.id)]: json(next),
      });
      return {
        ...next,
        diskHash: hash(json(next)),
        bodyHash: previous.bodyHash,
        body: previous.body,
        externalChange: next.hash !== previous.bodyHash,
      };
    });
  }
  choose(bookId, expectedGroup, expectedPilot, reason) {
    pilotText(reason, "选定理由", 20_000, true);
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId),
        group = await this.groupRecord(root, id(expectedGroup?.id)),
        pilot = await this.record(root, id(expectedPilot?.id));
      this.checkVersion(group, expectedGroup, false);
      this.checkVersion(pilot, expectedPilot);
      if (pilot.data.groupId !== group.data.id || pilot.data.deletedAt)
        throw new Error("试写不属于该实验或已删除");
      const next = {
        ...group.data,
        revision: group.data.revision + 1,
        selection: {
          snapshot: snapshot(pilot),
          reason,
          at: new Date().toISOString(),
        },
      };
      await this.storage.transaction(root, {
        ...this.historyChange(pilot),
        [`.zinovel/pilot-group-history/${group.data.id}/${group.data.revision}-${group.diskHash}.json`]:
          group.raw,
        [groupPath(group.data.id)]: json(next),
      });
      return this.groupView(root, await this.groupRecord(root, group.data.id));
    });
  }
  addFeedback(bookId, expected, input) {
    const source = pilotText(input?.source, "反馈来源", 200, true),
      comment = pilotText(input?.comment, "试读反馈", 40_000, true);
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId),
        pilot = await this.record(root, id(expected?.id));
      this.checkVersion(pilot, expected);
      if (pilot.data.deletedAt) throw new Error("请先恢复试写再添加反馈");
      const data = {
        schemaVersion: 1,
        id: randomUUID(),
        source,
        comment,
        at: new Date().toISOString(),
        snapshot: snapshot(pilot),
      };
      await this.storage.transaction(root, {
        ...this.historyChange(pilot),
        [`pilots/feedback/${pilot.data.id}/${data.id}.json`]: json(data),
      });
      return data;
    });
  }
  async versions(bookId, pilotId, feedback = false) {
    id(pilotId);
    return this.storage.exclusive(async () => {
      const { root } = await this.context(bookId);
      await this.record(root, pilotId);
      const directory = feedback
        ? `pilots/feedback/${pilotId}`
        : `.zinovel/pilot-history/${pilotId}`;
      let names;
      try {
        names = await readdir(await this.storage.path(root, directory));
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
      const items = [];
      for (const name of names.filter((name) =>
        feedback
          ? /^[a-f0-9-]{36}\.json$/.test(name)
          : /^\d+-[a-f0-9]{64}\.json$/.test(name),
      )) {
        const data = JSON.parse(await this.text(root, `${directory}/${name}`)),
          s = feedback ? data.snapshot : data;
        if (
          !s ||
          s.id !== pilotId ||
          !s.data ||
          s.data.id !== pilotId ||
          !Number.isSafeInteger(s.revision) ||
          s.revision < 1 ||
          !validHash(s.diskHash) ||
          typeof s.body !== "string" ||
          hash(s.body) !== s.bodyHash
        )
          throw new Error("试写历史或反馈损坏，原文件已保留");
        items.push(data);
      }
      return items.sort((a, b) =>
        feedback ? b.at.localeCompare(a.at) : b.revision - a.revision,
      );
    });
  }
  promote(bookId, expected, title) {
    const name = pilotText(title, "新章节标题", 200, true).trim();
    return this.storage.exclusive(async () => {
      const { root, book } = await this.context(bookId),
        pilot = await this.record(root, id(expected?.id));
      this.checkVersion(pilot, expected);
      if (pilot.data.deletedAt) throw new Error("请先恢复试写再建立章节");
      const path = `.zinovel/pilot-promotions/${pilot.data.id}/${snapshotKey(pilot)}.json`;
      let receipt;
      try {
        receipt = JSON.parse(await this.text(root, path));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (receipt) {
        if (
          receipt.schemaVersion !== 1 ||
          !validId(receipt.chapterId) ||
          receipt.pilot?.id !== pilot.data.id ||
          receipt.pilot.diskHash !== pilot.diskHash ||
          receipt.pilot.bodyHash !== pilot.bodyHash
        )
          throw new Error("试写转章回执损坏，原文件已保留");
        const chapter = book.chapters.find(
          (item) => item.id === receipt.chapterId,
        );
        if (!chapter || chapter.deletedAt)
          throw new Error(
            "该版本已建立的章节已删除或失联，请先在章节回收站核对",
          );
        return { book, chapterId: chapter.id, reused: true };
      }
      const chapter = {
        id: randomUUID(),
        title: name,
        volumeId: null,
        revision: 1,
        hash: pilot.bodyHash,
        status: "draft",
        updatedAt: new Date().toISOString(),
      };
      book.chapters.push(chapter);
      book.revision++;
      book.updatedAt = chapter.updatedAt;
      await this.storage.transaction(root, {
        ...this.historyChange(pilot),
        [path]: json({
          schemaVersion: 1,
          chapterId: chapter.id,
          pilot: version(pilot),
          at: chapter.updatedAt,
        }),
        [`manuscript/${chapter.id}.md`]: pilot.body,
        "book.json": json(book),
      });
      return { book, chapterId: chapter.id, reused: false };
    });
  }
}
