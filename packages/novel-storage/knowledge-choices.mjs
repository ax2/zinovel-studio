import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { knowledgeInput } from "../novel-domain/knowledge.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
function identity(value) {
  const clean = knowledgeInput({
    ...value,
    state: value?.scope === "world" ? "recorded" : "unspecified",
    statement: "选择身份",
    storyTime: "",
  });
  return {
    propositionId: clean.propositionId,
    scope: clean.scope,
    characterId: clean.characterId,
  };
}
const key = (value) => {
  const clean = identity(value);
  return `${clean.propositionId}.${clean.scope}.${clean.characterId || clean.scope}`;
};
const decode = (bytes) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
/** Author decisions do not infer chronology, delete contradictions, or change events. */
export class KnowledgeChoices {
  constructor(storage, materials, knowledge) {
    this.storage = storage;
    this.materials = materials;
    this.knowledge = knowledge;
  }
  parse(raw, expectedKey) {
    const data = JSON.parse(raw);
    if (
      !data ||
      data.schemaVersion !== 1 ||
      !/^[0-9a-f-]{36}$/.test(data.id) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !["active", "cleared"].includes(data.status) ||
      key(data.identity) !== expectedKey ||
      typeof data.reason !== "string" ||
      data.reason.length > 2000 ||
      !data.reason.isWellFormed() ||
      data.reason.includes("\0") ||
      typeof data.createdAt !== "string" ||
      typeof data.updatedAt !== "string" ||
      Object.keys(data).some(
        (name) =>
          ![
            "schemaVersion",
            "id",
            "revision",
            "status",
            "identity",
            "selected",
            "reason",
            "createdAt",
            "updatedAt",
          ].includes(name),
      )
    )
      throw new Error("作者认知选择损坏或版本不支持，原文件已保留");
    const selected = data.selected;
    if (
      Object.keys(data.identity).some(
        (name) => !["propositionId", "scope", "characterId"].includes(name),
      ) ||
      (selected &&
        Object.keys(selected).some(
          (name) => !["id", "revision", "diskHash", "raw"].includes(name),
        ))
    )
      throw new Error("认知选择包含不支持的字段，原文件已保留");
    if (
      !selected ||
      typeof selected.raw !== "string" ||
      hash(selected.raw) !== selected.diskHash
    )
      throw new Error("选择的认知快照损坏，原文件已保留");
    const snapshot = this.knowledge.parse(selected.raw, selected.id);
    if (
      snapshot.data.revision !== selected.revision ||
      snapshot.data.status !== "active" ||
      key(snapshot.data) !== expectedKey
    )
      throw new Error("认知选择与冻结事件身份不一致");
    return { data, raw, diskHash: hash(raw), snapshot };
  }
  async record(root, target) {
    const fileKey = key(target);
    try {
      return this.parse(
        decode(
          await readFile(
            await this.storage.path(root, `knowledge/choices/${fileKey}.json`),
          ),
        ),
        fileKey,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async view(record, root, book) {
    if (!record) return null;
    let freshness = record.data.status === "cleared" ? "cleared" : "missing",
      currentRevision = null;
    if (record.data.status === "active")
      try {
        const current = await this.knowledge.record(
            root,
            record.snapshot.data.id,
          ),
          view = await this.knowledge.view(current, root, book);
        currentRevision = current.data.revision;
        freshness =
          current.diskHash !== record.data.selected.diskHash ||
          current.data.revision !== record.data.selected.revision ||
          current.data.status !== "active"
            ? "stale"
            : view.freshness;
      } catch {}
    return {
      ...record.data,
      diskHash: record.diskHash,
      snapshot: record.snapshot.data,
      freshness,
      currentRevision,
    };
  }
  assertExpected(previous, expected) {
    if (
      previous
        ? !expected ||
          previous.data.id !== expected.id ||
          previous.data.revision !== expected.revision ||
          previous.diskHash !== expected.diskHash
        : !!expected
    )
      throw new Error("作者认知选择已改变，请保留调整并重新读取");
  }
  async write(root, data, previous) {
    const changes = {
      [`knowledge/choices/${key(data.identity)}.json`]: json(data),
    };
    if (previous)
      changes[
        `.zinovel/knowledge-choice-history/${data.id}/${previous.data.revision}-${previous.diskHash}.json`
      ] = previous.raw;
    await this.storage.transaction(root, changes);
  }
  read(bookId, target) {
    const clean = identity(target);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId);
      return this.view(await this.record(root, clean), root, book);
    });
  }
  select(bookId, eventExpected, choiceExpected, reason = "") {
    if (
      typeof reason !== "string" ||
      reason.length > 2000 ||
      !reason.isWellFormed() ||
      reason.includes("\0")
    )
      throw new Error("选择说明无效");
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        event = await this.knowledge.expected(root, eventExpected),
        view = await this.knowledge.view(event, root, book);
      if (event.data.status !== "active" || view.freshness !== "current")
        throw new Error("请先重新绑定有效正文依据，再选择当前认知");
      const clean = identity(event.data),
        previous = await this.record(root, clean);
      this.assertExpected(previous, choiceExpected);
      const now = new Date().toISOString(),
        data = {
          schemaVersion: 1,
          id: previous?.data.id || randomUUID(),
          revision: (previous?.data.revision || 0) + 1,
          status: "active",
          identity: clean,
          selected: {
            id: event.data.id,
            revision: event.data.revision,
            diskHash: event.diskHash,
            raw: event.raw,
          },
          reason: reason.trim(),
          createdAt: previous?.data.createdAt || now,
          updatedAt: now,
        };
      await this.write(root, data, previous);
      return this.view(await this.record(root, clean), root, book);
    });
  }
  clear(bookId, target, expected) {
    const clean = identity(target);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        previous = await this.record(root, clean);
      this.assertExpected(previous, expected);
      if (!previous) throw new Error("没有可清除的作者认知选择");
      const data = {
        ...previous.data,
        status: "cleared",
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.write(root, data, previous);
      return this.view(await this.record(root, clean), root, book);
    });
  }
  history(bookId, target, offset = 0) {
    const clean = identity(target);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("选择历史分页无效");
    return this.storage.exclusive(async () => {
      const { root } = await this.materials.context(bookId),
        current = await this.record(root, clean);
      if (!current) return { items: [], total: 0, errors: [], offset };
      let names = [];
      try {
        names = (
          await readdir(
            await this.storage.path(
              root,
              `.zinovel/knowledge-choice-history/${current.data.id}`,
            ),
          )
        ).filter((name) => name.endsWith(".json"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      names.sort(
        (a, b) => (parseInt(b) || 0) - (parseInt(a) || 0) || a.localeCompare(b),
      );
      const items = [],
        errors = [];
      for (const name of names.slice(offset, offset + 40))
        try {
          const record = this.parse(
            decode(
              await readFile(
                await this.storage.path(
                  root,
                  `.zinovel/knowledge-choice-history/${current.data.id}/${name}`,
                ),
              ),
            ),
            key(clean),
          );
          if (record.data.id !== current.data.id) throw new Error();
          items.push({ ...record.data, snapshot: record.snapshot.data });
        } catch {
          errors.push("一份认知选择历史无法读取，原文件已保留");
        }
      return { items, total: names.length, errors, offset };
    });
  }
  async project(bookId, propositions, characterIds, signal, visit) {
    signal?.throwIfAborted();
    const names = await this.storage.exclusive(async () => {
      const { root } = await this.materials.context(bookId);
      try {
        return (
          await readdir(await this.storage.path(root, "knowledge/choices"))
        )
          .filter((name) => name.endsWith(".json"))
          .sort();
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    });
    const items = [],
      errors = [];
    for (const name of names) {
      signal?.throwIfAborted();
      const [propositionId, scope, characterId, ...extra] = name
        .slice(0, -5)
        .split(".");
      if (propositions && !propositions.has(propositionId)) continue;
      if (
        scope === "character" &&
        characterIds &&
        !characterIds.includes(characterId)
      )
        continue;
      await this.storage.exclusive(async () => {
        signal?.throwIfAborted();
        const { root, book } = await this.materials.context(bookId);
        try {
          const target = identity({
            propositionId,
            scope,
            characterId: scope === "character" ? characterId : null,
          });
          if (extra.length || key(target) !== name.slice(0, -5))
            throw new Error();
          const item = await this.view(
            await this.record(root, target),
            root,
            book,
          );
          if (item) {
            if (visit) visit(item);
            else items.push(item);
          }
        } catch {
          errors.push("一份作者认知选择无法读取，原文件已保留");
        }
      });
    }
    signal?.throwIfAborted();
    return { items, errors };
  }
}
