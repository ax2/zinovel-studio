import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { ContinuityQueries } from "../packages/novel-storage/continuity-queries.mjs";

test("superseding a query aborts its backend, while old cleanup cannot cancel the next request or another view", async () => {
  const calls = [];
  const queries = new ContinuityQueries({
    query: (_book, options, signal) =>
      new Promise((resolve, reject) => {
        const call = { options, signal, resolve, reject };
        calls.push(call);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const sessionId = randomUUID(),
    otherSession = randomUUID();
  const first = queries.query(
    "book",
    { query: "甲" },
    { sessionId, requestId: 1 },
  );
  const firstResult = assert.rejects(first, { name: "AbortError" });
  const second = queries.query(
    "book",
    { query: "甲乙" },
    { sessionId, requestId: 2 },
  );
  await firstResult;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(queries.cancel({ sessionId, requestId: 1 }), false);
  assert.equal(
    queries.cancel({ sessionId: otherSession, requestId: 2 }),
    false,
  );
  assert.equal(calls[1].signal.aborted, false);
  calls[1].resolve({ items: ["最新查询"] });
  assert.deepEqual(await second, { items: ["最新查询"] });
  assert.equal(queries.cancel({ sessionId, requestId: 2 }), false);
  for (const token of [
    { sessionId: "../invalid", requestId: 1 },
    { sessionId, requestId: 0 },
    { sessionId, requestId: 1.5 },
  ])
    assert.throws(() => queries.cancel(token), /身份/);
});

test("desktop shutdown aborts a running query and a completed stale promise never clears the current request", async () => {
  const calls = [];
  const queries = new ContinuityQueries({
    query: (_book, _options, signal) =>
      new Promise((resolve) => calls.push({ resolve, signal })),
  });
  const sessionId = randomUUID();
  const first = queries.query("book", {}, { sessionId, requestId: 1 });
  const second = queries.query("book", {}, { sessionId, requestId: 2 });
  calls[0].resolve({ stale: true });
  await first;
  assert.equal(
    queries.cancel({ sessionId, requestId: 2 }),
    true,
    "old finally must not forget the live controller",
  );
  assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve({});
  await second;
  const third = queries.query("book", {});
  queries.cancelAll();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve({});
  await third;
});

test("aborting a real scan stops between cards, preserves source bytes and leaves the shared write queue usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-query-cancel-")),
    store = new NovelStore(root);
  const book = await store.importBook("取消合成样本", [
    { title: "原文", body: "甲收到一封信。" },
  ]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    path = join(root, book.id, "manuscript", `${chapter.id}.md`);
  for (let index = 0; index < 12; index++) {
    let card = await store.materials.save(book.id, {
      kind: "character",
      title: `人物${index}`,
      fields: {},
      notes: "",
      chapterIds: [],
      status: "accepted",
    });
    await store.materials.mutateEvidence(book.id, card, {
      action: "add",
      kind: "state",
      scope: "world",
      statement: "人物抵港",
      storyTime: "第一日",
      relatedIds: [],
      source: {
        chapterId: chapter.id,
        body: chapter.body,
        hash: chapter.diskHash,
        start: 0,
        end: 4,
      },
    });
  }
  const controller = new AbortController(),
    view = store.materials.view.bind(store.materials);
  let visited = 0;
  store.materials.view = async (...args) => {
    const result = await view(...args);
    if (++visited === 1) controller.abort();
    return result;
  };
  await assert.rejects(store.continuity.query(book.id, {}, controller.signal), {
    name: "AbortError",
  });
  assert.equal(visited, 1);
  assert.equal(await readFile(path, "utf8"), chapter.body);
  store.materials.view = view;
  const saved = await store.saveChapter({
    bookId: book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: chapter.body + "保存仍可执行。",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  assert.equal(saved.status, "saved");
  const fresh = await store.continuity.query(book.id);
  assert.equal(fresh.total, 12);
  assert.equal(fresh.counts.stale, 12);
  const before = new AbortController();
  before.abort();
  await assert.rejects(store.continuity.query(book.id, {}, before.signal), {
    name: "AbortError",
  });
});
