import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateEvidence } from "../novel-domain/evidence.mjs";
import { materialKind } from "../novel-domain/materials.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const validId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
/** Legacy provenance is a separate file; original cards/events are never rewritten. */
export class LegacyKnowledge {
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
  }
  async owner(root, ownerId) {
    if (!validId(ownerId)) throw new Error("旧资料身份无效");
    const owner = await this.materials.record(root, ownerId);
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(
      await readFile(
        await this.storage.path(root, `materials/${ownerId}.json`),
      ),
    );
    if (hash(raw) !== owner.diskHash)
      throw new Error("旧资料在读取期间改变，请重新读取");
    return owner;
  }
  async freeze(root, expected) {
    if (!expected || !validId(expected.eventId))
      throw new Error("旧认知身份无效");
    const record = await this.owner(root, expected.owner?.id);
    if (
      record.data.revision !== expected.owner.revision ||
      record.diskHash !== expected.owner.diskHash
    )
      throw new Error("旧资料已改变，请保留草稿并重新读取旧认知");
    const event = record.data.evidence?.find(
      (item) => item.id === expected.eventId,
    );
    if (
      record.data.deletedAt ||
      !event ||
      event.kind !== "knowledge" ||
      event.status !== "active"
    )
      throw new Error("旧认知已停用、删除或失联");
    if (hash(json(event)) !== expected.eventHash)
      throw new Error("旧认知已改变，请重新读取");
    return {
      ownerId: record.data.id,
      ownerTitle: record.data.title,
      ownerKind: record.data.kind,
      ownerRevision: record.data.revision,
      ownerDiskHash: record.diskHash,
      eventId: event.id,
      eventHash: hash(json(event)),
      event,
    };
  }
  preview(bookId, ownerId, eventId) {
    if (!validId(eventId)) throw new Error("旧认知身份无效");
    return this.storage.exclusive(async () => {
      const { root } = await this.materials.context(bookId),
        record = await this.owner(root, ownerId),
        event = record.data.evidence?.find((item) => item.id === eventId);
      if (
        record.data.deletedAt ||
        !event ||
        event.kind !== "knowledge" ||
        event.status !== "active"
      )
        throw new Error("请选择未删除资料中的启用旧认知");
      return {
        owner: {
          id: record.data.id,
          title: record.data.title,
          kind: record.data.kind,
          revision: record.data.revision,
          diskHash: record.diskHash,
        },
        eventId,
        eventHash: hash(json(event)),
        event,
      };
    });
  }
  async list(bookId, { query = "", offset = 0 } = {}, signal) {
    signal?.throwIfAborted();
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("旧认知筛选无效");
    const matches = [];
    const errors = await this.materials.scan(
      bookId,
      (data) => {
        for (const event of data.evidence || [])
          if (
            event.kind === "knowledge" &&
            (!query ||
              [data.title, event.statement, event.storyTime]
                .join("\n")
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()))
          )
            matches.push({
              ownerId: data.id,
              ownerTitle: data.title,
              ownerKind: data.kind,
              ownerDeleted: !!data.deletedAt,
              event,
            });
      },
      { signal },
    );
    matches.sort(
      (a, b) =>
        a.ownerId.localeCompare(b.ownerId) ||
        a.event.id.localeCompare(b.event.id),
    );
    return {
      items: matches.slice(offset, offset + 40),
      total: matches.length,
      offset,
      errors,
    };
  }
  create(target, source) {
    return {
      schemaVersion: 1,
      target: {
        id: target.id,
        revision: target.revision,
        diskHash: hash(json(target)),
      },
      source,
    };
  }
  parse(raw, eventId) {
    const data = JSON.parse(raw),
      source = data?.source,
      target = data?.target;
    if (
      !data ||
      data.schemaVersion !== 1 ||
      Object.keys(data).some(
        (key) => !["schemaVersion", "target", "source"].includes(key),
      ) ||
      !target ||
      target.id !== eventId ||
      !validId(target.id) ||
      target.revision !== 1 ||
      !/^[a-f0-9]{64}$/.test(target.diskHash) ||
      Object.keys(target).some(
        (key) => !["id", "revision", "diskHash"].includes(key),
      ) ||
      !source ||
      !validId(source.ownerId) ||
      !validId(source.eventId) ||
      typeof source.ownerTitle !== "string" ||
      !Number.isSafeInteger(source.ownerRevision) ||
      source.ownerRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(source.ownerDiskHash) ||
      Object.keys(source).some(
        (key) =>
          ![
            "ownerId",
            "ownerTitle",
            "ownerKind",
            "ownerRevision",
            "ownerDiskHash",
            "eventId",
            "eventHash",
            "event",
          ].includes(key),
      )
    )
      throw new Error("旧认知来源记录损坏或版本不支持");
    materialKind(source.ownerKind);
    validateEvidence([source.event], source.ownerKind);
    if (
      source.event.kind !== "knowledge" ||
      source.event.status !== "active" ||
      source.event.id !== source.eventId ||
      hash(json(source.event)) !== source.eventHash
    )
      throw new Error("旧认知冻结事件不一致");
    return data;
  }
  async view(record, root) {
    let data;
    try {
      const raw = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(
        await readFile(
          await this.storage.path(
            root,
            `knowledge/origins/${record.data.id}.json`,
          ),
        ),
      );
      data = this.parse(raw, record.data.id);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      return {
        status: "unreadable",
        error: "旧认知来源无法读取，原文件已保留",
      };
    }
    let status = "missing",
      ownerChanged = false;
    try {
      const owner = await this.owner(root, data.source.ownerId),
        event = owner.data.evidence?.find(
          (item) => item.id === data.source.eventId,
        );
      ownerChanged = owner.diskHash !== data.source.ownerDiskHash;
      status =
        owner.data.deletedAt || !event
          ? "missing"
          : hash(json(event)) === data.source.eventHash
            ? "unchanged"
            : "changed";
    } catch {}
    return {
      ...data,
      status,
      ownerChanged,
      targetChanged:
        record.diskHash !== data.target.diskHash ||
        record.data.revision !== data.target.revision,
    };
  }
}
