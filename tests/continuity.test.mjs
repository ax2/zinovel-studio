import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-continuity-"));
  const store = new NovelStore(root);
  const book = await store.importBook("全书证据合成样本", [
    { title: "后来", body: "林舟看见蓝印，却隐瞒了来信。" },
    { title: "往事", body: "一年前，他已见过同样的蓝印。" },
  ]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id);
  const source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 7,
  };
  const card = (title, kind = "character") =>
    store.materials.save(book.id, {
      kind,
      title,
      status: "accepted",
      fields: {},
      notes: "作者计划",
      chapterIds: [],
    });
  const add = (owner, changes = {}) =>
    store.materials.mutateEvidence(book.id, owner, {
      action: "add",
      kind: "knowledge",
      statement: "蓝印来自旧船",
      storyTime: "一年前（倒叙）",
      scope: "world",
      relatedIds: [],
      source,
      ...changes,
    });
  return { root, store, book, chapter, source, card, add };
}

test("whole-book projection keeps distinct knowledge scopes, relationship identities and evidence provenance", async () => {
  const { root, store, book, card, add, chapter } = await setup();
  let a = await card("林舟"),
    secret = await card("蓝印秘密", "rule");
  for (const scope of ["world", "reader", "character"])
    a = await add(a, { scope, relatedIds: [secret.id] });
  a = await add(a, {
    kind: "relation",
    statement: "林舟隐瞒蓝印的来历",
    relatedIds: [secret.id],
  });
  const path = join(root, book.id, "materials", `${a.id}.json`);
  const before = await readFile(path);
  const all = await store.continuity.query(book.id);
  assert.equal(all.total, 4);
  assert.equal(new Set(all.items.map((row) => row.key)).size, 4);
  assert.deepEqual(all.counts, {
    current: 4,
    stale: 0,
    missing: 0,
    retired: 0,
    deleted: 0,
  });
  assert.equal(all.items[0].ownerHash, a.diskHash);
  assert.equal(all.items[0].chapterOrder, 1);
  assert.equal(all.items[0].storyTime, "一年前（倒叙）");
  assert.equal(all.items[0].anchor.quote, chapter.body.slice(0, 7));
  const known = await store.continuity.query(book.id, {
    kind: "knowledge",
    scope: "character",
    relatedId: secret.id,
  });
  assert.equal(known.total, 1);
  assert.equal(known.items[0].ownerId, a.id);
  const graph = await store.continuity.query(book.id, {
    kind: "relation",
    includeRelations: true,
    participantId: secret.id,
  });
  assert.equal(graph.relationships.totalEvents, 1);
  assert.equal(graph.relationships.events[0].ownerId, a.id);
  assert.equal(
    graph.relationships.nodes.find((node) => node.id === secret.id).kind,
    "rule",
  );
  const outgoing = await store.continuity.query(book.id, {
    kind: "relation",
    includeRelations: true,
    participantId: a.id,
  });
  assert.equal(
    outgoing.relationships.totalEvents,
    1,
    "participant filter includes source and target roles",
  );
  assert.equal(
    (await store.continuity.query(book.id, { query: "蓝印秘密" })).total,
    4,
  );
  assert.equal(
    (await store.continuity.query(book.id, { chapterId: book.chapters[1].id }))
      .total,
    0,
  );
  assert.deepEqual(
    await readFile(path),
    before,
    "query never rewrites source or assigns inferred facts",
  );
  const other = await store.createBook("隔离作品");
  assert.equal((await store.continuity.query(other.id)).total, 0);
});

test("stale, missing, retired and deleted evidence remains visible without changing source records", async () => {
  const { root, store, book, card, add, chapter } = await setup();
  let a = await add(await card("林舟"));
  let b = await add(await card("船主"));
  b = await store.materials.mutateEvidence(book.id, b, {
    action: "retire",
    eventId: b.evidence[0].id,
  });
  let c = await add(await card("旧人物"));
  c = await store.materials.setDeleted(book.id, c, true);
  const manuscript = join(root, book.id, "manuscript", `${chapter.id}.md`);
  await writeFile(manuscript, "后来：" + chapter.body);
  let result = await store.continuity.query(book.id);
  assert.equal(result.counts.stale, 1);
  assert.equal(result.counts.retired, 1);
  assert.equal(result.counts.deleted, 1);
  assert.equal(
    result.items.find((row) => row.ownerId === a.id).resolution.status,
    "relocated",
  );
  result = await store.continuity.query(book.id, { state: "stale" });
  assert.equal(result.total, 1);
  assert.equal(
    result.counts.retired,
    1,
    "state counts describe other current filters before state selection",
  );
  const file = join(root, book.id, "book.json"),
    manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.chapters[0].deletedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(manifest));
  result = await store.continuity.query(book.id, { state: "missing" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].chapterOrder, null);
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
});

test("bounded pages preserve all matching records, expose unreadable cards, and reject invalid filters", async () => {
  const { root, store, book, card, add } = await setup();
  const a = await add(await card("多事件人物"));
  const path = join(root, book.id, "materials", `${a.id}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.evidence = Array.from({ length: 83 }, (_, index) => ({
    ...raw.evidence[0],
    id: randomUUID(),
    statement: `事件 ${index}`,
  }));
  await writeFile(path, JSON.stringify(raw));
  const before = await readFile(path);
  const pages = [];
  for (const offset of [0, 40, 80])
    pages.push(await store.continuity.query(book.id, { offset }));
  assert.deepEqual(
    pages.map((page) => page.items.length),
    [40, 40, 3],
  );
  assert.ok(
    pages.every(
      (page) => page.total === 83 && page.consistency === "live-scan",
    ),
  );
  assert.equal(
    new Set(pages.flatMap((page) => page.items.map((row) => row.key))).size,
    83,
  );
  const broken = join(root, book.id, "materials", `${randomUUID()}.json`);
  await writeFile(broken, "{broken");
  assert.equal((await store.continuity.query(book.id)).errors.length, 1);
  assert.equal(await readFile(broken, "utf8"), "{broken");
  assert.deepEqual(await readFile(path), before);
  for (const options of [
    { offset: -1 },
    { offset: 1.5 },
    { ownerId: "../escape" },
    { relatedId: {} },
    { scope: "everyone" },
    { state: "invented" },
    { kind: "inferred" },
    { query: "a".repeat(201) },
  ])
    await assert.rejects(store.continuity.query(book.id, options), /筛选条件/);
});

test("a queued manuscript save runs between evidence cards and the next scan rechecks every source", async () => {
  const { store, book, chapter, card, add } = await setup();
  for (const title of ["甲", "乙", "丙"]) await add(await card(title));
  const view = store.materials.view.bind(store.materials);
  let visited = 0,
    saved;
  store.materials.view = async (...args) => {
    const result = await view(...args);
    if (++visited === 1)
      saved = store.saveChapter({
        bookId: book.id,
        chapterId: chapter.id,
        title: chapter.title,
        body: "新写的段落。" + chapter.body,
        expectedHash: chapter.diskHash,
        expectedRevision: chapter.revision,
      });
    return result;
  };
  const live = await store.continuity.query(book.id);
  assert.equal((await saved).status, "saved");
  assert.equal(live.counts.current, 1);
  assert.equal(
    live.counts.stale,
    2,
    "save was not postponed until the end of the scan",
  );
  store.materials.view = view;
  const refreshed = await store.continuity.query(book.id);
  assert.equal(refreshed.counts.stale, 3);
  assert.equal(refreshed.consistency, "live-scan");
});
