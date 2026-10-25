import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";
import { ImageTaskStore } from "../packages/novel-storage/image-tasks.mjs";
import { requestImageCandidates } from "../packages/novel-harness/image-provider.mjs";

const picture = await sharp({
  create: { width: 80, height: 48, channels: 4, background: "#286b8b" },
})
  .png()
  .toBuffer();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = (value) => ({
  id: value.id,
  revision: value.revision,
  diskHash: value.diskHash,
});
async function fixture() {
  const work = await mkdtemp(join(tmpdir(), "zinovel-image-ledger-")),
    root = join(work, "library"),
    store = new NovelStore(root);
  const book = await store.importBook("图像账本合成书", [
    { title: "旧港", body: "合成原稿𠮷🌊。" },
  ]);
  const input = {
    id: randomUUID(),
    request: {
      prompt: "合成封面，蓝色旧港。",
      n: 1,
      size: "1024x1024",
      responseMode: "default-base64",
    },
    budget: { maxImages: 2, maxCost: 0, pricing: null },
    profile: {
      id: randomUUID(),
      label: "独立图像服务",
      model: "synthetic-image",
      protocol: "openai-images",
      revision: 1,
      diskHash: "a".repeat(64),
    },
    target: { purpose: "cover", material: null, chapter: null },
  };
  return {
    work,
    root,
    store,
    book,
    input,
    path: join(root, book.id, ".zinovel/image-tasks", input.id + ".json"),
  };
}
const returned = () => ({
  candidates: [
    {
      bytes: Buffer.from(picture),
      revisedPrompt: "合成返回提示，不是工具指令。",
    },
  ],
  usage: null,
  interruptedAfterResponse: false,
});
async function received(f) {
  const created = await f.store.imageTasks.create(f.book.id, f.input),
    sent = await f.store.imageTasks.markSending(f.book.id, expected(created));
  return f.store.imageTasks.receive(
    f.book.id,
    expected(sent),
    sent.attemptId,
    returned(),
  );
}
const adoptionInput = () => ({
  title: "雾港·封面候选🌊",
  purpose: "cover",
  source: "合成模型候选；作者明确采用",
  rights: "合成测试",
  notes: "不自动设为封面",
  linkedIds: [],
});

test("explicit adoption atomically adds one resource with receipt, retains response hash, manuscript and old assets; repeat reads later edits without recreating anything", async () => {
  const f = await fixture(),
    value = await received(f),
    body = await readFile(
      join(f.root, f.book.id, "manuscript", f.book.chapters[0].id + ".md"),
    ),
    old = await f.store.assets.import(f.book.id, picture, adoptionInput());
  const adopted = await f.store.imageTasks.adopt(
    f.book.id,
    expected(value),
    0,
    adoptionInput(),
  );
  assert.equal(adopted.alreadyAccepted, false);
  assert.equal(adopted.task.candidates[0].decision, "accepted");
  assert.equal(adopted.task.responseHash, value.responseHash);
  assert.equal(adopted.asset.id, value.candidates[0].assetId);
  assert.equal(adopted.asset.blob.sha256, digest(picture));
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 2);
  assert.deepEqual(await f.store.assets.read(f.book.id, old.id), old);
  const edited = await f.store.assets.save(
    f.book.id,
    {
      ...adoptionInput(),
      title: "作者后改",
    },
    adopted.asset,
  );
  const again = await f.store.imageTasks.adopt(
    f.book.id,
    expected(adopted.task),
    0,
    adoptionInput(),
  );
  assert.equal(again.alreadyAccepted, true);
  assert.equal(again.asset.title, edited.title);
  assert.equal(again.asset.revision, edited.revision);
  assert.deepEqual(again.task, adopted.task);
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(adopted.task), 0, {
      ...adoptionInput(),
      title: "换说明",
    }),
    /已经按另一份说明/,
  );
  const discarded = await f.store.imageTasks.discard(
    f.book.id,
    expected(adopted.task),
  );
  assert.equal(discarded.candidates[0].decision, "accepted");
  assert.deepEqual(
    discarded.candidates[0].adoption,
    adopted.task.candidates[0].adoption,
  );
  assert.deepEqual(
    await readFile(
      join(f.root, f.book.id, "manuscript", f.book.chapters[0].id + ".md"),
    ),
    body,
  );
});

