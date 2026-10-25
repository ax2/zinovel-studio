import { lstat } from "node:fs/promises";
import { assetId } from "../novel-domain/assets.mjs";
import {
  characterLookInput,
  characterLookExpected,
  characterLookLimits,
  validateCharacterLooks,
} from "../novel-domain/character-looks.mjs";
import { readUtf8File } from "./encoding.mjs";
import { binaryHash } from "./image-decoder.mjs";

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const pathFor = (id) => `world/character-looks/${assetId(id)}.json`;
const historyFor = (id, expected) =>
  `.zinovel/character-look-history/${assetId(id)}/${expected.revision}-${expected.diskHash}.json`;
const baseline = (r) => ({
  id: r.data.id,
  revision: r.data.revision,
  diskHash: r.diskHash,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Offline character appearance versions. Every operation shares the book's existing kernel. */
export class CharacterLookStore {
  constructor(storage, materials, assets) {
    if (materials.storage !== storage || assets.storage !== storage)
      throw new Error("人物形象必须共享唯一作品写入内核");
    this.storage = storage;
    this.materials = materials;
    this.assets = assets;
  }
  async context(bookId, characterId, writable = false) {
    const ctx = await this.assets.context(assetId(bookId));
    if (writable && (ctx.book.archivedAt || ctx.book.deletedAt))
      throw new Error("作品已归档或回收，人物形象未修改");
    const character = await this.materials.record(
      ctx.root,
      assetId(characterId),
    );
    if (character.data.kind !== "character")
      throw new Error("人物形象只能关联人物卡");
    return { ...ctx, characterId, character };
  }
  async characterCurrent(ctx, expected, allowDeleted = false) {
    const character = await this.materials.record(ctx.root, ctx.characterId);
    if (
      !same(baseline(character), expected) ||
      character.data.kind !== "character"
    )
      throw new Error("人物资料已改变，请重新读取核对");
    if (!allowDeleted && character.data.deletedAt)
      throw new Error("人物已回收，请先恢复人物");
    return character;
  }
  async record(ctx, expected = null) {
    const path = expected
      ? historyFor(ctx.characterId, expected)
      : pathFor(ctx.characterId);
    let stat;
    try {
      stat = await lstat(await this.storage.path(ctx.root, path));
    } catch (error) {
      if (error.code === "ENOENT" && !expected) return null;
      throw error;
    }
    if (!stat.isFile() || stat.size > characterLookLimits.bytes)
      throw new Error("人物形象文件过大或无法读取，请保留原件");
    const raw = await readUtf8File(await this.storage.path(ctx.root, path));
    if (Buffer.byteLength(raw) > characterLookLimits.bytes)
      throw new Error("人物形象文件超过1MiB");
    const data = JSON.parse(raw),
      diskHash = binaryHash(Buffer.from(raw));
    validateCharacterLooks(data, ctx.characterId, ctx.origins);
    if (
      expected &&
      (data.revision !== expected.revision || diskHash !== expected.diskHash)
    )
      throw new Error("人物形象历史校验失败，请保留原件");
    return { data, diskHash, raw, path };
  }
  async current(ctx, expected) {
    const record = await this.record(ctx);
    if (
      (record === null) !== (expected === null) ||
      (record &&
        (record.data.revision !== expected.revision ||
          record.diskHash !== expected.diskHash))
    )
      throw new Error("人物形象已被其他操作修改，请重新读取，当前草稿应保留");
    return record;
  }
  async selectedEntry(ctx, record) {
    if (!record.data.selected) return null;
    const selection = record.data.selected,
      source = await this.record(ctx, selection.source);
    const entry = source.data.entries.find((e) => e.id === selection.entryId);
    if (!entry || entry.deletedAt || entry.revision !== selection.entryRevision)
      throw new Error("选定形象的历史来源不符，请保留原件");
    return entry;
  }
  async view(ctx, record) {
    if (!record)
      return {
        record: null,
        character: baseline(ctx.character),
        selectedEntry: null,
        selectedError: null,
        characterChanged: false,
      };
    let selectedEntry = null,
      selectedError = null;
    try {
      selectedEntry = await this.selectedEntry(ctx, record);
    } catch (error) {
      selectedError = error.message;
    }
    return {
      record: { ...record.data, diskHash: record.diskHash },
      character: baseline(ctx.character),
      selectedEntry,
      selectedError,
      characterChanged:
        !!record.data.selected &&
        !same(record.data.selected.character, baseline(ctx.character)),
    };
  }
  read(bookId, characterId) {
    assetId(bookId);
    assetId(characterId);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId, characterId);
      return this.view(ctx, await this.record(ctx));
    });
  }
  async assetCurrent(ctx, expected) {
    const asset = await this.assets.current(ctx, expected);
    if (
      asset.data.deletedAt ||
      asset.data.purpose !== "portrait" ||
      !asset.data.linkedIds.includes(ctx.characterId)
    )
      throw new Error("请选择关联此人物的未回收定妆资源");
    await this.assets.blobBytes(ctx, asset.data.blob);
    return { record: asset.data, diskHash: asset.diskHash };
  }
  async frozenAsset(ctx, entry, forSelection = false) {
    const frozen = entry.asset,
      expected = {
        id: frozen.record.id,
        revision: frozen.record.revision,
        diskHash: frozen.diskHash,
      };
    const current = await this.assets.record(ctx, expected.id);
    if (forSelection && current.data.deletedAt)
      throw new Error("图像资源已回收，不能新选为定妆");
    const actual =
      current.data.revision === expected.revision &&
      current.diskHash === expected.diskHash
        ? current
        : await this.assets.record(ctx, expected.id, expected);
    if (
      !same(actual.data, frozen.record) ||
      actual.diskHash !== frozen.diskHash
    )
      throw new Error("固定图像版本与人物形象不符，请保留原件");
    return this.assets.blobBytes(ctx, actual.data.blob);
  }
  async preview(
    bookId,
    characterId,
    collectionValue,
    entryId,
    selected = false,
  ) {
    assetId(bookId);
    assetId(characterId);
    assetId(entryId);
    if (typeof selected !== "boolean") throw new Error("形象预览条件无效");
    const expected = characterLookExpected(collectionValue);
    const read = async () => {
      const ctx = await this.context(bookId, characterId),
        current = await this.current(ctx, expected);
      const entry = selected
        ? await this.selectedEntry(ctx, current)
        : current.data.entries.find((e) => e.id === entryId);
      if (!entry || entry.id !== entryId)
        throw new Error("形象不属于当前预览选择");
      return { entry, bytes: await this.frozenAsset(ctx, entry) };
    };
    const initial = await this.storage.exclusive(read),
      image = await this.assets.decode(initial.bytes);
    if (
      Object.keys(image.blob).some(
        (key) => image.blob[key] !== initial.entry.asset.record.blob[key],
      )
    )
      throw new Error("固定形象原图与记录不符，请保留原件");
    await this.storage.exclusive(read);
    return {
      id: entryId,
      revision: initial.entry.revision,
      blob: image.blob,
      dataUrl: `data:image/png;base64,${image.thumbnail.toString("base64")}`,
    };
  }
  async commit(ctx, previous, data, preflight) {
    validateCharacterLooks(data, ctx.characterId, ctx.origins);
    if (data.selected && same(data.selected, previous?.data.selected)) {
      try {
        await this.selectedEntry(ctx, previous);
      } catch (error) {
        throw new Error("已选人物形象的历史来源无法校验，请保留原件", {
          cause: error,
        });
      }
    }
    const raw = json(data);
    if (Buffer.byteLength(raw) > characterLookLimits.bytes)
      throw new Error("人物形象超过1MiB，请缩减说明，原件未改动");
    const currentPath = pathFor(ctx.characterId),
      changes = { [currentPath]: raw },
      expectedBefore = { [currentPath]: previous?.raw ?? null };
    if (previous) {
      const path = historyFor(ctx.characterId, {
        revision: previous.data.revision,
        diskHash: previous.diskHash,
      });
      let before = null;
      try {
        const file = await this.storage.path(ctx.root, path),
          stat = await lstat(file);
        if (!stat.isFile() || stat.size > characterLookLimits.bytes)
          throw new Error("人物形象历史无法读取");
        before = await readUtf8File(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (before !== null && before !== previous.raw)
        throw new Error("人物形象历史已改变，请保留原件");
      changes[path] = previous.raw;
      expectedBefore[path] = before;
    }
    await preflight();
    await this.storage.transaction(ctx.root, changes, { expectedBefore });
    return this.view(ctx, {
      data,
      diskHash: binaryHash(Buffer.from(raw)),
      raw,
      path: currentPath,
    });
  }
  next(ctx, previous) {
    const at = new Date().toISOString();
    return previous
      ? {
          ...previous.data,
          revision: previous.data.revision + 1,
          updatedAt: at,
        }
      : {
          schemaVersion: 1,
          bookId: ctx.book.id,
          characterId: ctx.characterId,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          entries: [],
          selected: null,
        };
  }
  save(
    bookId,
    characterValue,
    collectionValue,
    entryId,
    value,
    assetValue = null,
  ) {
    assetId(bookId);
    assetId(entryId);
    const character = characterLookExpected(characterValue, true),
      expected =
        collectionValue === null
          ? null
          : characterLookExpected(collectionValue),
      input = characterLookInput(value),
      asset =
        assetValue === null ? null : characterLookExpected(assetValue, true);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId, character.id, true),
        previous = await this.current(ctx, expected);
      await this.characterCurrent(ctx, character);
      const old = previous?.data.entries.find((e) => e.id === entryId);
      if (old?.deletedAt) throw new Error("形象已回收，请先恢复后编辑");
      if (!old && !asset) throw new Error("新人物形象必须明确选择固定图像版本");
      const frozen = asset ? await this.assetCurrent(ctx, asset) : old.asset;
      if (
        old &&
        same(old.input, input) &&
        same(old.asset, frozen) &&
        same(old.character, character)
      )
        return this.view(ctx, previous);
      const data = this.next(ctx, previous),
        at = data.updatedAt;
      const entry = {
        id: entryId,
        revision: (old?.revision || 0) + 1,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
        deletedAt: null,
        character,
        asset: frozen,
        input,
      };
      data.entries = old
        ? data.entries.map((e) => (e.id === entryId ? entry : e))
        : [...data.entries, entry];
      return this.commit(ctx, previous, data, async () => {
        if (asset) await this.assetCurrent(ctx, asset);
        await this.characterCurrent(ctx, character);
      });
    });
  }
  choose(bookId, characterValue, collectionValue, entryId, confirmation) {
    assetId(bookId);
    if (entryId !== null) assetId(entryId);
    if (confirmation !== "confirm-portrait-choice-v1")
      throw new Error("请预览并明确确认当前定妆选择");
    const character = characterLookExpected(characterValue, true),
      expected = characterLookExpected(collectionValue);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId, character.id, true),
        previous = await this.current(ctx, expected);
      await this.characterCurrent(ctx, character, entryId === null);
      const entry =
        entryId === null
          ? null
          : previous.data.entries.find((e) => e.id === entryId && !e.deletedAt);
      if (entryId !== null && !entry)
        throw new Error("请选择此人物未回收的形象");
      if (entry) await this.frozenAsset(ctx, entry, true);
      const selected = previous.data.selected;
      if (
        (!entry && !selected) ||
        (entry &&
          selected?.entryId === entry.id &&
          selected.entryRevision === entry.revision &&
          same(selected.character, character))
      )
        return this.view(ctx, previous);
      const data = this.next(ctx, previous);
      data.selected = entry
        ? {
            source: {
              revision: previous.data.revision,
              diskHash: previous.diskHash,
            },
            entryId: entry.id,
            entryRevision: entry.revision,
            selectedAt: data.updatedAt,
            character,
          }
        : null;
      return this.commit(ctx, previous, data, async () => {
        if (entry) await this.frozenAsset(ctx, entry, true);
        await this.characterCurrent(ctx, character, entryId === null);
      });
    });
  }
  setDeleted(bookId, characterId, collectionValue, entryId, deleted) {
    assetId(bookId);
    assetId(characterId);
    assetId(entryId);
    if (typeof deleted !== "boolean") throw new Error("人物形象回收状态无效");
    const expected = characterLookExpected(collectionValue);
    return this.storage.exclusive(async () => {
      const ctx = await this.context(bookId, characterId, true),
        previous = await this.current(ctx, expected),
        entry = previous.data.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error("人物形象不存在");
      if (deleted && previous.data.selected?.entryId === entryId)
        throw new Error("请先明确取消当前定妆，再回收形象");
      if (!!entry.deletedAt === deleted) return this.view(ctx, previous);
      const data = this.next(ctx, previous);
      data.entries = data.entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              revision: e.revision + 1,
              updatedAt: data.updatedAt,
              deletedAt: deleted ? data.updatedAt : null,
            }
          : e,
      );
      return this.commit(ctx, previous, data, async () => {});
    });
  }
}
