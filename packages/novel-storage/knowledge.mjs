import { readUtf8File } from "./encoding.mjs";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { knowledgeInput } from "../novel-domain/knowledge.mjs";
import { resolveAnchor } from "../novel-domain/anchors.mjs";
import { validateEvidence } from "../novel-domain/evidence.mjs";
import { orderedChapters } from "../novel-domain/structure.mjs";
import { checkedEvidenceSource } from "./evidence-source.mjs";
import { materialDefinitionHash } from "./materials.mjs";
import { KnowledgeChoices } from "./knowledge-choices.mjs";
import { LegacyKnowledge } from "./knowledge-legacy.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const id = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
    throw new Error("认知记录身份无效");
  return value;
};

export class KnowledgeStore {
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
    this.choices = new KnowledgeChoices(storage, materials, this);
    this.legacy = new LegacyKnowledge(storage, materials);
  }
  async record(root, eventId) {
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(
      await readFile(
        await this.storage.path(root, `knowledge/events/${id(eventId)}.json`),
      ),
    );
    return this.parse(raw, eventId);
  }
  parse(raw, eventId) {
    const data = JSON.parse(raw);
    knowledgeInput(data);
    validateEvidence(
      [{ ...data, kind: "fact", scope: "world", relatedIds: [] }],
      "proposition",
    );
    if (
      Object.keys(data).some(
        (key) =>
          ![
            "schemaVersion",
            "id",
            "revision",
            "propositionId",
            "scope",
            "characterId",
            "state",
            "statement",
            "storyTime",
            "chapterId",
            "anchor",
            "status",
            "proposition",
            "character",
            "createdAt",
            "updatedAt",
          ].includes(key),
      ) ||
      typeof data.createdAt !== "string" ||
      typeof data.updatedAt !== "string"
    )
      throw new Error("认知记录包含不支持的字段或时间");
    if (
      data.schemaVersion !== 1 ||
      data.id !== eventId ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !["active", "retired"].includes(data.status)
    )
      throw new Error("认知记录格式损坏或版本不支持，请保留原文件");
    if (
      !data.anchor ||
      typeof data.chapterId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(data.chapterId) ||
      typeof data.anchor.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.anchor.hash)
    )
      throw new Error("认知证据锚点无效");
    for (const dependency of [
      data.proposition,
      ...(data.scope === "character" ? [data.character] : []),
    ])
      if (
        !dependency ||
        typeof dependency.title !== "string" ||
        !Number.isSafeInteger(dependency.revision) ||
        dependency.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(dependency.definitionHash)
      )
        throw new Error("认知定义版本无效");
    return { data, raw, diskHash: hash(raw) };
  }
  async view(record, root, book) {
    const data = record.data,
      references = [];
    for (const [targetId, expected, kind] of [
      [data.propositionId, data.proposition, "proposition"],
      ...(data.scope === "character"
        ? [[data.characterId, data.character, "character"]]
        : []),
    ]) {
      try {
        const current = await this.materials.record(root, targetId);
        references.push({
          id: targetId,
          title: current.data.title,
          state: current.data.deletedAt ? "deleted" : "active",
          freshness:
            current.data.kind !== kind || current.data.deletedAt
              ? "missing"
              : materialDefinitionHash(current.data) === expected.definitionHash
                ? "current"
                : "stale",
        });
      } catch {
        references.push({
          id: targetId,
          title: expected.title,
          state: "missing",
          freshness: "missing",
        });
      }
    }
    const chapter = book.chapters.find(
      (item) => item.id === data.chapterId && !item.deletedAt,
    );
    let resolution = { status: "missing", start: null, end: null },
      sourceFreshness = "missing";
    if (chapter)
      try {
        const bytes = await readFile(
          await this.storage.path(root, `manuscript/${id(chapter.id)}.md`),
        );
        const body = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
          currentHash = hash(body);
        resolution = resolveAnchor(body, data.anchor, currentHash);
        sourceFreshness =
          currentHash === data.anchor.hash && resolution.status === "exact"
            ? "current"
            : "stale";
      } catch {}
    return {
      ...data,
      diskHash: record.diskHash,
      references,
      chapterTitle: chapter?.title || "章节失联或已删除",
      resolution,
      sourceFreshness,
      origin: await this.legacy.view(record, root),
      freshness:
        sourceFreshness === "current" &&
        references.every((item) => item.freshness === "current")
          ? "current"
          : sourceFreshness === "missing" ||
              references.some((item) => item.freshness === "missing")
            ? "missing"
            : "stale",
    };
  }
  async expected(root, expected) {
    const previous = await this.record(root, id(expected?.id));
    if (
      previous.data.revision !== expected.revision ||
      previous.diskHash !== expected.diskHash
    )
      throw new Error("认知记录已被其他操作修改，请保留调整并重新读取");
    return previous;
  }
  async write(root, data, previous, origin) {
    if (!previous) {
      try {
        await readFile(
          await this.storage.path(root, `knowledge/origins/${data.id}.json`),
        );
        throw new Error("该记录仍有历史来源文件，请恢复已有记录后再操作");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const changes = { [`knowledge/events/${data.id}.json`]: json(data) };
    if (previous)
      changes[
        `.zinovel/knowledge-history/${data.id}/${previous.data.revision}-${previous.diskHash}.json`
      ] = previous.raw;
    if (origin)
      changes[`knowledge/origins/${data.id}.json`] = json(
        this.legacy.create(data, origin),
      );
    await this.storage.transaction(root, changes);
  }
  save(bookId, input, expected, source, legacyExpected, creationId) {
    const clean = knowledgeInput(input);
    if (creationId !== undefined && creationId !== null) id(creationId);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        previous = expected ? await this.expected(root, expected) : null;
      if (!expected && creationId) {
        let saved;
        try {
          saved = await this.record(root, creationId);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (saved) {
          const origin = await this.legacy.view(saved, root);
          const sameOrigin = legacyExpected
            ? origin?.source?.ownerId === legacyExpected.owner?.id &&
              origin.source.ownerDiskHash === legacyExpected.owner?.diskHash &&
              origin.source.eventId === legacyExpected.eventId &&
              origin.source.eventHash === legacyExpected.eventHash
            : !origin;
          const sameSource =
            source &&
            !source.dirty &&
            typeof source.body === "string" &&
            hash(source.body) === saved.data.anchor.hash &&
            source.hash === saved.data.anchor.hash &&
            source.chapterId === saved.data.chapterId &&
            source.start === saved.data.anchor.start &&
            source.end === saved.data.anchor.end;
          if (
            saved.data.revision === 1 &&
            saved.data.status === "active" &&
            JSON.stringify(knowledgeInput(saved.data)) ===
              JSON.stringify(clean) &&
            sameSource &&
            sameOrigin
          )
            return {
              ...(await this.view(saved, root, book)),
              recoveredCreation: true,
            };
          throw new Error("这份草稿已有保存记录，请找回已保存记录后再修订");
        }
      }
      if (legacyExpected && expected)
        throw new Error("旧认知整理只能创建独立新记录");
      const origin = legacyExpected
        ? await this.legacy.freeze(root, legacyExpected)
        : null;
      if (previous?.data.status === "retired")
        throw new Error("请先恢复停用记录");
      const proposition = await this.materials.record(
        root,
        clean.propositionId,
      );
      if (proposition.data.kind !== "proposition" || proposition.data.deletedAt)
        throw new Error("请选择本书可用的命题资料");
      const freeze = (record) => ({
        title: record.data.title,
        revision: record.data.revision,
        definitionHash: materialDefinitionHash(record.data),
      });
      let character = null;
      if (clean.scope === "character") {
        character = await this.materials.record(root, clean.characterId);
        if (character.data.kind !== "character" || character.data.deletedAt)
          throw new Error("请选择本书可用的人物");
      }
      const anchor = await checkedEvidenceSource(
          this.storage,
          root,
          book,
          source,
        ),
        now = new Date().toISOString();
      const data = {
        schemaVersion: 1,
        ...clean,
        ...anchor,
        id: previous?.data.id || creationId || randomUUID(),
        revision: (previous?.data.revision || 0) + 1,
        status: "active",
        proposition: freeze(proposition),
        character: character ? freeze(character) : null,
        createdAt: previous?.data.createdAt || now,
        updatedAt: now,
      };
      await this.write(root, data, previous, origin);
      return this.view(await this.record(root, data.id), root, book);
    });
  }
  linkLegacy(bookId, input, legacyExpected, source, creationId) {
    if (!legacyExpected) throw new Error("请明确选择旧认知来源");
    return this.save(bookId, input, null, source, legacyExpected, creationId);
  }
  creation(bookId, creationId) {
    id(creationId);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId);
      let record;
      try {
        record = await this.record(root, creationId);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      return this.view(record, root, book);
    });
  }
  read(bookId, eventId) {
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId);
      return this.view(await this.record(root, eventId), root, book);
    });
  }
  setRetired(bookId, expected, retired) {
    if (typeof retired !== "boolean") throw new Error("停用状态无效");
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        previous = await this.expected(root, expected),
        data = {
          ...previous.data,
          status: retired ? "retired" : "active",
          revision: previous.data.revision + 1,
          updatedAt: new Date().toISOString(),
        };
      await this.write(root, data, previous);
      return this.view(await this.record(root, data.id), root, book);
    });
  }
  async scan(bookId, visit, select = () => true, signal) {
    signal?.throwIfAborted();
    const entries = await this.storage.exclusive(async () => {
      const { root } = await this.materials.context(bookId);
      try {
        return (
          await readdir(await this.storage.path(root, "knowledge/events"))
        )
          .filter((name) => name.endsWith(".json"))
          .sort();
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    });
    const errors = [];
    for (const name of entries) {
      signal?.throwIfAborted();
      await this.storage.exclusive(async () => {
        signal?.throwIfAborted();
        const { root, book } = await this.materials.context(bookId);
        try {
          const record = await this.record(root, name.slice(0, -5));
          if (select(record.data, book)) {
            const view = await this.view(record, root, book);
            if (view.origin?.status === "unreadable")
              errors.push("一份旧认知来源无法读取，独立认知记录仍已保留");
            visit(view, book);
          }
        } catch {
          errors.push("一条认知记录无法读取，原文件已保留");
        }
      });
    }
    signal?.throwIfAborted();
    return errors;
  }
  async matrix(bookId, options = {}, signal) {
    signal?.throwIfAborted();
    const {
      characterIds = [],
      query = "",
      offset = 0,
      upToChapterId = "",
      includeRetired = false,
    } = options;
    if (
      !Array.isArray(characterIds) ||
      characterIds.length > 8 ||
      new Set(characterIds).size !== characterIds.length ||
      typeof query !== "string" ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof includeRetired !== "boolean"
    )
      throw new Error("矩阵筛选无效");
    characterIds.forEach(id);
    if (upToChapterId) id(upToChapterId);
    const propositions = [],
      characters = new Map();
    const errors = await this.materials.scan(
      bookId,
      (data) => {
        if (
          data.kind === "proposition" &&
          (!query ||
            [data.title, data.fields.claim]
              .join("\n")
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()))
        )
          propositions.push({
            id: data.id,
            title: data.title,
            claim: data.fields.claim,
            truthIntent: data.fields.truthIntent,
            deleted: !!data.deletedAt,
          });
        if (data.kind === "character")
          characters.set(data.id, {
            id: data.id,
            title: data.title,
            deleted: !!data.deletedAt,
          });
      },
      { signal },
    );
    propositions.sort(
      (a, b) =>
        a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id),
    );
    const rows = propositions.slice(offset, offset + 20).map((item) => ({
      ...item,
      cells: {
        world: { total: 0, events: [] },
        reader: { total: 0, events: [] },
        ...Object.fromEntries(
          characterIds.map((characterId) => [
            characterId,
            { total: 0, events: [] },
          ]),
        ),
      },
    }));
    const selected = new Map(rows.map((row) => [row.id, row]));
    let excludedMissingSources = 0;
    if (upToChapterId)
      await this.storage.exclusive(async () => {
        const { book } = await this.materials.context(bookId);
        if (
          !orderedChapters(book).some((chapter) => chapter.id === upToChapterId)
        )
          throw new Error("叙述进度章节失联或已删除");
      });
    errors.push(
      ...(await this.scan(
        bookId,
        (event) => {
          const key =
              event.scope === "character" ? event.characterId : event.scope,
            cell = selected.get(event.propositionId)?.cells[key];
          if (!cell) return;
          cell.total++;
          if (cell.events.length < 5)
            cell.events.push({
              id: event.id,
              state: event.state,
              statement: [...event.statement].slice(0, 160).join(""),
              freshness: event.freshness,
              status: event.status,
              storyTime: event.storyTime,
              chapterTitle: event.chapterTitle,
              originStatus: event.origin?.status,
            });
        },
        (event, book) => {
          if (event.scope === "character" && !characters.has(event.characterId))
            characters.set(event.characterId, {
              id: event.characterId,
              title: event.character.title,
              missing: true,
            });
          if (
            !selected.has(event.propositionId) ||
            (!includeRetired && event.status === "retired")
          )
            return false;
          if (!upToChapterId) return true;
          const chapters = orderedChapters(book),
            source = chapters.findIndex((item) => item.id === event.chapterId),
            limit = chapters.findIndex((item) => item.id === upToChapterId);
          if (source < 0) {
            excludedMissingSources++;
            return false;
          }
          return source <= limit;
        },
        signal,
      )),
    );
    if (!upToChapterId) {
      const choices = await this.choices.project(
        bookId,
        new Set(rows.map((row) => row.id)),
        characterIds,
        signal,
      );
      errors.push(...choices.errors);
      for (const choice of choices.items) {
        const cell = selected.get(choice.identity.propositionId)?.cells[
          choice.identity.scope === "character"
            ? choice.identity.characterId
            : choice.identity.scope
        ];
        if (cell) cell.choice = choice;
      }
    }
    return {
      rows,
      total: propositions.length,
      offset,
      characters: [...characters.values()].sort(
        (a, b) =>
          a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id),
      ),
      errors,
      excludedMissingSources,
      consistency: "live-scan",
    };
  }
  async list(bookId, options = {}) {
    const {
      propositionId = "",
      scope = "",
      characterId = "",
      offset = 0,
    } = options;
    if (propositionId) id(propositionId);
    if (characterId) id(characterId);
    if (
      !["", "world", "reader", "character"].includes(scope) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("认知列表筛选无效");
    const items = [];
    let total = 0;
    const errors = await this.scan(
      bookId,
      (event) => {
        if (total++ >= offset && items.length < 40) items.push(event);
      },
      (event) =>
        (!propositionId || event.propositionId === propositionId) &&
        (!scope || event.scope === scope) &&
        (!characterId || event.characterId === characterId),
    );
    return { items, total, errors, offset };
  }
  history(bookId, eventId, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("历史分页无效");
    return this.storage.exclusive(async () => {
      const { root } = await this.materials.context(bookId);
      id(eventId);
      let names = [];
      try {
        names = (
          await readdir(
            await this.storage.path(
              root,
              `.zinovel/knowledge-history/${eventId}`,
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
          const data = JSON.parse(
            await readUtf8File(
              await this.storage.path(
                root,
                `.zinovel/knowledge-history/${eventId}/${name}`,
              ),
            ),
          );
          knowledgeInput(data);
          validateEvidence(
            [{ ...data, kind: "fact", scope: "world", relatedIds: [] }],
            "proposition",
          );
          if (data.id !== eventId || data.schemaVersion !== 1)
            throw new Error("历史身份无效");
          items.push(data);
        } catch {
          errors.push("一份认知历史无法读取，原文件已保留");
        }
      return { items, total: names.length, errors, offset };
    });
  }
}