test("adoption refuses wrong purpose, discarded tasks, stale CAS and corrupted bytes without visible resources", async () => {
  const f = await fixture(),
    value = await received(f),
    before = await readFile(f.path);
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(value), 0, {
      ...adoptionInput(),
      purpose: "reference",
    }),
    /用途/,
  );
  await writeFile(f.path, Buffer.concat([before, Buffer.from(" \n")]));
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(value), 0, adoptionInput()),
    /已改变/,
  );
  await writeFile(f.path, before);
  const blob = join(
    f.root,
    f.book.id,
    "assets/blobs",
    value.candidates[0].blob.sha256 + ".png",
  );
  await writeFile(blob, Buffer.alloc(picture.length, 0));
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(value), 0, adoptionInput()),
    /校验/,
  );
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
  await writeFile(blob, picture);
  const discarded = await f.store.imageTasks.discard(
    f.book.id,
    expected(value),
  );
  await assert.rejects(
    f.store.imageTasks.adopt(
      f.book.id,
      expected(discarded),
      0,
      adoptionInput(),
    ),
    /已放弃/,
  );
});

test("a target edited while decoding refuses adoption after the book queue resumes and retains the paid candidate", async () => {
  const f = await fixture(),
    material = await f.store.materials.save(f.book.id, {
      kind: "character",
      title: "合成人物",
      status: "planned",
      fields: {},
      notes: "旧",
      chapterIds: [],
    });
  f.input.target = {
    purpose: "portrait",
    material: expected(material),
    chapter: null,
  };
  const value = await received(f),
    before = await readFile(f.path),
    input = {
      ...adoptionInput(),
      purpose: "portrait",
      linkedIds: [material.id],
    };
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(value), 0, {
      ...input,
      linkedIds: [],
    }),
    /关联人物/,
  );
  const decode = f.store.assets.decode.bind(f.store.assets);
  f.store.assets.decode = async (...args) => {
    const decoded = await decode(...args);
    await f.store.materials.save(
      f.book.id,
      { ...material, notes: "作者新改" },
      material,
    );
    return decoded;
  };
  await assert.rejects(
    f.store.imageTasks.adopt(f.book.id, expected(value), 0, input),
    /目标资料已改变/,
  );
  f.store.assets.decode = decode;
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
  assert.equal(
    (await f.store.imageTasks.preview(f.book.id, value.id, 0)).blob.sha256,
    digest(picture),
  );
});

