import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { ImageJobService } from "../packages/novel-harness/image-jobs.mjs";
import { requestImageCandidates } from "../packages/novel-harness/image-provider.mjs";
import { validateImageTask } from "../packages/novel-domain/image-tasks.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = (value) => ({
  id: value.id,
  revision: value.revision,
  diskHash: value.diskHash,
});
const choice = { revision: 1, diskHash: "a".repeat(64) };
const assetInput = {
  title: "自行绘制参考",
  purpose: "reference",
  source: "合成",
  rights: "测试",
  notes: "原图不修改",
  linkedIds: [],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-reference-jobs-")),
    store = new NovelStore(root);
  const book = await store.importBook("参考编辑合成书", [
    { title: "原稿", body: "不得改写的原稿𠮷🙂" },
  ]);
  const original = await sharp({
    create: { width: 160, height: 240, channels: 3, background: "#396e83" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "PRIVATE_ORIGINAL_ARTIST" } } })
    .toBuffer();
  const asset = await store.assets.import(book.id, original, assetInput);
  const output = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "#305267" },
  })
    .png()
    .toBuffer();
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    calls.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks)),
      key: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: [{ b64_json: output.toString("base64") }] }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const profile = {
    id: randomUUID(),
    label: "独立参考编辑服务",
    protocol: "openai-images-edits",
    model: "synthetic-edit",
    runnable: true,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    imageOptions: { responseMode: "default-base64" },
    imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
  };
  const resolver = async (capability, requested, options) => {
    assert.equal(capability, "image");
    assert.deepEqual(requested, choice);
    return {
      profile: structuredClone(profile),
      ...choice,
      ...(options.secret ? { apiKey: "synthetic-reference-only-key" } : {}),
    };
  };
  const service = new ImageJobService(store.imageTasks, resolver);
  const input = {
    id: randomUUID(),
    request: {
      prompt: "根据确认的参考改为冬季衣装，保留人物轮廓。",
      n: 1,
      size: "1024x1536",
      responseMode: "default-base64",
    },
    target: { purpose: "cover", material: null, chapter: null },
    choice,
    reference: expected(asset),
  };
  return {
    root,
    store,
    book,
    original,
    asset,
    calls,
    profile,
    resolver,
    service,
    input,
    taskPath: join(root, book.id, ".zinovel/image-tasks", input.id + ".json"),
  };
}
test("a restarted reference task sends exact frozen metadata-free PNG once to the explicit edits route", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  assert.equal(prepared.schemaVersion, 3);
  assert.equal(prepared.status, "prepared");
  const preview = await f.store.imageTasks.referencePreview(
      f.book.id,
      prepared.id,
    ),
    png = Buffer.from(preview.dataUrl.split(",")[1], "base64");
  assert.equal(hash(png), prepared.reference.derivative.sha256);
  assert.equal(png.includes(Buffer.from("PRIVATE_ORIGINAL_ARTIST")), false);
  const originalPath = join(
    f.root,
    f.book.id,
    "assets/blobs",
    f.asset.blob.sha256 + ".jpeg",
  );
  assert.deepEqual(await readFile(originalPath), f.original);
  const next = new NovelStore(f.root),
    service = new ImageJobService(next.imageTasks, f.resolver);
  const result = await service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "received");
  assert.equal(result.task.schemaVersion, 3);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/v1/images/edits");
  assert.equal(f.calls[0].key, "Bearer synthetic-reference-only-key");
  assert.deepEqual(f.calls[0].body.images, [{ image_url: preview.dataUrl }]);
  assert.equal(f.calls[0].body.model, "synthetic-edit");
  assert.equal((await next.assets.list(f.book.id)).total, 1);
  const raw = await readFile(f.taskPath, "utf8");
  assert.doesNotMatch(
    raw,
    /synthetic-reference-only-key|PRIVATE_ORIGINAL_ARTIST|data:image|baseURL/,
  );
  validateImageTask(JSON.parse(raw), prepared.id, [f.book.id]);
  assert.deepEqual(await readFile(originalPath), f.original);
  assert.equal(
    (await next.readChapter(f.book.id, f.book.chapters[0].id)).body,
    "不得改写的原稿𠮷🙂",
  );
});
test("edit capability must be explicit and renderer paths cannot become references", async (t) => {
  const f = await fixture(t);
  const { reference, ...without } = f.input;
  await assert.rejects(f.service.prepare(f.book.id, without));
  f.profile.protocol = "openai-images";
  await assert.rejects(f.service.prepare(f.book.id, f.input));
  f.profile.protocol = "openai-images-edits";
  await assert.rejects(
    f.service.prepare(f.book.id, {
      ...f.input,
      reference: { ...reference, path: "C:/private.png" },
    }),
  );
  assert.equal((await f.store.imageTasks.list(f.book.id)).total, 0);
  assert.equal(f.calls.length, 0);
});
test("source changes immediately before dispatch refuse the intent without a network request", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  const service = new ImageJobService(f.store.imageTasks, f.resolver, {
    transport: async (config, options) => {
      await f.store.assets.save(
        f.book.id,
        { ...assetInput, notes: "作者已更换参考说明" },
        expected(f.asset),
      );
      return requestImageCandidates(config, options);
    },
  });
  const result = await service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "failed");
  assert.equal(result.task.outcome.dispatched, false);
  assert.equal(f.calls.length, 0);
  assert.equal(result.task.schemaVersion, 3);
});
test("a corrupted frozen derivative is preserved and never sent or silently regenerated", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    blob = prepared.reference.derivative;
  const path = join(f.root, f.book.id, "assets/blobs", blob.sha256 + ".png"),
    bad = Buffer.from(await readFile(path));
  bad[20] ^= 1;
  await writeFile(path, bad);
  const result = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(result.status, "failed");
  assert.equal(result.task.outcome.dispatched, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(path), bad);
});
test("a durable edit intent remains remote-unknown after restart and cannot be sent again", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  await f.store.imageTasks.markSending(f.book.id, expected(prepared));
  const next = new NovelStore(f.root),
    task = await next.imageTasks.read(f.book.id, prepared.id),
    service = new ImageJobService(next.imageTasks, f.resolver);
  assert.equal(task.status, "remote-unknown");
  await assert.rejects(service.start(f.book.id, expected(task), choice));
  assert.equal(f.calls.length, 0);
  const preview = await next.imageTasks.referencePreview(f.book.id, task.id);
  assert.equal(
    hash(Buffer.from(preview.dataUrl.split(",")[1], "base64")),
    task.reference.derivative.sha256,
  );
});
test("a paid reference response retries only local persistence while retaining the original reference", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input),
    receive = f.store.imageTasks.receive.bind(f.store.imageTasks);
  f.store.imageTasks.receive = async () => {
    throw Error("synthetic local save failure");
  };
  const pending = await f.service.start(f.book.id, expected(prepared), choice);
  assert.equal(pending.status, "local-save-pending");
  assert.equal(f.calls.length, 1);
  f.store.imageTasks.receive = receive;
  const saved = await f.service.retryLocalSave(f.book.id, prepared.id);
  assert.equal(saved.status, "received");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(saved.task.reference, prepared.reference);
});

