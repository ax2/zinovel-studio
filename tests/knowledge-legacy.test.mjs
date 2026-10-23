import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-legacy-")),
    store = new NovelStore(root),
    book = await store.importBook("旧认知合成稿", [
      { title: "蓝印", body: "旧信有一道蓝印。\n林舟怀疑船主就是发信人。🌊" },
    ]);
  const make = (kind, title) =>
    store.materials.save(book.id, {
      kind,
      title,
      status: "planned",
      fields:
        kind === "proposition"
          ? { claim: "船主寄来了信", truthIntent: "尚未确定" }
          : {},
      notes: "",
      chapterIds: [],
    });
  let person = await make("character", "林舟");
  const proposition = await make("proposition", "寄信人"),
    chapter = await store.readChapter(book.id, book.chapters[0].id),
    source = {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 8,
    };
  person = await store.materials.mutateEvidence(book.id, person, {
    action: "add",
    kind: "knowledge",
    scope: "character",
    statement: "林舟看见蓝印，还不知道寄信人。",
    storyTime: "抵港日",
    relatedIds: [],
    source,
  });
  const preview = await store.knowledge.legacy.preview(
      book.id,
      person.id,
      person.evidence[0].id,
    ),
    input = {
      propositionId: proposition.id,
      scope: "character",
      characterId: person.id,
      state: "suspects",
      statement: "林舟怀疑船主寄信，尚未证实。",
      storyTime: "抵港日",
    };
  return {
    root,
    store,
    book,
    person,
    proposition,
    chapter,
    source,
    preview,
    input,
  };
}
test("explicit legacy linking freezes old event without rewriting it; unrelated old notes are distinct from changed evidence", async () => {
  const { root, store, book, person, chapter, source, preview, input } =
      await setup(),
    oldFile = join(root, book.id, "materials", `${person.id}.json`),
    oldBytes = await readFile(oldFile);
  const target = { ...input, scope: "reader", characterId: null };
  let event = await store.knowledge.linkLegacy(
    book.id,
    target,
    preview,
    source,
  );
  assert.deepEqual(await readFile(oldFile), oldBytes);
  assert.equal(event.origin.status, "unchanged");
  assert.equal(event.origin.source.event.statement, preview.event.statement);
  assert.equal(event.origin.targetChanged, false);
  assert.equal(event.state, "suspects");
  const choice = await store.knowledge.choices.select(book.id, event, null);
  const changed = await store.materials.save(
    book.id,
    { ...person, notes: "只改作者笔记" },
    person,
  );
  event = await store.knowledge.read(book.id, event.id);
  assert.equal(event.origin.status, "unchanged");
  assert.equal(event.origin.ownerChanged, true);
  assert.equal(event.freshness, "current");
  assert.equal(
    (await store.knowledge.choices.read(book.id, target)).freshness,
    "current",
  );
  await store.materials.mutateEvidence(book.id, changed, {
    action: "retire",
    eventId: preview.eventId,
  });
  event = await store.knowledge.read(book.id, event.id);
  assert.equal(event.origin.status, "changed");
  assert.equal(event.origin.source.event.status, "active");
  assert.equal(event.freshness, "current");
  const backup = await store.createBackup(book.id, join(root, "backup")),
    restored = await store.restoreBackup(backup.path),
    copied = await store.knowledge.read(restored.id, event.id);
  assert.equal(copied.origin.source.eventId, preview.eventId);
  assert.equal(copied.origin.status, "changed");
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  assert.equal(choice.selected.id, event.id);
});
test("stale, external, missing and invalid-byte old sources cannot create a link; no source is silently refreshed", async () => {
  const { root, store, book, person, source, preview, input } = await setup(),
    file = join(root, book.id, "materials", `${person.id}.json`),
    raw = await readFile(file, "utf8");
  await writeFile(file, raw + " ");
  await assert.rejects(
    store.knowledge.linkLegacy(book.id, input, preview, source),
    /旧资料已改变/,
  );
  assert.equal((await store.knowledge.list(book.id)).total, 0);
  assert.throws(
    () => store.knowledge.linkLegacy(book.id, input, null, source),
    /明确选择/,
  );
  const latest = await store.knowledge.legacy.preview(
    book.id,
    person.id,
    preview.eventId,
  );
  await assert.rejects(
    store.knowledge.linkLegacy(
      book.id,
      input,
      { ...latest, eventHash: "0".repeat(64) },
      source,
    ),
    /旧认知已改变/,
  );
  await assert.rejects(
    store.knowledge.linkLegacy(book.id, input, latest, {
      ...source,
      dirty: true,
    }),
    /保存/,
  );
  const bytes = Buffer.from(raw),
    index = bytes.findIndex((value) => value >= 128);
  bytes[index] = 255;
  await writeFile(file, bytes);
  await assert.rejects(
    store.knowledge.linkLegacy(book.id, input, latest, source),
  );
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await store.knowledge.list(book.id)).total, 0);
});
test("rebinding a linked event keeps provenance bytes and discloses the changed target; unsupported provenance remains visible as an error", async () => {
  const { root, store, book, source, preview, input } = await setup();
  let event = await store.knowledge.linkLegacy(book.id, input, preview, source);
  const file = join(root, book.id, "knowledge/origins", `${event.id}.json`),
    before = await readFile(file);
  event = await store.knowledge.save(
    book.id,
    { ...input, statement: "作者明确修订新认知说明" },
    event,
    source,
  );
  assert.equal(event.origin.targetChanged, true);
  assert.deepEqual(await readFile(file), before);
  const data = JSON.parse(before);
  data.futureField = "preserve";
  await writeFile(file, JSON.stringify(data));
  const viewed = await store.knowledge.read(book.id, event.id);
  assert.equal(viewed.origin.status, "unreadable");
  assert.equal((await store.knowledge.list(book.id)).errors.length, 1);
  assert.equal(viewed.freshness, "current");
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).futureField,
    "preserve",
  );
});
test("event and frozen provenance roll forward atomically after interrupted creation; old source and manuscript are untouched", async () => {
  const { root, store, book, person, chapter, source, preview, input } =
    await setup();
  const event = await store.knowledge.linkLegacy(
      book.id,
      input,
      preview,
      source,
    ),
    eventPath = `knowledge/events/${event.id}.json`,
    originPath = `knowledge/origins/${event.id}.json`,
    eventRaw = await readFile(join(root, book.id, eventPath), "utf8"),
    originRaw = await readFile(join(root, book.id, originPath), "utf8"),
    oldFile = join(root, book.id, "materials", `${person.id}.json`),
    oldBytes = await readFile(oldFile);
  await unlink(join(root, book.id, originPath));
  await writeFile(
    join(root, book.id, ".zinovel/pending.json"),
    JSON.stringify({
      id: randomUUID(),
      at: new Date().toISOString(),
      entries: [
        { path: eventPath, before: null, after: eventRaw },
        { path: originPath, before: null, after: originRaw },
      ],
    }),
  );
  const restarted = new NovelStore(root),
    read = await restarted.knowledge.read(book.id, event.id);
  assert.equal(read.origin.status, "unchanged");
  assert.equal(
    await readFile(join(root, book.id, originPath), "utf8"),
    originRaw,
  );
  assert.deepEqual(await readFile(oldFile), oldBytes);
  assert.equal(
    (await restarted.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
});
test("legacy listing paginates without changing bytes, keeps retired records visible and can cancel between storage batches", async () => {
  const { root, store, book, person, source } = await setup();
  let owner = person;
  for (let n = 0; n < 41; n++)
    owner = await store.materials.mutateEvidence(book.id, owner, {
      action: "add",
      kind: "knowledge",
      scope: "reader",
      statement: `第${n}份合成旧认知`,
      storyTime: "",
      relatedIds: [],
      source,
    });
  owner = await store.materials.mutateEvidence(book.id, owner, {
    action: "retire",
    eventId: owner.evidence[0].id,
  });
  const file = join(root, book.id, "materials", `${person.id}.json`),
    before = await readFile(file);
  const first = await store.knowledge.legacy.list(book.id, {
      query: "第",
      offset: 0,
    }),
    last = await store.knowledge.legacy.list(book.id, {
      query: "第",
      offset: 40,
    });
  assert.equal(first.total, 41);
  assert.equal(first.items.length, 40);
  assert.equal(last.items.length, 1);
  assert.equal(
    new Set([...first.items, ...last.items].map((item) => item.event.id)).size,
    41,
  );
  const unfilteredFirst = await store.knowledge.legacy.list(book.id),
    unfilteredLast = await store.knowledge.legacy.list(book.id, { offset: 40 });
  assert.equal(unfilteredFirst.total, 42);
  assert.equal(unfilteredLast.items.length, 2);
  assert.equal(
    [...unfilteredFirst.items, ...unfilteredLast.items].find(
      (item) => item.event.id === owner.evidence[0].id,
    )?.event.status,
    "retired",
  );
  await assert.rejects(
    store.knowledge.legacy.preview(book.id, person.id, owner.evidence[0].id),
    /启用/,
  );
  const controller = new AbortController(),
    original = store.materials.record.bind(store.materials);
  let count = 0;
  store.materials.record = async (...args) => {
    const result = await original(...args);
    if (++count === 1)
      controller.abort(new DOMException("取消旧认知读取", "AbortError"));
    return result;
  };
  await assert.rejects(
    store.knowledge.legacy.list(book.id, {}, controller.signal),
    { name: "AbortError" },
  );
  store.materials.record = original;
  assert.deepEqual(await readFile(file), before);
  assert.equal(
    (await store.materials.read(book.id, person.id)).revision,
    owner.revision,
  );
});
