import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-choice-")),
    store = new NovelStore(root),
    book = await store.importBook("作者选择合成稿", [
      { title: "来信", body: "林舟怀疑船主就是发信人。🌊" },
      { title: "后来", body: "他否认了旧猜测。" },
    ]);
  const make = (kind, title) =>
    store.materials.save(book.id, {
      kind,
      title,
      fields:
        kind === "proposition"
          ? { claim: "船主是发信人", truthIntent: "尚未确定" }
          : {},
      notes: "",
      chapterIds: [],
      status: "planned",
    });
  const proposition = await make("proposition", "寄信人"),
    person = await make("character", "林舟"),
    chapter = await store.readChapter(book.id, book.chapters[0].id),
    source = {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 8,
    },
    input = {
      propositionId: proposition.id,
      scope: "character",
      characterId: person.id,
      state: "suspects",
      statement: "林舟怀疑船主写信。",
      storyTime: "抵港日",
    };
  const event = await store.knowledge.save(book.id, input, null, source);
  return {
    root,
    store,
    book,
    proposition,
    person,
    chapter,
    source,
    input,
    event,
    choices: store.knowledge.choices,
  };
}
test("author choice freezes exact event, never follows latest edits, retains conflicting records and requires its own CAS", async () => {
  const { store, choices, book, event, input, source, chapter } = await setup();
  assert.equal(await choices.read(book.id, input), null);
  const first = await choices.select(book.id, event, null, "本章采用怀疑状态");
  assert.equal(first.freshness, "current");
  assert.equal(first.snapshot.state, "suspects");
  const contrary = await store.knowledge.save(
    book.id,
    { ...input, state: "unaware", statement: "另一段记录明确说林舟不知此事。" },
    null,
    source,
  );
  let matrix = await store.knowledge.matrix(book.id, {
    characterIds: [input.characterId],
  });
  assert.equal(matrix.rows[0].cells[input.characterId].total, 2);
  assert.equal(
    matrix.rows[0].cells[input.characterId].choice.selected.id,
    event.id,
  );
  await assert.rejects(choices.select(book.id, contrary, null), /选择已改变/);
  const second = await choices.select(
    book.id,
    contrary,
    first,
    "作者明确改选不知",
  );
  assert.equal(second.revision, 2);
  assert.equal(second.snapshot.state, "unaware");
  await assert.rejects(choices.clear(book.id, input, first), /选择已改变/);
  const history = await choices.history(book.id, input);
  assert.equal(history.items[0].snapshot.statement, event.statement);
  const cleared = await choices.clear(book.id, input, second);
  assert.equal(cleared.status, "cleared");
  assert.equal(cleared.freshness, "cleared");
  assert.equal((await store.knowledge.list(book.id)).total, 2);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
  const narrative = await store.knowledge.matrix(book.id, {
    characterIds: [input.characterId],
    upToChapterId: chapter.id,
  });
  assert.equal(narrative.rows[0].cells[input.characterId].choice, undefined);
});
test("source, event and definition changes expire a choice while its original statement and quote remain readable", async () => {
  const { root, store, choices, book, event, chapter, source, input, person } =
    await setup();
  let choice = await choices.select(book.id, event, null);
  const file = join(root, book.id, "manuscript", `${chapter.id}.md`);
  await writeFile(file, "后来，" + chapter.body);
  assert.equal((await choices.read(book.id, input)).freshness, "stale");
  await assert.rejects(choices.select(book.id, event, choice), /重新绑定/);
  const current = await store.readChapter(book.id, chapter.id),
    rebound = await store.knowledge.save(book.id, input, event, {
      ...source,
      body: current.body,
      hash: current.diskHash,
      start: 3,
      end: source.end + 3,
    });
  let read = await choices.read(book.id, input);
  assert.equal(read.freshness, "stale");
  assert.equal(read.snapshot.revision, 1);
  assert.equal(read.snapshot.anchor.quote, event.anchor.quote);
  choice = await choices.select(book.id, rebound, choice);
  assert.equal(choice.freshness, "current");
  await store.materials.save(
    book.id,
    { ...person, notes: "作者明确调整人物" },
    person,
  );
  assert.equal((await choices.read(book.id, input)).freshness, "stale");
  const cleared = await choices.clear(book.id, input, choice);
  assert.equal(cleared.status, "cleared");
});
test("external same-revision edits and future fields reject without overwriting a decision; backup keeps its frozen identity", async () => {
  const { root, store, choices, book, event, input } = await setup();
  const choice = await choices.select(book.id, event, null),
    key = `${input.propositionId}.${input.scope}.${input.characterId}`,
    file = join(root, book.id, "knowledge/choices", `${key}.json`),
    raw = await readFile(file, "utf8");
  await writeFile(file, raw + " ");
  await assert.rejects(choices.clear(book.id, input, choice), /选择已改变/);
  const external = await choices.read(book.id, input);
  const backup = await store.createBackup(
    book.id,
    await mkdtemp(join(tmpdir(), "novel-choice-backup-")),
  );
  const restored = await store.restoreBackup(backup.path);
  const copied = await store.knowledge.choices.read(restored.id, input);
  assert.equal(copied.id, choice.id);
  assert.equal(copied.freshness, "current");
  const data = JSON.parse(raw);
  data.futureField = "preserve";
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(choices.read(book.id, input), /不支持/);
  await assert.rejects(choices.select(book.id, event, external), /不支持/);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).futureField,
    "preserve",
  );
  assert.equal(
    (
      await store.knowledge.matrix(book.id, {
        characterIds: [input.characterId],
      })
    ).errors.length,
    1,
  );
});
test("interrupted decision and preimage history roll forward together through the shared book kernel", async () => {
  const { root, store, choices, book, event, input, chapter } = await setup();
  const choice = await choices.select(book.id, event, null),
    key = `${input.propositionId}.${input.scope}.${input.characterId}`,
    path = `knowledge/choices/${key}.json`,
    raw = await readFile(join(root, book.id, path), "utf8"),
    data = JSON.parse(raw),
    after = JSON.stringify({ ...data, revision: 2, status: "cleared" }),
    history = `.zinovel/knowledge-choice-history/${choice.id}/1-${choice.diskHash}.json`;
  await mkdir(join(root, book.id, ".zinovel"), { recursive: true });
  await writeFile(
    join(root, book.id, ".zinovel/pending.json"),
    JSON.stringify({
      id: randomUUID(),
      at: new Date().toISOString(),
      entries: [
        { path, before: raw, after },
        { path: history, before: null, after: raw },
      ],
    }),
  );
  await writeFile(join(root, book.id, path), after);
  const restarted = new NovelStore(root),
    read = await restarted.knowledge.choices.read(book.id, input);
  assert.equal(read.status, "cleared");
  assert.equal(
    (await restarted.knowledge.choices.history(book.id, input)).items[0]
      .snapshot.id,
    event.id,
  );
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
});