test("a source metadata edit at send-intent commit survives the read-only dependency guard", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  const path = join(f.root, f.book.id, "assets/items", f.asset.id + ".json"),
    raw = await readFile(path, "utf8"),
    external = raw + "\n";
  const original = BookStorageKernel.prototype.transaction;
  let injected = false;
  BookStorageKernel.prototype.transaction = async function (
    root,
    changes,
    options,
  ) {
    const task = changes[`.zinovel/image-tasks/${prepared.id}.json`];
    if (!injected && task && JSON.parse(task).status === "send-intent") {
      injected = true;
      await writeFile(path, external);
    }
    return original.call(this, root, changes, options);
  };
  try {
    const result = await f.service.start(f.book.id, expected(prepared), choice);
    assert.equal(injected, true);
    assert.equal(result.task.outcome.dispatched, false);
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(path, "utf8"), external);
  } finally {
    BookStorageKernel.prototype.transaction = original;
  }
});

test("backup restore retains reference bytes and receipts but never resumes the original edit", async (t) => {
  const f = await fixture(t),
    prepared = await f.service.prepare(f.book.id, f.input);
  await f.service.start(f.book.id, expected(prepared), choice);
  const backupRoot = await mkdtemp(join(tmpdir(), "novel-reference-backup-"));
  const backup = await f.store.createBackup(f.book.id, backupRoot),
    restored = await f.store.restoreBackup(backup.path);
  const task = await f.store.imageTasks.read(restored.id, prepared.id);
  assert.equal(task.schemaVersion, 3);
  assert.equal(task.restoredSource, true);
  assert.deepEqual(task.reference, prepared.reference);
  const preview = await f.store.imageTasks.referencePreview(
    restored.id,
    prepared.id,
  );
  assert.equal(
    hash(Buffer.from(preview.dataUrl.split(",")[1], "base64")),
    prepared.reference.derivative.sha256,
  );
  const service = new ImageJobService(f.store.imageTasks, f.resolver);
  await assert.rejects(service.start(restored.id, expected(task), choice));
  assert.equal(f.calls.length, 1);
});

test("explicit current-target adoption retains schema3 reference and cannot downgrade to v2", async (t) => {
  const f = await fixture(t);
  const input = {
    title: "合成人物",
    kind: "character",
    status: "planned",
    fields: {},
    notes: "初始形象",
    chapterIds: [],
  };
  const character = await f.store.materials.save(f.book.id, input);
  f.input.target = {
    purpose: "portrait",
    material: expected(character),
    chapter: null,
  };
  const prepared = await f.service.prepare(f.book.id, f.input),
    received = await f.service.start(f.book.id, expected(prepared), choice);
  await f.store.materials.save(
    f.book.id,
    { ...input, notes: "作者更新了人物设定" },
    expected(character),
  );
  const compared = await f.store.imageTasks.compareTarget(
    f.book.id,
    expected(received.task),
    0,
  );
  const adopted = await f.store.imageTasks.adoptReviewed(
    f.book.id,
    expected(received.task),
    0,
    {
      ...assetInput,
      title: "经复评的衣装",
      purpose: "portrait",
      linkedIds: [character.id],
    },
    {
      target: compared.current,
      responseHash: received.task.responseHash,
      confirmation: "adopt-for-current-target-v1",
    },
  );
  assert.equal(adopted.task.schemaVersion, 3);
  assert.deepEqual(adopted.task.reference, prepared.reference);
  assert.equal(adopted.task.candidates[0].decision, "accepted");
  const persisted = JSON.parse(await readFile(f.taskPath, "utf8"));
  validateImageTask(persisted, adopted.task.id, [f.book.id]);
  const downgraded = structuredClone(persisted);
  downgraded.schemaVersion = 2;
  assert.throws(() =>
    validateImageTask(downgraded, downgraded.id, [f.book.id]),
  );
  assert.equal(f.calls.length, 1);
});