test("a previously accepted resource removed outside the app is never silently recreated by adoption retry", async () => {
  const f = await fixture(),
    value = await received(f),
    adopted = await f.store.imageTasks.adopt(
      f.book.id,
      expected(value),
      0,
      adoptionInput(),
    ),
    path = join(f.root, f.book.id, "assets/items", adopted.asset.id + ".json");
  await rename(path, path + ".retained");
  await assert.rejects(
    f.store.imageTasks.adopt(
      f.book.id,
      expected(adopted.task),
      0,
      adoptionInput(),
    ),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    await f.store.imageTasks.read(f.book.id, value.id),
    adopted.task,
  );
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("a restored pending candidate is adopted only into the explicitly selected restored book, preserving the origin task and source assets", async () => {
  const f = await fixture(),
    value = await received(f),
    before = await readFile(f.path),
    backup = await f.store.createBackup(f.book.id, f.work),
    restored = await f.store.restoreBackup(backup.path),
    copied = await f.store.imageTasks.read(restored.id, value.id),
    adopted = await f.store.imageTasks.adopt(
      restored.id,
      expected(copied),
      0,
      adoptionInput(),
    );
  assert.equal(adopted.asset.bookId, restored.id);
  assert.equal(adopted.task.bookId, f.book.id);
  assert.equal(adopted.task.candidates[0].adoption.bookId, restored.id);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
  assert.equal((await f.store.assets.list(restored.id)).items.length, 1);
  const backup2 = await f.store.createBackup(restored.id, f.work),
    twice = await f.store.restoreBackup(backup2.path),
    twiceTask = await f.store.imageTasks.read(twice.id, value.id),
    lookup = await f.store.imageTasks.adopt(
      twice.id,
      expected(twiceTask),
      0,
      adoptionInput(),
    );
  assert.equal(lookup.alreadyAccepted, true);
  assert.equal(lookup.asset.bookId, restored.id);
  assert.equal((await f.store.assets.list(twice.id)).items.length, 1);
});

test("simultaneous adoption clicks commit once, and a separately occupied reserved identity is never overwritten or silently attached", async () => {
  const f = await fixture(),
    value = await received(f),
    attempts = await Promise.allSettled([
      f.store.imageTasks.adopt(f.book.id, expected(value), 0, adoptionInput()),
      f.store.imageTasks.adopt(f.book.id, expected(value), 0, adoptionInput()),
    ]);
  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 1);
  const g = await fixture(),
    pending = await received(g),
    before = await readFile(g.path),
    occupied = await g.store.assets.import(
      g.book.id,
      picture,
      adoptionInput(),
      pending.candidates[0].assetId,
    );
  await assert.rejects(
    g.store.imageTasks.adopt(g.book.id, expected(pending), 0, adoptionInput()),
    /预留身份已有资源/,
  );
  assert.deepEqual(await readFile(g.path), before);
  assert.deepEqual(await g.store.assets.read(g.book.id, occupied.id), occupied);
});

for (const [stage, code] of [
  ["journal", 95],
  ["first-record", 96],
]) {
  test(`actual process exit at adoption ${stage} recovers both exact records through one journal without duplicate assets or a network call`, async () => {
    const f = await fixture(),
      value = await received(f);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          resolve("tests/fixtures/image-adoption-crash.mjs"),
          f.root,
          f.book.id,
          JSON.stringify(expected(value)),
          JSON.stringify(adoptionInput()),
          stage,
        ],
        { windowsHide: true, timeout: 15000 },
      ),
      (error) => error.code === code,
    );
    const restarted = new NovelStore(f.root),
      recovered = await restarted.imageTasks.read(f.book.id, value.id);
    assert.equal(recovered.candidates[0].decision, "accepted");
    assert.equal(recovered.responseHash, value.responseHash);
    assert.equal((await restarted.assets.list(f.book.id)).items.length, 1);
    const lookup = await restarted.imageTasks.adopt(
      f.book.id,
      expected(recovered),
      0,
      adoptionInput(),
    );
    assert.equal(lookup.alreadyAccepted, true);
    assert.equal(lookup.asset.id, value.candidates[0].assetId);
    assert.equal(lookup.asset.blob.sha256, digest(picture));
  });
}

