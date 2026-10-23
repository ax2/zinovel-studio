import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mixed-context-")),
    store = new NovelStore(root),
    book = await store.importBook("认知上下文合成稿", [
      { title: "来信", body: "旧信有一道蓝印。" },
    ]);
  const make = (kind, title, fields = {}, notes = "") =>
    store.materials.save(book.id, {
      kind,
      title,
      fields,
      notes,
      status: "planned",
      chapterIds: [],
    });
  const p = await make(
      "proposition",
      "寄信人",
      { claim: "船主是寄信人", truthIntent: "作者设定为真" },
      "未选作者真相哨兵",
    ),
    person = await make("character", "林舟"),
    card = await make("idea", "明确选择的资料", {}, "已选择资料内容");
  await make("character", "另一个人物", { desire: "未选人物哨兵" });
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    source = {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 8,
    },
    input = {
      propositionId: p.id,
      scope: "character",
      characterId: person.id,
      state: "believes",
      statement: "林舟相信船主寄信，仍没有证实。",
      storyTime: "抵港日",
    },
    event = await store.knowledge.save(book.id, input, null, source);
  await store.knowledge.save(
    book.id,
    {
      ...input,
      scope: "reader",
      characterId: null,
      statement: "未选认知秘密哨兵",
    },
    null,
    source,
  );
  await store.knowledge.choices.select(book.id, event, null);
  return {
    root,
    store,
    book,
    p,
    person,
    card,
    chapter,
    source,
    input,
    event,
    eventRef: `knowledge:${event.id}`,
    choiceRef: `choice:${p.id}:character:${person.id}`,
  };
}
test("mixed snapshots expose only explicitly selected same-book material, knowledge and frozen author choice; old material-only contract stays exact", async () => {
  const { store, book, card, event, eventRef, choiceRef } = await setup();
  const pack = await store.context.pack(book.id, [
    card.id,
    eventRef,
    choiceRef,
  ]);
  assert.equal(pack.materials.length, 3);
  assert.equal(pack.materials[1].id, eventRef);
  assert.match(pack.materials[1].content, /相信/);
  assert.match(pack.materials[1].content, /人物：林舟/);
  assert.match(pack.materials[2].content, /作者明确选用的冻结事件/);
  for (const forbidden of [
    "未选作者真相哨兵",
    "未选人物哨兵",
    "未选认知秘密哨兵",
    "作者设定为真",
  ])
    assert.equal(JSON.stringify(pack).includes(forbidden), false);
  assert.equal(pack.materials[1].content.includes(event.anchor.quote), true);
  assert.deepEqual(
    await store.context.pack(book.id, [card.id]),
    await store.materials.contextPack(book.id, [card.id]),
  );
  const other = await store.createBook("他书");
  await assert.rejects(store.context.pack(other.id, [eventRef]));
});
test("source or definition changing again after it was already stale changes proof hash; choice never follows a later event statement", async () => {
  const {
    root,
    store,
    book,
    p,
    event,
    chapter,
    source,
    input,
    eventRef,
    choiceRef,
  } = await setup();
  const file = join(root, book.id, "manuscript", `${chapter.id}.md`);
  await writeFile(file, "后来，" + chapter.body);
  const a = await store.context.pack(book.id, [eventRef, choiceRef]);
  await writeFile(file, "又后来，" + chapter.body);
  const b = await store.context.pack(book.id, [eventRef, choiceRef]);
  assert.equal(a.materials[0].content, b.materials[0].content);
  assert.notEqual(a.hash, b.hash);
  await writeFile(file, chapter.body);
  let next = await store.materials.save(
    book.id,
    { ...p, fields: { ...p.fields, claim: "新定义秘密哨兵" } },
    p,
  );
  const c = await store.context.pack(book.id, [eventRef]);
  assert.equal(c.materials[0].content.includes("新定义秘密哨兵"), false);
  next = await store.materials.save(
    book.id,
    { ...next, notes: "第二次改定义笔记" },
    next,
  );
  assert.notEqual((await store.context.pack(book.id, [eventRef])).hash, c.hash);
  let revised = await store.knowledge.save(
    book.id,
    { ...input, statement: "作者后来改写了独立事件。" },
    event,
    source,
  );
  const d = await store.context.pack(book.id, [choiceRef]);
  assert.equal(d.materials[0].content.includes(input.statement), true);
  assert.equal(d.materials[0].content.includes(revised.statement), false);
  revised = await store.knowledge.save(
    book.id,
    { ...input, statement: "第二次修改当前事件。" },
    revised,
    source,
  );
  const e = await store.context.pack(book.id, [choiceRef]);
  assert.equal(e.materials[0].content, d.materials[0].content);
  assert.notEqual(e.hash, d.hash);
});
test("namespaced event identity cannot collide with a material ID; invalid references, overflow and unavailable records reject without writes", async () => {
  const { root, store, book, card, event, source, input, eventRef, choiceRef } =
    await setup();
  const collision = await store.knowledge.save(
      book.id,
      input,
      null,
      source,
      null,
      card.id,
    ),
    pack = await store.context.pack(book.id, [
      card.id,
      `knowledge:${collision.id}`,
    ]);
  assert.equal(new Set(pack.materials.map((item) => item.id)).size, 2);
  for (const invalid of [
    "../outside",
    "knowledge:../outside",
    `choice:${input.propositionId}:reader:${input.characterId}`,
    `knowledge:${event.id}:extra`,
  ])
    assert.throws(() => store.context.pack(book.id, [invalid]));
  assert.throws(
    () =>
      store.context.pack(
        book.id,
        Array.from({ length: 9 }, () => `knowledge:${randomUUID()}`),
      ),
    /最多8/,
  );
  const large = await store.materials.save(
    book.id,
    { ...card, notes: "很".repeat(21000) },
    card,
  );
  await assert.rejects(
    store.context.pack(book.id, [large.id, eventRef]),
    /2 万/,
  );
  const before = await readFile(
    join(root, book.id, "knowledge/events", `${event.id}.json`),
  );
  await store.knowledge.setRetired(book.id, event, true);
  await assert.rejects(store.context.pack(book.id, [eventRef]), /停用/);
  await store.knowledge.choices.clear(
    book.id,
    input,
    await store.knowledge.choices.read(book.id, input),
  );
  await assert.rejects(store.context.pack(book.id, [choiceRef]), /清除/);
  assert.ok(before.length);
});
test("choice options are lightweight and cleared choices disappear; knowledge options paginate deterministically without missing records", async () => {
  const { store, book, source, input, choiceRef } = await setup();
  for (let n = 0; n < 40; n++)
    await store.knowledge.save(
      book.id,
      { ...input, statement: `合成认知${n}` },
      null,
      source,
    );
  const first = await store.context.choices(book.id, {
      kind: "knowledge",
      offset: 0,
    }),
    last = await store.context.choices(book.id, {
      kind: "knowledge",
      offset: 40,
    });
  assert.equal(first.total, 42);
  assert.equal(first.items.length, 40);
  assert.equal(last.items.length, 2);
  assert.equal(
    new Set([...first.items, ...last.items].map((item) => item.id)).size,
    42,
  );
  const choices = await store.context.choices(book.id, { kind: "choice" });
  assert.equal(choices.items[0].id, choiceRef);
  assert.equal("snapshot" in choices.items[0], false);
  await store.knowledge.choices.clear(
    book.id,
    input,
    await store.knowledge.choices.read(book.id, input),
  );
  assert.equal(
    (await store.context.choices(book.id, { kind: "choice" })).total,
    0,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    store.context.choices(book.id, { kind: "knowledge" }, controller.signal),
    { name: "AbortError" },
  );
});

test("knowledge search includes text beyond the short option title; unreadable origin is rejected without repairing source bytes", async () => {
  const { root, store, book, source, input, event } = await setup();
  const long = await store.knowledge.save(
    book.id,
    { ...input, statement: "合成".repeat(100) + "深处检索词" },
    null,
    source,
  );
  const found = await store.context.choices(book.id, {
    kind: "knowledge",
    query: "深处检索词",
  });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, `knowledge:${long.id}`);
  const dir = join(root, book.id, "knowledge/origins");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${event.id}.json`),
    bytes = Buffer.from('{"schemaVersion":999}');
  await writeFile(file, bytes);
  await assert.rejects(
    store.context.pack(book.id, [`knowledge:${event.id}`]),
    /旧来源无法读取/,
  );
  assert.deepEqual(await readFile(file), bytes);
});
