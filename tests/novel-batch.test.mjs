import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelBatch } from "../packages/novel-harness/novel-batch.mjs";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  batchInput,
  batchPlan,
  batchFingerprint,
} from "../packages/novel-domain/novel-batch.mjs";
import {
  inspiration,
  batchSettings,
  generatedStage,
} from "./fixtures/novel-batch.mjs";
async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zinovel-batch-")),
    store = new NovelStore(join(root, "library")),
    tasks = new Map(),
    calls = [];
  await store.initialize();
  const dependencies = {
    root: join(root, "batches"),
    generate: async (request) => {
      calls.push(request);
      if (options.generate) return options.generate(request, tasks);
      const text = JSON.stringify(
        generatedStage(request.bookIndex, request.stage),
      );
      tasks.set(request.requestId, {
        record: { status: "awaiting-review", candidate: text },
      });
      return { id: request.requestId, text };
    },
    readTask: async (id) => {
      if (!tasks.has(id)) throw new Error("missing");
      return tasks.get(id);
    },
    cancel: async () => options.cancel?.(),
    commit: async (output, receipt) => {
      if (options.commit) await options.commit(output, receipt);
      return store.importBook(
        output.title,
        output.chapters,
        undefined,
        output.documents,
        receipt,
      );
    },
  };
  return {
    root,
    store,
    tasks,
    calls,
    dependencies,
    batch: new NovelBatch(dependencies),
  };
}
test("two inspiration-driven novels receive all assets, every planned volume and exact trial chapter count; completed jobs cannot duplicate books", async () => {
  const { batch, store, calls, root } = await setup();
  const created = await batch.create(inspiration, batchSettings);
  await batch.run(created.id);
  await batch.whenIdle();
  const result = await batch.read(created.id);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 12);
  assert.equal(result.reservedOutputTokens, 12 * 2048);
  const books = (await store.listBooks()).books;
  assert.equal(books.length, 2);
  for (const book of books) {
    assert.equal(book.chapters.length, 2);
    assert.equal(book.volumes.length, 2);
    assert.equal(book.targetWords, 80000);
    const docs = (await store.project.list(book.id)).documents;
    assert.equal(docs.length, 17);
    assert.ok(docs.every((d) => d.origin === "generated"));
    assert.ok(
      docs.some((d) => d.path === "outline/volume-02-chapters-detail.md"),
    );
    assert.match(
      (
        await store.project.read(
          book.id,
          docs.find((d) => d.path === "README.md").id,
        )
      ).text,
      /预期字数不等于已完成正文/,
    );
    const receipt = JSON.parse(
      await readFile(
        join(store.root, book.id, ".zinovel/generated-origin.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.batchId, created.id);
    assert.equal(
      receipt.contentHash,
      result.books.find((b) => b.id === book.id).commitHash,
    );
  }
  await assert.rejects(batch.run(created.id), /已经完成/);
  assert.equal((await store.listBooks()).books.length, 2);
  const ledger = await readFile(
    join(root, "batches", created.id, "job.json"),
    "utf8",
  );
  assert.equal(ledger.includes("apiKey"), false);
});
test("one malformed novel preserves its complete peers and retry reuses all completed stages without re-requesting them", async () => {
  let first = true;
  const { batch, calls, store } = await setup({
    generate: async (r, tasks) => {
      const bad = r.bookIndex === 0 && r.stage === "chapter-2" && first;
      if (bad) first = false;
      const text = bad
        ? '{"truncated":'
        : JSON.stringify(generatedStage(r.bookIndex, r.stage));
      tasks.set(r.requestId, {
        record: { status: "awaiting-review", candidate: text },
      });
      return { id: r.requestId, text };
    },
  });
  const job = await batch.create(inspiration, batchSettings);
  await batch.run(job.id);
  await batch.whenIdle();
  assert.equal((await batch.read(job.id)).status, "partial");
  assert.equal((await store.listBooks()).books.length, 1);
  const before = calls.length;
  await batch.run(job.id);
  await batch.whenIdle();
  assert.equal((await batch.read(job.id)).status, "completed");
  assert.equal(calls.length - before, 2);
  assert.equal((await store.listBooks()).books.length, 2);
});
test("request and reserved-output caps stop before a paid callback, retain completed planning and never fabricate a partial book", async () => {
  const { batch, calls, store } = await setup();
  const job = await batch.create(
    { ...inspiration, novelCount: 1, requestLimit: 1 },
    batchSettings,
  );
  await batch.run(job.id);
  await batch.whenIdle();
  const result = await batch.read(job.id);
  assert.equal(calls.length, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.books[0].errorCode, "budget-limit");
  assert.equal((await store.listBooks()).books.length, 0);
  const limited = await batch.create(
    { ...inspiration, novelCount: 1, outputTokenLimit: 64 },
    batchSettings,
  );
  await batch.run(limited.id);
  await batch.whenIdle();
  assert.equal((await batch.read(limited.id)).requestCount, 0);
  assert.equal(calls.length, 1);
});
test("unknown remote results require explicit paid retry acknowledgement and never auto-run on restart", async () => {
  let fail = true;
  const { batch, dependencies, calls } = await setup({
    generate: async (r) => {
      if (fail) {
        fail = false;
        throw new Error("SECRET_RESPONSE_BODY_DO_NOT_LOG");
      }
      return {
        id: r.requestId,
        text: JSON.stringify(generatedStage(r.bookIndex, r.stage)),
      };
    },
  });
  const job = await batch.create(
    { ...inspiration, novelCount: 1 },
    batchSettings,
  );
  await batch.run(job.id);
  await batch.whenIdle();
  assert.equal((await batch.read(job.id)).attempts[0].status, "remote-unknown");
  const restarted = new NovelBatch(dependencies);
  await restarted.initialize();
  assert.equal(calls.length, 1);
  await assert.rejects(restarted.run(job.id), /远端结果未知/);
  assert.equal(calls.length, 1);
  assert.equal(
    JSON.stringify(await restarted.read(job.id)).includes(
      "SECRET_RESPONSE_BODY",
    ),
    false,
  );
  await restarted.run(job.id, { acknowledgeUnknown: true });
  await restarted.whenIdle();
  assert.equal((await restarted.read(job.id)).status, "completed");
});
test("restart reconciles a complete upstream candidate from its fixed request identity, keeps other stages stopped until explicit resume", async () => {
  const { batch, dependencies, tasks, calls, root } = await setup();
  const job = await batch.create(
    { ...inspiration, novelCount: 1 },
    batchSettings,
  );
  const id = randomUUID(),
    prompt = {},
    recordPath = join(root, "batches", job.id, "job.json"),
    record = JSON.parse(await readFile(recordPath, "utf8"));
  record.status = "running";
  record.reservedOutputTokens = 2048;
  record.attempts.push({
    id,
    bookIndex: 0,
    stage: "plan",
    status: "running",
    inputHash: batchFingerprint(prompt),
  });
  await writeFile(recordPath, JSON.stringify(record));
  tasks.set(id, {
    record: {
      status: "awaiting-review",
      candidate: JSON.stringify(generatedStage(0, "plan")),
    },
  });
  const restarted = new NovelBatch(dependencies);
  await restarted.initialize();
  assert.equal(calls.length, 0);
  assert.equal((await restarted.read(job.id)).status, "paused");
  assert.equal((await restarted.read(job.id)).attempts[0].status, "returned");
  await restarted.run(job.id);
  await restarted.whenIdle();
  assert.equal((await restarted.read(job.id)).status, "completed");
  assert.equal(calls.length, 5);
});
test("a crash after canonical commit reuses the exact receipt and preserves later author edits rather than duplicating or replacing a book", async () => {
  const { batch, store, root } = await setup();
  const job = await batch.create(
    { ...inspiration, novelCount: 1, trialChapters: 1 },
    batchSettings,
  );
  await batch.run(job.id);
  await batch.whenIdle();
  let result = await batch.read(job.id);
  assert.equal(result.status, "completed");
  const book = (await store.listBooks()).books[0];
  assert.equal(book.volumes.length, 2);
  const chapter = await store.readChapter(book.id, book.chapters[0].id);
  // External author edits are allowed after the completed canonical creation.
  const manuscript = join(
    store.root,
    book.id,
    "manuscript",
    `${chapter.id}.md`,
  );
  await writeFile(manuscript, chapter.body + "作者后续修改");
  const recordPath = join(root, "batches", job.id, "job.json"),
    record = JSON.parse(await readFile(recordPath, "utf8"));
  record.status = "paused";
  record.books[0].status = "pending";
  await writeFile(recordPath, JSON.stringify(record));
  await batch.run(job.id);
  await batch.whenIdle();
  result = await batch.read(job.id);
  assert.equal(result.status, "completed");
  assert.equal((await store.listBooks()).books.length, 1);
  assert.match(
    (await store.readChapter(book.id, chapter.id)).body,
    /作者后续修改$/,
  );
});
test("contracts reject missing assets, template stand-ins, wrong trial count, duplicate names and bad budget parameters", () => {
  const input = batchInput(inspiration),
    plan = generatedStage(0, "plan");
  assert.throws(() => batchInput({ ...inspiration, novelCount: 0 }));
  assert.throws(() => batchInput({ ...inspiration, targetWords: "10000" }));
  assert.throws(
    () => batchPlan({ ...plan, documents: plan.documents.slice(1) }, input),
    /缺少/,
  );
  assert.throws(
    () =>
      batchPlan(
        {
          ...plan,
          documents: plan.documents.map((d) => ({
            ...d,
            text: "待填写的创作模板",
          })),
        },
        input,
      ),
    /模板/,
  );
  assert.throws(() => batchPlan(plan, input, [plan.title]), /重复/);
});