test("actual HTTP waits for durable book-local send intent; decoded candidates survive restart without becoming assets or editing a manuscript", async () => {
  const f = await fixture();
  let requests = 0,
    correctKey = false;
  const server = createServer(async (request, response) => {
    requests++;
    correctKey =
      request.headers.authorization === "Bearer synthetic-ledger-key";
    const record = JSON.parse(await readFile(f.path, "utf8"));
    assert.equal(record.status, "send-intent");
    assert.ok(record.attemptId);
    for await (const _chunk of request) {
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ b64_json: picture.toString("base64") }] }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const created = await f.store.imageTasks.create(f.book.id, f.input);
    let sent;
    const response = await requestImageCandidates(
      {
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        model: f.input.profile.model,
        apiKey: "synthetic-ledger-key",
        request: f.input.request,
        budget: f.input.budget,
      },
      {
        beforeDispatch: async () => {
          sent = await f.store.imageTasks.markSending(
            f.book.id,
            expected(created),
          );
        },
      },
    );
    const saved = await f.store.imageTasks.receive(
      f.book.id,
      expected(sent),
      sent.attemptId,
      response,
    );
    assert.equal(saved.status, "received");
    assert.equal(requests, 1);
    assert.equal(correctKey, true);
    assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
    assert.equal(
      (await f.store.readChapter(f.book.id, f.book.chapters[0].id)).body,
      "合成原稿𠮷🌊。",
    );
    const raw = await readFile(f.path);
    assert.ok(!raw.includes(Buffer.from("synthetic-ledger-key")));
    assert.ok(!raw.includes(Buffer.from("baseURL")));
    await f.store.whenIdle();
    const restarted = new NovelStore(f.root);
    const restored = await restarted.imageTasks.read(f.book.id, saved.id);
    assert.equal(restored.status, "received");
    const preview = await restarted.imageTasks.preview(f.book.id, saved.id, 0);
    assert.equal(preview.blob.sha256, digest(picture));
    assert.equal((await sharp(preview.thumbnail).metadata()).format, "png");
    assert.equal((await restarted.assets.list(f.book.id)).items.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stable creation IDs reconcile existing state without re-sending and reject different frozen inputs", async () => {
  const f = await fixture(),
    first = await f.store.imageTasks.create(f.book.id, f.input),
    bytes = await readFile(f.path);
  assert.deepEqual(await f.store.imageTasks.create(f.book.id, f.input), first);
  await assert.rejects(
    f.store.imageTasks.create(f.book.id, {
      ...f.input,
      request: { ...f.input.request, prompt: "别的输入" },
    }),
    /已有其他输入/,
  );
  assert.deepEqual(await readFile(f.path), bytes);
  const sent = await f.store.imageTasks.markSending(f.book.id, expected(first));
  assert.equal(
    (await f.store.imageTasks.create(f.book.id, f.input)).status,
    "sending",
  );
  await assert.rejects(
    f.store.imageTasks.markSending(f.book.id, expected(sent)),
    /不会自动重试/,
  );
});

test("restart makes a durable send intent unknown; it cannot be relabelled as unsent or receive a fabricated return from a new session", async () => {
  const f = await fixture(),
    first = await f.store.imageTasks.create(f.book.id, f.input),
    sent = await f.store.imageTasks.markSending(f.book.id, expected(first)),
    bytes = await readFile(f.path);
  await f.store.whenIdle();
  const restarted = new NovelStore(f.root),
    value = await restarted.imageTasks.read(f.book.id, sent.id);
  assert.equal(value.status, "remote-unknown");
  assert.deepEqual(await readFile(f.path), bytes);
  await assert.rejects(
    restarted.imageTasks.markSending(f.book.id, expected(value)),
    /不会自动重试/,
  );
  await assert.rejects(
    restarted.imageTasks.finishFailure(f.book.id, expected(value), {
      code: "CANCELLED",
      dispatched: false,
      remoteResult: "not-sent",
    }),
    /重启/,
  );
  await assert.rejects(
    restarted.imageTasks.receive(
      f.book.id,
      expected(value),
      sent.attemptId,
      returned(),
    ),
    /当前发送会话/,
  );
  const unknown = await restarted.imageTasks.finishFailure(
    f.book.id,
    expected(value),
    { code: "NETWORK", dispatched: true, remoteResult: "unknown" },
  );
  assert.equal(unknown.status, "unknown");
  const discarded = await restarted.imageTasks.discard(
    f.book.id,
    expected(unknown),
  );
  assert.equal(discarded.outcome.remoteResult, "unknown");
});

test("target versions are checked before sending, but later author edits do not discard paid returned candidates", async () => {
  const f = await fixture(),
    material = await f.store.materials.save(f.book.id, {
      kind: "character",
      title: "合成人物",
      status: "planned",
      fields: {},
      notes: "旧计划",
      chapterIds: [],
    });
  f.input.target = {
    purpose: "portrait",
    material: expected(material),
    chapter: null,
  };
  const first = await f.store.imageTasks.create(f.book.id, f.input),
    before = await readFile(f.path);
  const newer = await f.store.materials.save(
    f.book.id,
    { ...material, notes: "作者新计划" },
    material,
  );
  await assert.rejects(
    f.store.imageTasks.markSending(f.book.id, expected(first)),
    /目标资料已改变/,
  );
  assert.deepEqual(await readFile(f.path), before);
  f.input.id = randomUUID();
  f.input.target.material = expected(newer);
  const prepared = await f.store.imageTasks.create(f.book.id, f.input),
    sent = await f.store.imageTasks.markSending(f.book.id, expected(prepared));
  await f.store.materials.save(
    f.book.id,
    { ...newer, notes: "发送之后作者继续修改" },
    newer,
  );
  const response = returned();
  response.interruptedAfterResponse = true;
  const saved = await f.store.imageTasks.receive(
    f.book.id,
    expected(sent),
    sent.attemptId,
    response,
  );
  assert.equal(saved.status, "received");
  assert.equal(saved.interruptedAfterResponse, true);
  assert.equal(saved.target.material.diskHash, newer.diskHash);
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
});

test("foreign targets, plaintext credentials, unsupported schema, invalid UTF-8 and changed fingerprints refuse without overwriting originals", async () => {
  const f = await fixture(),
    other = await f.store.createBook("另一合成书"),
    material = await f.store.materials.save(other.id, {
      kind: "character",
      title: "外书人物",
      status: "planned",
      fields: {},
      notes: "",
      chapterIds: [],
    });
  await assert.rejects(
    f.store.imageTasks.create(f.book.id, {
      ...f.input,
      target: {
        purpose: "portrait",
        material: expected(material),
        chapter: null,
      },
    }),
  );
  await assert.rejects(
    f.store.imageTasks.create(f.book.id, {
      ...f.input,
      profile: { ...f.input.profile, apiKey: "synthetic-not-allowed" },
    }),
    /字段/,
  );
  const saved = await f.store.imageTasks.create(f.book.id, f.input),
    original = await readFile(f.path),
    data = JSON.parse(original);
  for (const bad of [
    Buffer.from(JSON.stringify({ ...data, schemaVersion: 99 })),
    Buffer.from([0xc3, 0x28]),
    Buffer.from(
      JSON.stringify({
        ...data,
        request: { ...data.request, prompt: "被外改且指纹未更新" },
      }),
    ),
  ]) {
    await writeFile(f.path, bad);
    await assert.rejects(f.store.imageTasks.read(f.book.id, saved.id));
    await assert.rejects(f.store.imageTasks.create(f.book.id, f.input));
    assert.deepEqual(await readFile(f.path), bad);
    assert.equal((await f.store.imageTasks.list(f.book.id)).errors.length, 1);
  }
  await writeFile(f.path, original);
});

test("raw-byte conflicts, wrong attempts and corrupt shared image objects never overwrite task state or create visible assets", async () => {
  const f = await fixture(),
    saved = await f.store.imageTasks.create(f.book.id, f.input),
    original = await readFile(f.path),
    edited = Buffer.concat([original, Buffer.from(" \n")]);
  await writeFile(f.path, edited);
  await assert.rejects(
    f.store.imageTasks.discard(f.book.id, expected(saved)),
    /已改变/,
  );
  assert.deepEqual(await readFile(f.path), edited);
  await writeFile(f.path, original);
  const sent = await f.store.imageTasks.markSending(f.book.id, expected(saved));
  await assert.rejects(
    f.store.imageTasks.receive(
      f.book.id,
      expected(sent),
      randomUUID(),
      returned(),
    ),
    /发送会话/,
  );
  const value = await f.store.imageTasks.receive(
    f.book.id,
    expected(sent),
    sent.attemptId,
    returned(),
  );
  const objectPath = join(
    f.root,
    f.book.id,
    "assets/blobs",
    value.candidates[0].blob.sha256 + ".png",
  );
  await writeFile(objectPath, Buffer.alloc(picture.length, 1));
  await assert.rejects(
    f.store.imageTasks.preview(f.book.id, value.id, 0),
    /校验失败/,
  );
  assert.equal((await f.store.assets.list(f.book.id)).items.length, 0);
});

test("full book backup and restore retain unadopted candidates and frozen origin without resuming a provider request", async () => {
  const f = await fixture(),
    value = await received(f),
    parent = join(f.work, "external");
  await mkdir(parent);
  const backup = await f.store.createBackup(f.book.id, parent),
    restored = await f.store.restoreBackup(backup.path);
  const copied = await f.store.imageTasks.read(restored.id, value.id);
  assert.equal(copied.status, "received");
  assert.equal(copied.restoredSource, true);
  assert.equal(copied.bookId, f.book.id);
  assert.equal(
    (await f.store.imageTasks.preview(restored.id, value.id, 0)).blob.sha256,
    digest(picture),
  );
  await assert.rejects(
    f.store.imageTasks.markSending(restored.id, expected(copied)),
    /当前作品/,
  );
  assert.equal((await f.store.assets.list(restored.id)).items.length, 0);
});

test("a worker exits after durable intent journal creation; startup recovery retains unknown result rather than automatically sending", async () => {
  const f = await fixture(),
    value = await f.store.imageTasks.create(f.book.id, f.input);
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        resolve("tests/fixtures/image-task-crash.mjs"),
        f.root,
        f.book.id,
        JSON.stringify(expected(value)),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
    (error) => error.code === 97,
  );
  const pending = JSON.parse(
    await readFile(join(f.root, f.book.id, ".zinovel/pending.json"), "utf8"),
  );
  assert.ok(
    pending.entries.some(
      (entry) => JSON.parse(entry.after).status === "send-intent",
    ),
  );
  const restarted = new NovelStore(f.root),
    task = await restarted.imageTasks.read(f.book.id, value.id);
  assert.equal(task.status, "remote-unknown");
  assert.equal(task.storedStatus, "send-intent");
  assert.equal(
    (
      await readFile(join(f.root, f.book.id, ".zinovel/pending.json"), "utf8")
    ).trim(),
    "",
  );
  assert.equal(
    (await restarted.readChapter(f.book.id, f.book.chapters[0].id)).body,
    "合成原稿𠮷🌊。",
  );
});

