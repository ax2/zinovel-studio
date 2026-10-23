import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
const input = (kind) => ({
  kind,
  title: kind,
  status: "accepted",
  notes: "计划",
  fields: {},
  chapterIds: [],
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-evidence-")),
    store = new NovelStore(root),
    book = await store.importBook("证据小说", [
      { title: "港口", body: "旧信有一道蓝印。\n林舟没有拆信。🌊" },
    ]),
    chapter = await store.readChapter(book.id, book.chapters[0].id);
  const source = {
    chapterId: chapter.id,
    body: chapter.body,
    hash: chapter.diskHash,
    start: 0,
    end: 8,
  };
  return { root, store, book, chapter, source };
}
const event = (source) => ({
  action: "add",
  kind: "plant",
  statement: "蓝印为之后辨认发信人的线索",
  storyTime: "抵港日",
  scope: "reader",
  relatedIds: [],
  source,
});
test("evidence preserves exact source, invalidates after text changes, and requires explicit current-range reconfirmation", async () => {
  const { root, store, book, chapter, source } = await setup();
  let card = await store.materials.save(book.id, input("foreshadow"));
  card = await store.materials.mutateEvidence(book.id, card, event(source));
  const evidence = card.evidence[0];
  assert.equal(evidence.anchor.quote, chapter.body.slice(0, 8));
  assert.equal(evidence.freshness, "current");
  const file = join(root, book.id, "manuscript", `${chapter.id}.md`);
  await writeFile(file, "后来：" + chapter.body);
  card = await store.materials.read(book.id, card.id);
  assert.equal(card.evidence[0].freshness, "stale");
  assert.equal(card.evidence[0].resolution.status, "relocated");
  assert.equal(card.evidence[0].anchor.quote, evidence.anchor.quote);
  await assert.rejects(
    store.materials.mutateEvidence(book.id, card, event(source)),
    /正文已改变/,
  );
  const current = await store.readChapter(book.id, chapter.id);
  card = await store.materials.mutateEvidence(book.id, card, {
    action: "reconfirm",
    eventId: evidence.id,
    source: {
      chapterId: chapter.id,
      body: current.body,
      hash: current.diskHash,
      start: 3,
      end: 11,
    },
  });
  assert.equal(card.evidence[0].id, evidence.id);
  assert.equal(card.evidence[0].freshness, "current");
  assert.equal(
    (await store.materials.history(book.id, card.id))[0].evidence[0].anchor
      .hash,
    chapter.diskHash,
  );
  card = await store.materials.save(
    book.id,
    { ...card, notes: "修改计划，不替换证据", evidence: [] },
    card,
  );
  assert.equal(card.evidence.length, 1);
  card = await store.materials.mutateEvidence(book.id, card, {
    action: "retire",
    eventId: evidence.id,
  });
  assert.equal(card.evidence[0].status, "retired");
  assert.equal(await readFile(file, "utf8"), "后来：" + chapter.body);
});
test("relationship and knowledge events retain separate times/scopes and stable target identity", async () => {
  const { root, store, book, source } = await setup();
  let a = await store.materials.save(book.id, input("character")),
    b = await store.materials.save(book.id, {
      ...input("character"),
      title: "船主",
    });
  a = await store.materials.mutateEvidence(book.id, a, {
    ...event(source),
    kind: "relation",
    statement: "林舟怀疑船主",
    scope: "character",
    storyTime: "抵港日",
    relatedIds: [b.id],
  });
  a = await store.materials.mutateEvidence(book.id, a, {
    ...event(source),
    kind: "knowledge",
    statement: "读者看到蓝印，尚不知道发信人",
    scope: "reader",
    storyTime: "回忆中",
    relatedIds: [],
  });
  b = await store.materials.save(book.id, { ...b, title: "船主顾远" }, b);
  a = await store.materials.read(book.id, a.id);
  assert.equal(a.evidence[0].related[0].title, "船主顾远");
  assert.equal(a.evidence[0].scope, "character");
  assert.equal(a.evidence[1].scope, "reader");
  await store.materials.setDeleted(book.id, b, true);
  a = await store.materials.read(book.id, a.id);
  assert.equal(a.evidence[0].related[0].state, "deleted");
  await assert.rejects(
    store.materials.mutateEvidence(book.id, a, {
      ...event(source),
      kind: "relation",
      relatedIds: [randomUUID()],
    }),
  );
  await assert.rejects(
    store.materials.mutateEvidence(book.id, a, {
      ...event(source),
      kind: "fact",
      source: { ...source, body: source.body + "未保存" },
    }),
    /正文已改变/,
  );
  const backup = await store.createBackup(
      book.id,
      join(root, "..", `evidence-backup-${randomUUID()}`),
    ),
    restored = await store.restoreBackup(backup.path);
  const restoredCard = await store.materials.read(restored.id, a.id);
  assert.equal(restoredCard.evidence[1].freshness, "current");
  assert.equal(restoredCard.evidence[1].chapterId, source.chapterId);
});
test("empty and split-Unicode anchors, foreign chapters and stale material bases cannot add evidence", async () => {
  const { store, book, source } = await setup();
  let card = await store.materials.save(book.id, input("foreshadow"));
  for (const invalid of [
    { ...source, end: 0 },
    { ...source, start: source.body.length - 1, end: source.body.length },
    { ...source, chapterId: randomUUID() },
  ])
    await assert.rejects(
      store.materials.mutateEvidence(book.id, card, event(invalid)),
    );
  const old = card;
  card = await store.materials.save(
    book.id,
    { ...card, notes: "新计划" },
    card,
  );
  await assert.rejects(
    store.materials.mutateEvidence(book.id, old, event(source)),
    /资料已改变/,
  );
  card = await store.materials.mutateEvidence(book.id, card, event(source));
  const body = "引文已删除。";
  await store.saveChapter({
    bookId: book.id,
    chapterId: source.chapterId,
    title: "港口",
    body,
    expectedRevision: 1,
    expectedHash: digest(source.body),
  });
  card = await store.materials.read(book.id, card.id);
  assert.equal(card.evidence[0].freshness, "stale");
  assert.equal(card.evidence[0].resolution.status, "missing");
});
test("linked definitions invalidate evidence without rewriting it; explicit reconfirm records current dependencies and legacy references stay unverified", async () => {
  const { root, store, book, source } = await setup();
  let owner = await store.materials.save(book.id, input("character"));
  let target = await store.materials.save(book.id, {
    ...input("character"),
    title: "顾远",
  });
  owner = await store.materials.mutateEvidence(book.id, owner, {
    ...event(source),
    kind: "relation",
    relatedIds: [target.id],
  });
  const path = join(root, book.id, "materials", `${owner.id}.json`);
  const before = await readFile(path, "utf8");
  const context = await store.materials.contextPack(book.id, [owner.id]);
  target = await store.materials.mutateEvidence(book.id, target, {
    ...event(source),
    kind: "fact",
    relatedIds: [],
  });
  owner = await store.materials.read(book.id, owner.id);
  assert.equal(
    owner.evidence[0].freshness,
    "current",
    "evidence-only changes do not invalidate a definition dependency",
  );
  target = await store.materials.save(
    book.id,
    { ...target, fields: { desire: "隐瞒来历" } },
    target,
  );
  owner = await store.materials.read(book.id, owner.id);
  assert.equal(owner.evidence[0].freshness, "stale");
  assert.equal(owner.evidence[0].sourceFreshness, "current");
  assert.equal(owner.evidence[0].related[0].baselineRevision, 1);
  assert.equal(owner.evidence[0].related[0].revision, 3);
  assert.equal(
    await readFile(path, "utf8"),
    before,
    "checking does not rewrite the source evidence",
  );
  assert.notEqual(
    (await store.materials.contextPack(book.id, [owner.id])).hash,
    context.hash,
  );
  owner = await store.materials.mutateEvidence(book.id, owner, {
    action: "reconfirm",
    eventId: owner.evidence[0].id,
    source,
  });
  assert.equal(owner.evidence[0].freshness, "current");
  assert.equal(owner.evidence[0].related[0].baselineRevision, 3);
  assert.equal(
    (await store.materials.history(book.id, owner.id))[0].evidence[0]
      .dependencies[0].revision,
    1,
  );
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.evidence[0].dependencies;
  await writeFile(path, JSON.stringify(legacy));
  owner = await store.materials.read(book.id, owner.id);
  assert.equal(owner.evidence[0].freshness, "stale");
  assert.equal(owner.evidence[0].related[0].freshness, "unknown");
  legacy.evidence[0].dependencies = [
    { id: target.id, revision: 0, definitionHash: "invalid" },
  ];
  await writeFile(path, JSON.stringify(legacy));
  await assert.rejects(store.materials.read(book.id, owner.id), /关联版本无效/);
});
