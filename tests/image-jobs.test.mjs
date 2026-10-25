import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { ImageJobService } from "../packages/novel-harness/image-jobs.mjs";

const bytes = await sharp({
  create: { width: 80, height: 48, channels: 4, background: "#38687a" },
})
  .png()
  .toBuffer();
const expected = (value) => ({
  id: value.id,
  revision: value.revision,
  diskHash: value.diskHash,
});
const choice = { revision: 1, diskHash: "a".repeat(64) };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "zinovel-image-jobs-")),
    store = new NovelStore(root),
    book = await store.importBook("服务合成书", [
      { title: "原稿", body: "不得改动的合成原稿𠮷。" },
    ]);
  const observations = [],
    server = createServer(async (request, response) => {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      observations.push({
        key: request.headers.authorization,
        body: JSON.parse(Buffer.concat(body).toString("utf8")),
      });
      if (handler) return handler(request, response);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }),
      );
    });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const profile = {
    id: randomUUID(),
    label: "图像专用",
    protocol: "openai-images",
    model: "synthetic-image",
    runnable: true,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
    imageOptions: { responseMode: "default-base64" },
  };
  let resolver = async (capability, supplied, options) => {
    assert.equal(capability, "image");
    assert.deepEqual(supplied, choice);
    return {
      profile: structuredClone(profile),
      ...choice,
      ...(options.secret ? { apiKey: "synthetic-image-only-key" } : {}),
    };
  };
  const service = new ImageJobService(store.imageTasks, (...args) =>
    resolver(...args),
  );
  const input = {
    id: randomUUID(),
    request: {
      prompt: "自行绘制的港口合成测试",
      n: 1,
      size: "1024x1024",
      responseMode: "default-base64",
    },
    target: { purpose: "cover", material: null, chapter: null },
    choice,
  };
  return {
    root,
    store,
    book,
    profile,
    service,
    input,
    observations,
    setResolver(value) {
      resolver = value;
    },
    path: join(root, book.id, ".zinovel/image-tasks", input.id + ".json"),
  };
}

test("image coordinator freezes only host-resolved image identity, sends once, saves candidates without adoption and exposes no key", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    before = await readFile(
      join(f.root, f.book.id, "manuscript", f.book.chapters[0].id + ".md"),
    ),
    result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "received");
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].key, "Bearer synthetic-image-only-key");
  assert.equal(result.task.profile.id, f.profile.id);
  assert.equal(result.task.profile.protocol, "openai-images");
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
  assert.equal(f.service.status(), null);
  assert.equal(await f.service.whenIdle(), true);
  assert.doesNotMatch(
    await readFile(f.path, "utf8"),
    /synthetic-image-only-key|baseURL|127\.0\.0\.1/,
  );
  assert.deepEqual(
    await readFile(
      join(f.root, f.book.id, "manuscript", f.book.chapters[0].id + ".md"),
    ),
    before,
  );
});

test("unconfirmed adapters, mismatched mode and renderer-supplied credential fields refuse before creating any task", async (t) => {
  const f = await fixture(t);
  f.profile.runnable = false;
  await assert.rejects(f.service.prepare(f.book.id, f.input), /尚未明确确认/);
  f.profile.runnable = true;
  await assert.rejects(
    f.service.prepare(f.book.id, {
      ...f.input,
      request: { ...f.input.request, responseMode: "request-base64" },
    }),
    /尚未明确确认/,
  );
  await assert.rejects(
    f.service.prepare(f.book.id, { ...f.input, apiKey: "synthetic-forged" }),
    /字段无效/,
  );
  assert.equal((await f.store.imageTasks.list(f.book.id)).total, 0);
  assert.equal(f.observations.length, 0);
});

test("a stale model or raw codec error never uses a fallback or exposes private errors and releases the global slot", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    before = await readFile(f.path);
  await assert.rejects(
    f.service.start(f.book.id, expected(prepared), { ...choice, revision: 2 }),
    /未发送请求/,
  );
  f.setResolver(async () => {
    throw new Error("synthetic-private-key-and-codec-error");
  });
  await assert.rejects(
    f.service.start(f.book.id, expected(prepared), choice),
    (error) =>
      !error.message.includes("synthetic-private") &&
      error.message.includes("未发送请求"),
  );
  assert.equal(f.service.status(), null);
  assert.equal(f.observations.length, 0);
  assert.deepEqual(await readFile(f.path), before);
});

test("cancellation while awaiting host model resolution records a not-sent cancellation with zero HTTP requests", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    entered = deferred(),
    release = deferred();
  f.setResolver(async (_capability, _choice, options) => {
    if (options.secret) {
      entered.resolve();
      await release.promise;
    }
    return {
      profile: f.profile,
      ...choice,
      apiKey: "synthetic-image-only-key",
    };
  });
  const pending = f.service.start(f.book.id, expected(prepared), choice);
  await entered.promise;
  f.service.cancel(f.book.id, prepared.id);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.task.outcome.dispatched, false);
  assert.equal(f.observations.length, 0);
});