test("image services cannot be attached to a different writer kernel", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      new ImageTaskStore(
        new BookStorageKernel(f.root),
        f.store.assets,
        f.store.materials,
      ),
    /唯一/,
  );
});

test("restored interrupted tasks can be explicitly discarded while keeping dispatch unknown, never rewritten as unsent", async () => {
  const f = await fixture(),
    prepared = await f.store.imageTasks.create(f.book.id, f.input),
    sent = await f.store.imageTasks.markSending(f.book.id, expected(prepared));
  await assert.rejects(
    f.store.imageTasks.discard(f.book.id, expected(sent)),
    /进行中/,
  );
  const parent = join(f.work, "independent");
  await mkdir(parent);
  const backup = await f.store.createBackup(f.book.id, parent),
    restored = await f.store.restoreBackup(backup.path),
    task = await f.store.imageTasks.read(restored.id, sent.id);
  assert.equal(task.dispatchState, "unknown");
  const discarded = await f.store.imageTasks.discard(
    restored.id,
    expected(task),
  );
  assert.equal(discarded.status, "discarded");
  assert.equal(discarded.dispatchState, "unknown");
  assert.equal(discarded.attemptId, sent.attemptId);
  assert.equal(
    (await f.store.imageTasks.read(f.book.id, sent.id)).storedStatus,
    "send-intent",
  );
});

