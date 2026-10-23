import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { materialContextText } from "../packages/novel-domain/material-context.mjs";
import { apply } from "../packages/novel-harness/tools-plugin.mjs";
const input = (title) => ({
  kind: "character",
  title,
  status: "planned",
  notes: "作者计划尚未成为事实",
  fields: { voice: "说话很少使用形容词" },
  chapterIds: [],
});
test("context snapshots contain only explicit same-book records and change identity when records change; overflow is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-context-")),
    store = new NovelStore(root),
    book = await store.createBook("本书"),
    other = await store.createBook("他书");
  let a = await store.materials.save(book.id, input("林舟"));
  await store.materials.save(book.id, input("未选择的角色"));
  const foreign = await store.materials.save(other.id, input("隔离测试"));
  const pack = await store.materials.contextPack(book.id, [a.id]);
  assert.equal(pack.materials.length, 1);
  assert.match(materialContextText(pack), /作者计划/);
  assert.doesNotMatch(materialContextText(pack), /隔离测试|未选择的角色/);
  assert.equal(
    (await store.materials.contextPack(book.id, [a.id])).hash,
    pack.hash,
  );
  a = await store.materials.save(book.id, { ...a, notes: "新计划" }, a);
  assert.notEqual(
    (await store.materials.contextPack(book.id, [a.id])).hash,
    pack.hash,
  );
  assert.match(pack.materials[0].content, /尚未成为事实/);
  await assert.rejects(store.materials.contextPack(book.id, [foreign.id]));
  await assert.rejects(
    store.materials.contextPack(book.id, Array(9).fill(a.id)),
    /最多 8/,
  );
  a = await store.materials.save(
    book.id,
    { ...a, notes: "长".repeat(21000) },
    a,
  );
  await assert.rejects(
    store.materials.contextPack(book.id, [a.id]),
    /不会静默截断/,
  );
});
test("material read tool exposes only frozen host-generated context and rejects path or cross-book arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-context-tool-")),
    snapshotPath = join(root, "snapshot.json");
  const materialContext = {
    schemaVersion: 1,
    bookId: "synthetic",
    materials: [
      { id: "synthetic", title: "旧版人物", revision: 1, content: "冻结设定" },
    ],
  };
  await writeFile(snapshotPath, JSON.stringify({ materialContext }));
  const tools = new Map();
  let guard;
  apply(
    {
      tools: {
        register: (tool) => tools.set(tool.name, tool),
        guard: (fn) => {
          guard = fn;
        },
      },
    },
    {
      snapshotPath,
      proposalPath: join(root, "proposal.json"),
      materialContextEnabled: true,
    },
  );
  const exec = { signal: new AbortController().signal },
    tool = tools.get("novel_materials_read");
  assert.equal(guard({ name: "novel_materials_read" }), undefined);
  assert.equal(typeof guard({ name: "filesystem.read" }), "string");
  await assert.rejects(tool.execute({ bookId: "other" }, exec), /不接受/);
  await assert.rejects(tool.execute({ path: "private" }, exec), /不接受/);
  assert.deepEqual(
    JSON.parse((await tool.execute({}, exec)).context),
    materialContext,
  );
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, "utf8")), {
    materialContext,
  });
});

test("material-only context detects repeated stale source and same-revision dependency edits even when preview prose is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-context-proof-")),
    store = new NovelStore(root),
    book = await store.importBook("证据参考合成稿", [
      { title: "港口", body: "旧信有一道蓝印。" },
    ]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    related = await store.materials.save(book.id, input("相关人物"));
  let card = await store.materials.save(book.id, input("选择人物"));
  card = await store.materials.mutateEvidence(book.id, card, {
    action: "add",
    kind: "relation",
    scope: "world",
    statement: "曾交谈",
    storyTime: "抵港日",
    relatedIds: [related.id],
    source: {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 8,
    },
  });
  const sourcePath = join(root, book.id, "manuscript", `${chapter.id}.md`),
    targetPath = join(root, book.id, "materials", `${related.id}.json`);
  await writeFile(sourcePath, "一" + chapter.body);
  const first = await store.context.pack(book.id, [card.id]);
  await writeFile(sourcePath, "二" + chapter.body);
  const second = await store.context.pack(book.id, [card.id]);
  assert.equal(first.materials[0].content, second.materials[0].content);
  assert.notEqual(first.hash, second.hash);
  const target = JSON.parse(await readFile(targetPath, "utf8"));
  await writeFile(
    targetPath,
    JSON.stringify({ ...target, notes: "未发送的第一版依赖" }),
  );
  const third = await store.context.pack(book.id, [card.id]);
  await writeFile(
    targetPath,
    JSON.stringify({ ...target, notes: "未发送的第二版依赖" }),
  );
  const fourth = await store.context.pack(book.id, [card.id]);
  assert.equal(third.materials[0].content, fourth.materials[0].content);
  assert.notEqual(third.hash, fourth.hash);
  assert.doesNotMatch(JSON.stringify(fourth), /未发送的第/);
  assert.deepEqual(
    await store.materials.contextPack(book.id, [card.id]),
    fourth,
  );
});

test("invalid UTF-8 material cannot enter a context or be overwritten through a replacement-character decode", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-material-bytes-")),
    store = new NovelStore(root),
    book = await store.createBook("坏字节合成稿"),
    card = await store.materials.save(book.id, input("人物"));
  const file = join(root, book.id, "materials", `${card.id}.json`),
    raw = await readFile(file),
    at = raw.indexOf(Buffer.from("作者计划"));
  assert.ok(at > 0);
  const damaged = Buffer.concat([
    raw.subarray(0, at),
    Buffer.from([255]),
    raw.subarray(at + 1),
  ]);
  await writeFile(file, damaged);
  await assert.rejects(
    store.materials.contextPack(book.id, [card.id]),
    /utf-8/i,
  );
  await assert.rejects(
    store.materials.save(book.id, { ...card, notes: "不能覆盖" }, card),
    /utf-8/i,
  );
  assert.deepEqual(await readFile(file), damaged);
});