test("only one global request is allowed; cancelling after actual HTTP receipt records unknown and never retries", async (t) => {
  const entered = deferred(),
    f = await fixture(t, () => entered.resolve()),
    prepared = await f.service.prepare(f.book.id, f.input),
    pending = f.service.start(f.book.id, expected(prepared), choice);
  await entered.promise;
  const onDisk = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(onDisk.status, "send-intent");
  await assert.rejects(
    f.service.start(f.book.id, expected(prepared), choice),
    /当前图像任务/,
  );
  f.service.cancel(f.book.id, prepared.id);
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.task.outcome.dispatched, true);
  assert.equal(f.observations.length, 1);
  await assert.rejects(
    f.service.start(f.book.id, expected(result.task), choice),
    /未发送请求/,
  );
  assert.equal(f.observations.length, 1);
});

test("a paid response whose blob save fails keeps one response in memory, reports unsafe shutdown, blocks new requests and retries only local storage", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    original = f.store.assets.putBlob.bind(f.store.assets);
  f.store.assets.putBlob = async () => {
    throw new Error("synthetic disk-full with private path");
  };
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "local-save-pending");
  assert.equal(f.service.status().localResponseRetained, true);
  assert.equal(await f.service.whenIdle(), false);
  assert.doesNotMatch(JSON.stringify(result), /private path/);
  assert.equal(
    (await f.store.imageTasks.read(f.book.id, prepared.id)).status,
    "received-pending-check",
  );
  await assert.rejects(
    f.service.start(f.book.id, expected(prepared), choice),
    /当前图像任务/,
  );
  assert.throws(() => f.service.cancel(f.book.id, prepared.id), /不能丢弃/);
  f.store.assets.putBlob = original;
  const saved = await f.service.retryLocalSave(f.book.id, prepared.id);
  assert.equal(saved.status, "received");
  assert.equal(f.observations.length, 1);
  assert.equal(await f.service.whenIdle(), true);
});

test("retained unsaved candidates are released only after explicit, version-checked durable discard, keeping the known response receipt", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  f.store.assets.putBlob = async () => {
    throw new Error("synthetic disk capacity");
  };
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "local-save-pending");
  const task = await f.store.imageTasks.read(f.book.id, prepared.id);
  await assert.rejects(
    f.service.discardRetained(f.book.id, expected(task), false),
    /明确确认/,
  );
  assert.equal(f.service.status().localResponseRetained, true);
  await assert.rejects(
    f.service.discardRetained(
      f.book.id,
      expected(prepared),
      "discard-unsaved-images",
    ),
    /已改变/,
  );
  const discarded = await f.service.discardRetained(
    f.book.id,
    expected(task),
    "discard-unsaved-images",
  );
  assert.equal(discarded.status, "discarded");
  assert.equal(discarded.task.responseHash, task.responseHash);
  assert.equal(discarded.task.dispatchState, "response-received");
  assert.equal(f.service.status(), null);
  assert.equal(f.observations.length, 1);
});

test("successful receive commit without a receipt reconciles the exact retained response locally", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    original = f.store.imageTasks.receive.bind(f.store.imageTasks);
  f.store.imageTasks.receive = async (...args) => {
    await original(...args);
    throw new Error("synthetic lost receipt");
  };
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "local-save-pending");
  assert.equal(
    (await f.store.imageTasks.read(f.book.id, prepared.id)).status,
    "received",
  );
  const saved = await f.service.retryLocalSave(f.book.id, prepared.id);
  assert.equal(saved.status, "received");
  assert.equal(f.observations.length, 1);
});

test("an HTTP rejection whose outcome write fails is retained and retries only the durable outcome", async (t) => {
  const f = await fixture(t, (_request, response) => {
      response.writeHead(429);
      response.end("synthetic private rejection");
    }),
    prepared = await f.service.prepare(f.book.id, f.input),
    original = f.store.imageTasks.finishFailure.bind(f.store.imageTasks);
  f.store.imageTasks.finishFailure = async () => {
    throw new Error("synthetic private disk failure");
  };
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "outcome-save-pending");
  assert.equal(await f.service.whenIdle(), false);
  f.store.imageTasks.finishFailure = original;
  const saved = await f.service.retryLocalSave(f.book.id, prepared.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.task.outcome.remoteResult, "rejected");
  assert.equal(saved.task.outcome.code, "HTTP");
  assert.equal(f.observations.length, 1);
});

test("a durable send-intent commit with a missing receipt still records the actual transport not-sent fact", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    kernel = f.store.assets.storage,
    original = kernel.transaction.bind(kernel);
  let failed = false;
  kernel.transaction = async (...args) => {
    await original(...args);
    if (!failed) {
      failed = true;
      throw new Error("synthetic send intent receipt lost");
    }
  };
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "failed");
  assert.ok(result.task.attemptId);
  assert.equal(result.task.outcome.dispatched, false);
  assert.equal(result.task.outcome.remoteResult, "not-sent");
  assert.equal(result.task.outcome.code, "INTENT");
  assert.equal(f.observations.length, 0);
});
