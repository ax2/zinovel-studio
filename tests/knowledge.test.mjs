import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { materialProposal } from "../packages/novel-domain/material-proposal.mjs";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-knowledge-")),
    store = new NovelStore(root);
  const book = await store.importBook("认知合成作品", [
    { title: "旧信", body: "𠮷收到顾远的来信。\n读者看见蓝印。" },
    { title: "回忆", body: "一年前，他以为船已经离港。" },
  ]);
  const create = (kind, title) =>
    store.materials.save(book.id, {
      kind,
      title,
      status: "accepted",
      notes: "计划",
      chapterIds: [],
      fields:
        kind === "proposition"
          ? { claim: "船主就是发信人", truthIntent: "作者设定为真" }
          : {},
    });
  const p = await create("proposition", "发信人身份"),
    other = await create("proposition", "另一封信的发信人"),
    person = await create("character", "林舟");
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    source = {
      chapterId: chapter.id,
      body: chapter.body,
      hash: chapter.diskHash,
      start: 0,
      end: 10,
    };
  const input = {
    propositionId: p.id,
    scope: "reader",
    characterId: null,
    state: "knows",
    statement: "读者认出了发信人的笔迹",
    storyTime: "离港日",
  };
  return { root, store, book, p, other, person, chapter, source, input };
}
test("stable propositions keep distinct worlds, readers and characters; missing cells never mean unaware", async () => {
  const { store, book, p, other, person, source, input } = await setup();
  await store.knowledge.save(
    book.id,
    { ...input, scope: "world", state: "recorded" },
    null,
    source,
  );
  await store.knowledge.save(book.id, input, null, source);
  await store.knowledge.save(
    book.id,
    {
      ...input,
      scope: "character",
      characterId: person.id,
      state: "suspects",
      statement: "林舟怀疑船主就是发信人",
    },
    null,
    source,
  );
  await store.knowledge.save(
    book.id,
    {
      ...input,
      scope: "character",
      characterId: person.id,
      state: "unaware",
      statement: "他明确不知道另一封信的身份",
      propositionId: other.id,
    },
    null,
    source,
  );
  const matrix = await store.knowledge.matrix(book.id, {
    characterIds: [person.id],
  });
  assert.equal(matrix.rows.length, 2);
  const a = matrix.rows.find((row) => row.id === p.id),
    b = matrix.rows.find((row) => row.id === other.id);
  assert.equal(a.cells.world.events[0].state, "recorded");
  assert.equal(a.cells.reader.events[0].state, "knows");
  assert.equal(a.cells[person.id].events[0].state, "suspects");
  assert.equal(b.cells.reader.total, 0);
  assert.equal(b.cells[person.id].events[0].state, "unaware");
  const later = await store.readChapter(book.id, book.chapters[1].id);
  await store.knowledge.save(
    book.id,
    { ...input, state: "believes", statement: "回忆中读者得到另一种说法" },
    null,
    {
      chapterId: later.id,
      body: later.body,
      hash: later.diskHash,
      start: 0,
      end: 8,
    },
  );
  assert.equal(
    (
      await store.knowledge.matrix(book.id, { upToChapterId: source.chapterId })
    ).rows.find((row) => row.id === p.id).cells.reader.total,
    1,
  );
  assert.equal(
    (await store.knowledge.matrix(book.id)).rows.find((row) => row.id === p.id)
      .cells.reader.total,
    2,
    "opposite records are not resolved by edit time or free-text story dates",
  );
});
test("external edits and definition changes become stale; explicit rebind, retirement and backup retain history", async () => {
  const { root, store, book, p, source, input, chapter } = await setup();
  let event = await store.knowledge.save(book.id, input, null, source);
  const eventFile = join(root, book.id, "knowledge/events", `${event.id}.json`),
    before = await readFile(eventFile, "utf8");
  await writeFile(eventFile, before + "\n");
  await assert.rejects(
    store.knowledge.save(book.id, input, event, source),
    /已被其他操作/,
  );
  event = await store.knowledge.read(book.id, event.id);
  await store.materials.save(
    book.id,
    { ...p, fields: { ...p.fields, claim: "另一个发信人" } },
    p,
  );
  const raw = await readFile(eventFile);
  event = await store.knowledge.read(book.id, event.id);
  assert.equal(event.freshness, "stale");
  assert.deepEqual(await readFile(eventFile), raw);
  const manuscript = join(root, book.id, "manuscript", `${chapter.id}.md`);
  await writeFile(manuscript, "后来：" + chapter.body);
  event = await store.knowledge.read(book.id, event.id);
  assert.equal(event.resolution.status, "relocated");
  const current = await store.readChapter(book.id, chapter.id);
  event = await store.knowledge.save(book.id, input, event, {
    ...source,
    body: current.body,
    hash: current.diskHash,
    start: 3,
    end: 13,
  });
  assert.equal(event.freshness, "current");
  event = await store.knowledge.setRetired(book.id, event, true);
  assert.equal(
    (await store.knowledge.matrix(book.id)).rows.find((row) => row.id === p.id)
      .cells.reader.total,
    0,
  );
  assert.equal(
    (await store.knowledge.matrix(book.id, { includeRetired: true })).rows.find(
      (row) => row.id === p.id,
    ).cells.reader.events[0].status,
    "retired",
  );
  const backup = await store.createBackup(
    book.id,
    await mkdtemp(join(tmpdir(), "knowledge-backup-")),
  );
  const restored = await store.restoreBackup(backup.path);
  assert.equal(
    (await store.knowledge.read(restored.id || restored.book.id, event.id))
      .status,
    "retired",
  );
  assert.equal(await readFile(manuscript, "utf8"), "后来：" + chapter.body);
});
test("invalid or cross-book evidence is rejected and corrupt/future records remain preserved", async () => {
  const { root, store, book, p, person, source, input } = await setup();
  const foreign = await store.createBook("另一书");
  await assert.rejects(store.knowledge.save(foreign.id, input, null, source));
  await assert.rejects(
    store.knowledge.save(
      book.id,
      { ...input, propositionId: person.id },
      null,
      source,
    ),
    /命题/,
  );
  await assert.rejects(
    store.knowledge.save(book.id, input, null, { ...source, dirty: true }),
    /保存/,
  );
  await assert.rejects(
    store.knowledge.save(book.id, input, null, { ...source, start: 1 }),
    /Unicode/,
  );
  assert.throws(
    () =>
      store.knowledge.save(
        book.id,
        { ...input, statement: "\ud800" },
        null,
        source,
      ),
    /无效/,
  );
  let event = await store.knowledge.save(book.id, input, null, source);
  const file = join(root, book.id, "knowledge/events", `${event.id}.json`),
    data = JSON.parse(await readFile(file, "utf8"));
  data.futureField = "preserve";
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(store.knowledge.read(book.id, event.id), /不支持/);
  assert.equal((await store.knowledge.list(book.id)).errors.length, 1);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).futureField,
    "preserve",
  );
  assert.throws(
    () =>
      materialProposal(
        {
          title: p.title,
          notes: p.notes,
          fields: { ...p.fields, truthIntent: "作者设定为假" },
        },
        p,
      ),
    /作者真相/,
  );
});
test("shared transaction roll-forward restores event and prior revision without touching manuscript", async () => {
  const { root, store, book, source, input, chapter } = await setup();
  const event = await store.knowledge.save(book.id, input, null, source),
    path = `knowledge/events/${event.id}.json`;
  const raw = await readFile(join(root, book.id, path), "utf8"),
    after = JSON.stringify({
      ...JSON.parse(raw),
      revision: 2,
      state: "suspects",
    });
  const history = `.zinovel/knowledge-history/${event.id}/interrupted.json`;
  const pending = {
    id: randomUUID(),
    at: new Date().toISOString(),
    entries: [
      { path, before: raw, after },
      { path: history, before: null, after: raw },
    ],
  };
  await mkdir(join(root, book.id, ".zinovel"), { recursive: true });
  await writeFile(
    join(root, book.id, ".zinovel/pending.json"),
    JSON.stringify(pending),
  );
  await writeFile(join(root, book.id, path), after);
  const recovered = await new NovelStore(root).knowledge.read(
    book.id,
    event.id,
  );
  assert.equal(recovered.state, "suspects");
  assert.equal(recovered.revision, 2);
  assert.equal(await readFile(join(root, book.id, history), "utf8"), raw);
  assert.equal(
    (await store.readChapter(book.id, chapter.id)).body,
    chapter.body,
  );
});
test("matrix scan cancellation yields to writes and preserves original knowledge files", async () => {
  const { store, book, input, source, root } = await setup();
  const event = await store.knowledge.save(book.id, input, null, source);
  const file = join(root, book.id, "knowledge/events", `${event.id}.json`),
    before = await readFile(file, "utf8");
  const controller = new AbortController();
  let calls = 0;
  const original = store.knowledge.view.bind(store.knowledge);
  store.knowledge.view = async (...args) => {
    calls++;
    const result = await original(...args);
    controller.abort(new DOMException("矩阵查询已取消", "AbortError"));
    return result;
  };
  await assert.rejects(store.knowledge.matrix(book.id, {}, controller.signal), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
  assert.equal(await readFile(file, "utf8"), before);
  store.knowledge.view = original;
  assert.equal((await store.knowledge.list(book.id)).total, 1);
  const saved = await store.knowledge.setRetired(book.id, event, true);
  assert.equal(saved.status, "retired");
  const history = await store.knowledge.history(book.id, event.id);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].status, "active");
});
test("invalid UTF-8 in an event is refused before CAS writes rather than decoded into replacement characters", async () => {
  const { root, store, book, input, source } = await setup();
  const event = await store.knowledge.save(book.id, input, null, source),
    file = join(root, book.id, "knowledge/events", `${event.id}.json`),
    bytes = await readFile(file);
  const index = bytes.findIndex((value) => value >= 128);
  assert.ok(index >= 0);
  bytes[index] = 255;
  await writeFile(file, bytes);
  await assert.rejects(store.knowledge.read(book.id, event.id), {
    code: "ERR_ENCODING_INVALID_ENCODED_DATA",
  });
  await assert.rejects(store.knowledge.save(book.id, input, event, source), {
    code: "ERR_ENCODING_INVALID_ENCODED_DATA",
  });
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await store.knowledge.list(book.id)).errors.length, 1);
});
