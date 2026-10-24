import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-creation-")),
    store = new NovelStore(root),
    book = await store.importBook("创建重试合成稿", [
      { title: "来信", body: "旧信有一道蓝印。" },
    ]);
  const p = await store.materials.save(book.id, {
      kind: "proposition",
      title: "寄信人",
      fields: { claim: "船主寄信", truthIntent: "尚未确定" },
      status: "planned",
      notes: "",
      chapterIds: [],
    }),
    chapter = await store.readChapter(book.id, book.chapters[0].id),
    source = {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 8,
    },
    input = {
      propositionId: p.id,
      scope: "reader",
      characterId: null,
      state: "suspects",
      statement: "读者怀疑船主寄信。",
      storyTime: "抵港日",
    };
  return { root, store, book, p, chapter, source, input };
}
test("durable creation identity makes same-call retries and process restart read-only, without creating another record", async () => {
  const { root, store, book, source, input, chapter } = await setup(),
    creationId = randomUUID();
  assert.equal(await store.knowledge.creation(book.id, creationId), null);
  const [first, retry] = await Promise.all([
    store.knowledge.save(book.id, input, null, source, null, creationId),
    store.knowledge.save(book.id, input, null, source, null, creationId),
  ]);
  assert.equal(first.id, creationId);
  assert.equal(retry.id, first.id);
  assert.equal(retry.recoveredCreation, true);
  assert.equal(retry.revision, 1);
  const file = join(root, book.id, "knowledge/events", `${creationId}.json`),
    before = await readFile(file);
  const restarted = new NovelStore(root),
    again = await restarted.knowledge.save(
      book.id,
      input,
      null,
      source,
      null,
      creationId,
    );
  assert.equal(again.recoveredCreation, true);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await restarted.knowledge.list(book.id)).total, 1);
  await writeFile(
    join(root, book.id, "manuscript", `${chapter.id}.md`),
    "后来，" + chapter.body,
  );
  const stale = await restarted.knowledge.save(
    book.id,
    input,
    null,
    source,
    null,
    creationId,
  );
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(await readFile(file), before);
});
test("a conflicting draft or later author edit cannot be overwritten or silently cleared through a creation retry", async () => {
  const { root, store, book, source, input } = await setup(),
    creationId = randomUUID(),
    first = await store.knowledge.save(
      book.id,
      input,
      null,
      source,
      null,
      creationId,
    );
  await assert.rejects(
    store.knowledge.save(
      book.id,
      { ...input, state: "knows" },
      null,
      source,
      null,
      creationId,
    ),
    /已有保存记录/,
  );
  const second = await store.knowledge.save(
    book.id,
    { ...input, statement: "作者后续明确修订。" },
    first,
    source,
  );
  await assert.rejects(
    store.knowledge.save(book.id, input, null, source, null, creationId),
    /已有保存记录/,
  );
  assert.equal(
    (await store.knowledge.creation(book.id, creationId)).statement,
    second.statement,
  );
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  assert.throws(
    () =>
      store.knowledge.save(book.id, input, null, source, null, "../invalid"),
    /身份/,
  );
  const backup = await store.createBackup(
      book.id,
      await mkdtemp(join(tmpdir(), "novel-creation-backup-")),
    ),
    restored = await store.restoreBackup(backup.path);
  assert.equal(
    (await store.knowledge.creation(restored.id, creationId)).revision,
    2,
  );
});
test("legacy creation retries reuse the frozen provenance even when the old source has since changed", async () => {
  const { root, store, book, source, input } = await setup();
  let owner = await store.materials.save(book.id, {
    kind: "character",
    title: "林舟",
    fields: {},
    notes: "",
    status: "planned",
    chapterIds: [],
  });
  owner = await store.materials.mutateEvidence(book.id, owner, {
    action: "add",
    kind: "knowledge",
    scope: "character",
    statement: "旧记录仅说明见到蓝印。",
    storyTime: "抵港日",
    relatedIds: [],
    source,
  });
  const legacy = await store.knowledge.legacy.preview(
      book.id,
      owner.id,
      owner.evidence[0].id,
    ),
    creationId = randomUUID(),
    first = await store.knowledge.linkLegacy(
      book.id,
      input,
      legacy,
      source,
      creationId,
    ),
    origin = join(root, book.id, "knowledge/origins", `${first.id}.json`),
    before = await readFile(origin);
  await store.materials.save(
    book.id,
    { ...owner, notes: "旧资料后来有改动" },
    owner,
  );
  const replay = await store.knowledge.linkLegacy(
    book.id,
    input,
    legacy,
    source,
    creationId,
  );
  assert.equal(replay.recoveredCreation, true);
  assert.equal(replay.origin.ownerChanged, true);
  assert.deepEqual(await readFile(origin), before);
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  await assert.rejects(
    store.knowledge.linkLegacy(
      book.id,
      input,
      { ...legacy, eventHash: "0".repeat(64) },
      source,
      creationId,
    ),
    /已有保存记录/,
  );
  await unlink(join(root, book.id, "knowledge/events", `${creationId}.json`));
  const latestLegacy = await store.knowledge.legacy.preview(
    book.id,
    owner.id,
    legacy.eventId,
  );
  await assert.rejects(
    store.knowledge.linkLegacy(
      book.id,
      input,
      latestLegacy,
      source,
      creationId,
    ),
    /历史来源/,
  );
  assert.deepEqual(await readFile(origin), before);
});
