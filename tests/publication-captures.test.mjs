import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PublicationCaptures } from "../packages/novel-storage/publication-captures.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("capture jobs isolate window and book ownership and expose only snapshot identity on completion", async () => {
  let complete;
  const jobs = new PublicationCaptures({
    capture: async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const bookId = randomUUID(),
    job = jobs.start(1, bookId, {});
  assert.throws(() => jobs.status(2, bookId, job.id), /不属于/);
  assert.throws(() => jobs.cancel(1, randomUUID(), job.id), /不属于/);
  assert.throws(() => jobs.start(1, bookId, {}), /尚未完成/);
  const snapshotId = randomUUID(),
    hash = "a".repeat(64);
  complete({
    id: snapshotId,
    hash,
    content: { body: "AUTHOR_PRIVATE_SENTINEL" },
  });
  await tick();
  const receipt = jobs.status(1, bookId, job.id);
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.result, { id: snapshotId, hash });
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /AUTHOR_PRIVATE_SENTINEL|controller|signal/,
  );
  receipt.result.id = "caller mutation";
  assert.equal(jobs.status(1, bookId, job.id).result.id, snapshotId);
  assert.equal(jobs.cancel(1, bookId, job.id).cancelled, false);
});

test("cancel remains cancelling despite late progress, reaches cancelled and never returns a snapshot", async () => {
  let options, reject;
  const jobs = new PublicationCaptures({
    capture: async (_book, _input, captured) => {
      options = captured;
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    },
  });
  const bookId = randomUUID(),
    job = jobs.start(1, bookId, {});
  assert.equal(jobs.cancel(1, bookId, job.id).cancelled, true);
  assert.equal(options.signal.aborted, true);
  options.onProgress({ phase: "capturing", completed: 1, total: 2 });
  assert.equal(jobs.status(1, bookId, job.id).status, "cancelling");
  reject(options.signal.reason);
  await jobs.cancelAll();
  assert.equal(jobs.status(1, bookId, job.id).status, "cancelled");
  assert.equal(jobs.status(1, bookId, job.id).result, null);
  assert.equal(jobs.status(1, bookId, job.id).error, null);
});

test("committing cannot be cancelled; closing waits for it and refuses future work", async () => {
  let complete;
  const jobs = new PublicationCaptures({
    capture: async (_book, _input, options) => {
      options.onCommitting();
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const bookId = randomUUID(),
    job = jobs.start(1, bookId, {});
  assert.deepEqual(jobs.cancel(1, bookId, job.id), {
    cancelled: false,
    status: "committing",
  });
  let stopped = false;
  const stopping = jobs.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);
  assert.throws(() => jobs.start(1, randomUUID(), {}), /关闭/);
  complete({ id: randomUUID(), hash: "b".repeat(64) });
  await stopping;
  assert.equal(jobs.status(1, bookId, job.id).status, "completed");
});

test("capture concurrency is bounded and errors stay in the owning failed job", async () => {
  const jobs = new PublicationCaptures({
    capture: async (_book, _input, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      ),
  });
  jobs.start(1, randomUUID(), {});
  jobs.start(1, randomUUID(), {});
  assert.throws(() => jobs.start(1, randomUUID(), {}), /尚未完成/);
  await jobs.stop();
  const failed = new PublicationCaptures({
    capture: async () => {
      throw new Error("原稿已变化");
    },
  });
  const bookId = randomUUID(),
    job = failed.start(1, bookId, {});
  await tick();
  assert.equal(failed.status(1, bookId, job.id).status, "failed");
  assert.equal(failed.status(1, bookId, job.id).error, "原稿已变化");
  assert.throws(() => failed.status(2, bookId, job.id), /不属于/);
});