test("chapter illustrations freeze chapter identity, revision and body hash and reject an external same-revision edit before sending", async () => {
  const f = await fixture(),
    chapter = await f.store.readChapter(f.book.id, f.book.chapters[0].id);
  f.input.target = {
    purpose: "illustration",
    material: null,
    chapter: expected(chapter),
  };
  const task = await f.store.imageTasks.create(f.book.id, f.input),
    before = await readFile(f.path);
  await writeFile(
    join(f.root, f.book.id, "manuscript", chapter.id + ".md"),
    "同修订外部改稿𠮷🌊。",
  );
  await assert.rejects(
    f.store.imageTasks.markSending(f.book.id, expected(task)),
    /目标正文已改变/,
  );
  assert.deepEqual(await readFile(f.path), before);
});

test("received bytes, usage and flags are captured before queue waits and cannot be changed by the caller while the book is busy", async () => {
  const f = await fixture(),
    task = await f.store.imageTasks.create(f.book.id, f.input),
    sent = await f.store.imageTasks.markSending(f.book.id, expected(task));
  let release, entered;
  const held = new Promise((resolve) => {
    entered = resolve;
  });
  const lock = f.store.assets.storage.exclusive(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await held;
  const response = returned(),
    pending = f.store.imageTasks.receive(
      f.book.id,
      expected(sent),
      sent.attemptId,
      response,
    );
  response.candidates[0].bytes.fill(0);
  response.candidates[0].revisedPrompt = "队列期间外改";
  response.usage = { privateField: "not accepted" };
  response.interruptedAfterResponse = true;
  release();
  await lock;
  const saved = await pending;
  assert.equal(saved.usage, null);
  assert.equal(saved.interruptedAfterResponse, false);
  assert.equal(saved.candidates[0].blob.sha256, digest(picture));
  assert.equal(
    saved.candidates[0].revisedPrompt,
    "合成返回提示，不是工具指令。",
  );
});

test("paid candidate decoding waits for a reserved existing slot while ordinary excess previews still refuse", async () => {
  const f = await fixture();
  const first = f.store.assets.decode(picture),
    second = f.store.assets.decode(picture);
  const paidBytes = Buffer.from(picture),
    paid = f.store.assets.decode(paidBytes, undefined, { wait: true });
  paidBytes.fill(0);
  await assert.rejects(f.store.assets.decode(picture), /繁忙/);
  const decoded = await Promise.all([first, second, paid]);
  assert.ok(decoded.every((item) => item.blob.sha256 === digest(picture)));
  assert.equal(
    (await f.store.assets.decode(picture)).blob.sha256,
    digest(picture),
  );
});

test("a worker exit after receive intent keeps known response hashes and incomplete files, then exact original bytes can be saved without another request", async () => {
  const f = await fixture(),
    first = await f.store.imageTasks.create(f.book.id, f.input);
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        resolve("tests/fixtures/image-task-crash.mjs"),
        f.root,
        f.book.id,
        JSON.stringify(expected(first)),
        "receive-intent",
      ],
      { windowsHide: true, timeout: 15000 },
    ),
    (error) => error.code === 97,
  );
  const restarted = new NovelStore(f.root),
    pending = await restarted.imageTasks.read(f.book.id, first.id);
  assert.equal(pending.status, "received-pending-check");
  assert.equal(pending.dispatchState, "response-received");
  assert.equal(pending.candidates[0].blob.sha256, digest(picture));
  const before = await readFile(f.path),
    incomplete = await restarted.imageTasks.reconcileReceived(
      f.book.id,
      expected(pending),
    );
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(
    incomplete.issues.map((item) => item.index),
    [0],
  );
  assert.deepEqual(await readFile(f.path), before);
  await assert.rejects(
    restarted.imageTasks.finishFailure(f.book.id, expected(pending), {
      code: "NETWORK",
      dispatched: true,
      remoteResult: "unknown",
    }),
    /状态/,
  );
  const wrong = returned();
  wrong.candidates[0].bytes = await sharp({
    create: { width: 64, height: 32, channels: 4, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    restarted.imageTasks.receive(
      f.book.id,
      expected(pending),
      pending.attemptId,
      wrong,
    ),
    /回执不符/,
  );
  assert.deepEqual(await readFile(f.path), before);
  const complete = await restarted.imageTasks.receive(
    f.book.id,
    expected(pending),
    pending.attemptId,
    returned(),
  );
  assert.equal(complete.status, "received");
  assert.equal(complete.responseHash, pending.responseHash);
  assert.equal(complete.candidates[0].assetId, pending.candidates[0].assetId);
  assert.equal((await restarted.assets.list(f.book.id)).items.length, 0);
});

test("a worker exit after candidate blob publication is reconciled locally to received and never creates visible resource metadata", async () => {
  const f = await fixture(),
    first = await f.store.imageTasks.create(f.book.id, f.input);
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        resolve("tests/fixtures/image-task-crash.mjs"),
        f.root,
        f.book.id,
        JSON.stringify(expected(first)),
        "blob-written",
      ],
      { windowsHide: true, timeout: 15000 },
    ),
    (error) => error.code === 98,
  );
  const restarted = new NovelStore(f.root),
    pending = await restarted.imageTasks.read(f.book.id, first.id);
  assert.equal(pending.status, "received-pending-check");
  const reconciled = await restarted.imageTasks.reconcileReceived(
    f.book.id,
    expected(pending),
  );
  assert.equal(reconciled.status, "received");
  assert.deepEqual(reconciled.issues, []);
  assert.equal(reconciled.task.responseHash, pending.responseHash);
  assert.equal(
    (await restarted.imageTasks.preview(f.book.id, first.id, 0)).blob.sha256,
    digest(picture),
  );
  assert.equal((await restarted.assets.list(f.book.id)).items.length, 0);
});
