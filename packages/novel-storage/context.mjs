import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { materialMarkdown } from "../novel-domain/materials.mjs";
import { materialContextText } from "../novel-domain/material-context.mjs";
import { materialDefinitionHash } from "./materials.mjs";
import { knowledgeStates } from "../novel-domain/knowledge.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex"),
  json = (value) => JSON.stringify(value, null, 2) + "\n",
  uuid = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const state = (value) =>
  knowledgeStates.find((item) => item.id === value)?.label || value;
const scope = (data) =>
  data.scope === "world"
    ? "世界记录（作者录入）"
    : data.scope === "reader"
      ? "读者"
      : `人物：${data.character?.title || "未命名人物"}`;
export function contextReference(value) {
  if (uuid(value)) return { type: "material", id: value };
  if (typeof value !== "string") throw new Error("参考资料身份无效");
  const parts = value.split(":");
  if (parts.length === 2 && parts[0] === "knowledge" && uuid(parts[1]))
    return { type: "knowledge", id: parts[1] };
  if (
    parts.length === 4 &&
    parts[0] === "choice" &&
    uuid(parts[1]) &&
    ["world", "reader", "character"].includes(parts[2]) &&
    (parts[2] === "character" ? uuid(parts[3]) : parts[3] === "-")
  )
    return {
      type: "choice",
      propositionId: parts[1],
      scope: parts[2],
      characterId: parts[2] === "character" ? parts[3] : null,
    };
  throw new Error("参考资料身份或类型无效");
}
export class MixedContext {
  constructor(storage, materials, knowledge) {
    this.storage = storage;
    this.materials = materials;
    this.knowledge = knowledge;
  }
  async proof(root, book, data, selectedHash, origin, cache) {
    const files = new Set();
    const addMaterial = (id) => {
      if (id) files.add(`materials/${id}.json`);
    };
    addMaterial(data.propositionId);
    addMaterial(data.characterId);
    const chapterIds = new Set([
      ...(data.chapterIds || []),
      ...(data.evidence || []).map((item) => item.chapterId),
      ...(data.chapterId ? [data.chapterId] : []),
    ]);
    for (const event of data.evidence || [])
      for (const related of event.relatedIds || []) addMaterial(related);
    for (const chapterId of chapterIds) files.add(`manuscript/${chapterId}.md`);
    if (data.propositionId) {
      files.add(`knowledge/events/${data.id}.json`);
      files.add(`knowledge/origins/${data.id}.json`);
      addMaterial(origin?.source?.ownerId);
    }
    const entries = [];
    for (const file of [...files].sort()) {
      if (!cache.has(file))
        cache.set(
          file,
          (async () => {
            try {
              const bytes = await readFile(await this.storage.path(root, file));
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                bytes,
              );
              return hash(bytes);
            } catch (error) {
              if (error.code === "ENOENT") return null;
              throw error;
            }
          })(),
        );
      entries.push([file, await cache.get(file)]);
    }
    return hash(
      json([
        selectedHash,
        entries,
        [...chapterIds].sort().map((id) => {
          const chapter = book.chapters.find((item) => item.id === id);
          return [id, chapter?.title || null, chapter?.deletedAt || null];
        }),
      ]),
    );
  }
  pack(bookId, references) {
    if (
      !Array.isArray(references) ||
      references.length > 8 ||
      new Set(references).size !== references.length
    )
      throw new Error("请选择最多8份不同资料或认知");
    const refs = references.map(contextReference);
    // Existing material-only callers retain their exact snapshot contract.
    if (refs.every((ref) => ref.type === "material"))
      return this.materials.contextPack(bookId, references);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        materials = [],
        cache = new Map();
      for (let index = 0; index < refs.length; index++) {
        const ref = refs[index];
        if (ref.type === "material") {
          const record = await this.materials.record(root, ref.id);
          if (record.data.deletedAt)
            throw new Error("所选资料已删除，请调整选择");
          const view = await this.materials.view(record, book, root);
          materials.push({
            id: ref.id,
            title: view.title,
            kind: view.kind,
            revision: view.revision,
            diskHash: view.diskHash,
            content: materialMarkdown(view),
            proofHash: await this.proof(
              root,
              book,
              record.data,
              record.diskHash,
              null,
              cache,
            ),
          });
          continue;
        }
        let record,
          view,
          choice = null;
        if (ref.type === "choice") {
          choice = await this.knowledge.choices.record(root, ref);
          if (!choice || choice.data.status !== "active")
            throw new Error("作者当前选择已清除或失联，请刷新快照");
          view = await this.knowledge.choices.view(choice, root, book);
          record = choice.snapshot;
        } else {
          record = await this.knowledge.record(root, ref.id);
          view = await this.knowledge.view(record, root, book);
        }
        if (record.data.status !== "active" || view.freshness === "missing")
          throw new Error("所选认知已停用或来源失联，请调整选择");
        const event = record.data,
          origin = await this.knowledge.legacy.view(record, root);
        if (origin?.status === "unreadable")
          throw new Error("认知的旧来源无法读取，原文件已保留");
        const proposition = await this.materials.record(
            root,
            event.propositionId,
          ),
          sameDefinition =
            materialDefinitionHash(proposition.data) ===
            event.proposition.definitionHash;
        const meaning = sameDefinition
          ? proposition.data.fields.claim
          : "命题定义已变；以下仅保留原记录说明与引文，不套用新定义。";
        const title = `${choice ? "作者选择" : "认知"} · ${event.proposition.title} · ${scope(event)} · ${state(event.state)}`;
        const chapter = book.chapters.find(
          (item) => item.id === event.chapterId,
        );
        const content = [
          choice
            ? "类型：作者明确选用的冻结事件，不是自动故事时间结论"
            : "类型：作者录入的认知事件，不自动代表世界事实",
          `命题：${event.proposition.title}`,
          `命题含义（并非真相判定）：${meaning}`,
          `范围：${scope(event)}`,
          `状态：${state(event.state)}（相信/怀疑不等于知道；不同人物与读者不能互借认知）`,
          `有效性：${view.freshness === "current" ? "当前依据与定义一致" : "待复核，只作带版本的参考，不能称已核实事实"}`,
          `记录说明：${event.statement}`,
          `故事时间：${event.storyTime || "未标注"}`,
          `正文来源：${chapter?.title || "失联"} (${event.chapterId})`,
          `原始正文引文：\n${event.anchor.quote}`,
          origin
            ? `旧来源链：${{ unchanged: "原事件未变", changed: "原事件改变或停用", missing: "原事件失联" }[origin.status] || "需核对"}；未附旧资料全文或其他认知`
            : "无旧认知关联来源",
        ].join("\n");
        materials.push({
          id: references[index],
          title,
          kind: choice ? "knowledge-choice" : "knowledge-event",
          revision: choice?.data.revision || event.revision,
          diskHash: choice?.diskHash || record.diskHash,
          content,
          proofHash: await this.proof(
            root,
            book,
            event,
            choice?.diskHash || record.diskHash,
            origin,
            cache,
          ),
        });
      }
      const pack = { schemaVersion: 1, bookId, materials },
        text = materialContextText(pack);
      return {
        ...pack,
        characters: text.length,
        hash: hash(json(pack)),
        truncated: false,
      };
    });
  }
  async choices(
    bookId,
    { kind = "material", query = "", offset = 0 } = {},
    signal,
  ) {
    if (
      !["material", "knowledge", "choice"].includes(kind) ||
      typeof query !== "string" ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("参考资料筛选无效");
    const candidates = [],
      needle = query.toLocaleLowerCase();
    const collect = (item, searchText = item.title) => {
      if (query && !searchText.toLocaleLowerCase().includes(needle)) return;
      candidates.push(item);
    };
    let errors = [];
    if (kind === "material")
      errors = await this.materials.scan(
        bookId,
        (data) => {
          if (
            !data.deletedAt &&
            (!query ||
              [data.title, data.notes, ...Object.values(data.fields)]
                .join("\n")
                .toLocaleLowerCase()
                .includes(needle))
          )
            candidates.push({ id: data.id, title: data.title });
        },
        { signal },
      );
    else if (kind === "knowledge")
      errors = await this.knowledge.scan(
        bookId,
        (event) => {
          collect(
            {
              id: `knowledge:${event.id}`,
              title: `${event.proposition.title} · ${scope(event)} · ${state(event.state)} · ${[...event.statement].slice(0, 100).join("")}`,
              unavailable:
                event.freshness === "missing" ||
                event.origin?.status === "unreadable",
            },
            `${event.proposition.title}\n${scope(event)}\n${event.statement}\n${event.storyTime}`,
          );
        },
        (data) => data.status === "active",
        signal,
      );
    else {
      const result = await this.knowledge.choices.project(
        bookId,
        null,
        null,
        signal,
        (item) => {
          if (item.status === "active")
            collect(
              {
                id: `choice:${item.identity.propositionId}:${item.identity.scope}:${item.identity.characterId || "-"}`,
                title: `${item.snapshot.proposition.title} · ${scope(item.snapshot)} · 作者选用${state(item.snapshot.state)}${item.freshness === "current" ? "" : "（待复核）"}`,
                unavailable: item.freshness === "missing",
              },
              `${item.snapshot.proposition.title}\n${scope(item.snapshot)}\n${item.snapshot.statement}\n${item.snapshot.storyTime}`,
            );
        },
      );
      errors = result.errors;
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return {
      items: candidates.slice(offset, offset + 40),
      total: candidates.length,
      offset,
      errors,
    };
  }
}
