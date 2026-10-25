import { readUtf8File } from "./encoding.mjs";
import { createHash } from "node:crypto";
import { orderedChapters } from "../novel-domain/structure.mjs";
import { lstat } from "node:fs/promises";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const isId = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const clip = (value) =>
  value.length <= 240 ? value : value.slice(0, 240) + "…";

export class PlanningStore {
  constructor(storage, materials) {
    this.storage = storage;
    this.materials = materials;
  }
  async record(root) {
    let raw;
    try {
      raw = await readUtf8File(await this.storage.path(root, "planning.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (raw === undefined)
      return {
        data: { schemaVersion: 1, revision: 0, placements: [] },
        diskHash: null,
      };
    const data = JSON.parse(raw),
      ids = new Set();
    if (
      data.schemaVersion !== 1 ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1 ||
      !Array.isArray(data.placements)
    )
      throw new Error("场景规划格式损坏或版本不支持，原文件已保留");
    for (const item of data.placements) {
      if (
        !isId(item.sceneId) ||
        (item.chapterId !== null && !isId(item.chapterId)) ||
        !Number.isSafeInteger(item.order) ||
        item.order < 0 ||
        ids.has(item.sceneId)
      )
        throw new Error("场景规划位置无效或重复，原文件已保留");
      ids.add(item.sceneId);
    }
    return { data, diskHash: hash(raw), raw };
  }
  async scenes(bookId) {
    const scenes = [];
    const errors = await this.materials.scan(bookId, (data) => {
      if (data.kind !== "scene") return;
      scenes.push({
        id: data.id,
        title: data.title,
        status: data.status,
        deletedAt: data.deletedAt,
        revision: data.revision,
        fields: Object.fromEntries(
          Object.entries(data.fields).map(([key, value]) => [key, clip(value)]),
        ),
      });
    });
    return { scenes, errorCount: errors.length };
  }
  async read(bookId) {
    const { scenes, errorCount } = await this.scenes(bookId);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        record = await this.record(root);
      const known = new Map(scenes.map((scene) => [scene.id, scene]));
      const columns = [
        { id: null, title: "未安排", state: "active" },
        ...orderedChapters(book).map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          volume:
            book.volumes?.find((volume) => volume.id === chapter.volumeId)
              ?.title || "",
          state: "active",
        })),
      ];
      const placements = this.ordered(record.data.placements, scenes);
      for (const placement of placements) {
        if (!columns.some((column) => column.id === placement.chapterId)) {
          const chapter = book.chapters.find(
            (chapter) => chapter.id === placement.chapterId,
          );
          columns.push({
            id: placement.chapterId,
            title: chapter?.title || "章节不存在",
            state: chapter?.deletedAt ? "deleted" : "missing",
          });
        }
      }
      return {
        revision: record.data.revision,
        diskHash: record.diskHash,
        errorCount,
        columns: columns.map((column) => ({
          ...column,
          scenes: placements
            .filter((item) => item.chapterId === column.id)
            .map((item) => {
              const scene = known.get(item.sceneId);
              return {
                ...scene,
                id: item.sceneId,
                title: scene?.title || "场景不可读取",
                state: !scene
                  ? "missing"
                  : scene.deletedAt
                    ? "deleted"
                    : "active",
              };
            }),
        })),
      };
    });
  }
  ordered(placements, scenes) {
    const result = placements.toSorted(
      (a, b) => a.order - b.order || a.sceneId.localeCompare(b.sceneId),
    );
    const placed = new Set(result.map((item) => item.sceneId));
    for (const scene of scenes.toSorted((a, b) => a.id.localeCompare(b.id)))
      if (!placed.has(scene.id))
        result.push({
          sceneId: scene.id,
          chapterId: null,
          order: result.length,
        });
    return result;
  }
  async move(bookId, mutation, expected) {
    if (
      !mutation ||
      !isId(mutation.sceneId) ||
      (mutation.chapterId !== null && !isId(mutation.chapterId)) ||
      (mutation.beforeId !== null && !isId(mutation.beforeId)) ||
      mutation.beforeId === mutation.sceneId
    )
      throw new Error("无效的场景移动参数");
    if (
      !expected ||
      !Number.isSafeInteger(expected.revision) ||
      expected.revision < 0 ||
      (expected.revision === 0
        ? expected.diskHash !== null
        : typeof expected.diskHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(expected.diskHash))
    )
      throw new Error("场景规划基线无效，请重新读取后移动");
    // Capture caller-owned values before the batched scan yields.
    mutation = {
      sceneId: mutation.sceneId,
      chapterId: mutation.chapterId,
      beforeId: mutation.beforeId,
    };
    expected = { revision: expected.revision, diskHash: expected.diskHash };
    // Scan in bounded batches, then validate the actual moved identities inside the write transaction.
    const { scenes } = await this.scenes(bookId);
    return this.storage.exclusive(async () => {
      const { root, book } = await this.materials.context(bookId),
        previous = await this.record(root);
      if (
        !expected ||
        previous.data.revision !== expected.revision ||
        previous.diskHash !== expected.diskHash
      )
        throw new Error(
          "场景规划已被其他操作或外部编辑修改。移动未执行，请刷新规划后重试。",
        );
      const scene = (await this.materials.record(root, mutation.sceneId)).data;
      if (scene.kind !== "scene" || scene.deletedAt)
        throw new Error("场景不存在或已删除，请刷新规划");
      if (
        mutation.chapterId &&
        !book.chapters.some(
          (chapter) => chapter.id === mutation.chapterId && !chapter.deletedAt,
        )
      )
        throw new Error("目标章节不存在或已删除，请刷新规划");
      const placements = this.ordered(previous.data.placements, scenes).filter(
        (item) => item.sceneId !== scene.id,
      );
      let index = placements.length;
      if (mutation.beforeId) {
        const before = (await this.materials.record(root, mutation.beforeId))
          .data;
        index = placements.findIndex(
          (item) =>
            item.sceneId === before.id && item.chapterId === mutation.chapterId,
        );
        if (before.kind !== "scene" || before.deletedAt || index < 0)
          throw new Error("相邻场景已变化，请刷新规划");
      }
      placements.splice(index, 0, {
        sceneId: scene.id,
        chapterId: mutation.chapterId,
        order: 0,
      });
      const next = {
        schemaVersion: 1,
        revision: previous.data.revision + 1,
        updatedAt: new Date().toISOString(),
        placements: placements.map((item, order) => ({ ...item, order })),
      };
      const changes = { "planning.json": json(next) };
      const expectedBefore = { "planning.json": previous.raw ?? null };
      if (previous.raw) {
        const path = `.zinovel/planning-history/${previous.data.revision}-${previous.diskHash}.json`;
        let prior = null;
        try {
          const file = await this.storage.path(root, path),
            stat = await lstat(file);
          if (!stat.isFile() || stat.size !== Buffer.byteLength(previous.raw))
            throw new Error("场景规划历史已改变，请保留原件");
          prior = await readUtf8File(file);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (prior !== null && prior !== previous.raw)
          throw new Error("场景规划历史已改变，请保留原件");
        changes[path] = previous.raw;
        expectedBefore[path] = prior;
      }
      await this.storage.transaction(root, changes, { expectedBefore });
      return { revision: next.revision, diskHash: hash(json(next)) };
    });
  }
}
