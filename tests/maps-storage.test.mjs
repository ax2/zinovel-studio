import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { mapRouteGeometry } from "../packages/novel-domain/maps.mjs";

const input = (title = "雾港𠮷🌊地图") => ({
  title,
  notes: "作者手绘",
  era: "河历三年",
  canvas: { width: 1000, height: 500 },
  scale: null,
  elements: [],
});
const fields = (value) =>
  Object.fromEntries(
    ["title", "notes", "era", "canvas", "scale", "elements"].map((key) => [
      key,
      structuredClone(value[key]),
    ]),
  );
const point = (x, y, locationId = null) => ({
  id: randomUUID(),
  kind: "place",
  title: "同名地点",
  notes: "",
  point: { x, y },
  locationId,
});
const route = (a, b) => ({
  id: randomUUID(),
  kind: "route",
  title: "合成路线",
  notes: "",
  travelNotes: "作者另行决定行程",
  fromId: a.id,
  toId: b.id,
  via: [],
});
const assetInput = {
  title: "合成地图底图",
  purpose: "map",
  source: "程序合成",
  rights: "本地验收",
  notes: "不含真人素材",
  linkedIds: [],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-maps-")),
    store = new NovelStore(join(root, "library")),
    book = await store.importBook("合成地图作品", [
      { title: "旧信", body: "地图不改原稿。𠮷🌊" },
    ]);
  return {
    root,
    store,
    book,
    folder: join(root, "library", book.id),
    file: (id) => join(root, "library", book.id, "world/maps", id + ".json"),
  };
}
async function image(color = "#126b83") {
  return sharp({
    create: { width: 80, height: 40, channels: 3, background: color },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

test("map creation is idempotent without rewinding later edits; exact-version save, history, recycle and restore keep identities and manuscript", async () => {
  const f = await fixture(),
    id = randomUUID(),
    data = input();
  const first = await f.store.maps.create(f.book.id, data, id);
  const next = await f.store.maps.save(
    f.book.id,
    { ...data, title: "后来改名" },
    first,
  );
  assert.deepEqual(await f.store.maps.create(f.book.id, data, id), next);
  await assert.rejects(
    f.store.maps.create(f.book.id, input("不同创建内容"), id),
    /已保存其他/,
  );
  await assert.rejects(
    f.store.maps.save(f.book.id, input(), first),
    /已被其他/,
  );
  assert.equal(
    (await f.store.maps.history(f.book.id, id)).items[0].revision,
    1,
  );
  const retired = await f.store.maps.setDeleted(f.book.id, next, true);
  assert.equal((await f.store.maps.list(f.book.id)).total, 0);
  assert.equal(
    (await f.store.maps.list(f.book.id, { deleted: true })).total,
    1,
  );
  await assert.rejects(f.store.maps.save(f.book.id, input(), retired), /恢复/);
  const restored = await f.store.maps.setDeleted(f.book.id, retired, false);
  assert.equal(restored.id, id);
  assert.equal(restored.creationHash, first.creationHash);
  assert.equal(restored.deletedAt, undefined);
  assert.equal((await f.store.maps.creation(f.book.id, id)).title, "后来改名");
  assert.equal(await f.store.maps.creation(f.book.id, randomUUID()), null);
  assert.equal(
    (await f.store.readChapter(f.book.id, f.book.chapters[0].id)).body,
    "地图不改原稿。𠮷🌊",
  );
});

test("map links require same-book location cards and live new endpoints; saved objects retire rather than vanish or change type", async () => {
  const f = await fixture(),
    other = await f.store.createBook("另一书");
  const location = await f.store.materials.save(f.book.id, {
    kind: "location",
    title: "雾港",
    notes: "",
    status: "planned",
    fields: {},
    chapterIds: [],
  });
  const foreign = await f.store.materials.save(other.id, {
    kind: "location",
    title: "外书地点",
    notes: "",
    status: "planned",
    fields: {},
    chapterIds: [],
  });
  const character = await f.store.materials.save(f.book.id, {
    kind: "character",
    title: "人物",
    notes: "",
    status: "planned",
    fields: {},
    chapterIds: [],
  });
  for (const invalid of [foreign.id, character.id])
    await assert.rejects(
      f.store.maps.create(f.book.id, {
        ...input(),
        elements: [point(0, 0, invalid)],
      }),
    );
  const a = point(0, 0, location.id),
    b = point(1, 1),
    path = route(a, b);
  await assert.rejects(
    f.store.maps.create(f.book.id, { ...input(), elements: [a, path] }),
    /新路线端点/,
  );
  const first = await f.store.maps.create(f.book.id, {
    ...input(),
    elements: [a, b, path],
  });
  await assert.rejects(
    f.store.maps.save(
      f.book.id,
      { ...fields(first), elements: [a, path] },
      first,
    ),
    /不要直接移除/,
  );
  const changedKind = {
    id: a.id,
    kind: "region",
    title: a.title,
    notes: "",
    locationId: null,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  };
  await assert.rejects(
    f.store.maps.save(
      f.book.id,
      { ...fields(first), elements: [changedKind, b, path] },
      first,
    ),
    /改变类型/,
  );
  await f.store.materials.setDeleted(f.book.id, location, true);
  const data = fields(first);
  data.elements[1].deletedAt = "2000-01-01T00:00:00Z";
  const saved = await f.store.maps.save(f.book.id, data, first);
  assert.notEqual(
    saved.elements[1].deletedAt,
    data.elements[1].deletedAt,
    "host owns new retirement timestamp",
  );
  assert.equal(
    saved.elements[0].locationId,
    location.id,
    "existing missing/retired association is retained",
  );
  assert.equal(
    mapRouteGeometry(fields(saved), path.id).state,
    "missing-endpoint",
  );
});

test("frozen background survives later asset replacement/recycle; author calibration resets only for a changed original, history adoption retains later versions", async () => {
  const f = await fixture(),
    firstMap = await f.store.maps.create(f.book.id, input()),
    firstBytes = await image();
  let asset = await f.store.assets.import(f.book.id, firstBytes, assetInput);
  const originalAsset = asset;
  let map = await f.store.maps.setBackground(f.book.id, firstMap, asset);
  const frozen = map;
  assert.deepEqual(map.canvas, { width: 40, height: 80 });
  assert.equal(map.background.record.blob.sha256, asset.blob.sha256);
  const calibrated = {
    ...fields(map),
    scale: {
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      distance: 100,
      unit: "里",
    },
  };
  map = await f.store.maps.save(f.book.id, calibrated, map);
  const renamedAsset = await f.store.assets.save(
    f.book.id,
    { ...assetInput, title: "只改来源标题" },
    asset,
  );
  map = await f.store.maps.setBackground(f.book.id, map, renamedAsset);
  assert.equal(map.scale.distance, 100);
  asset = await f.store.assets.replace(
    f.book.id,
    await image("#915844"),
    renamedAsset,
  );
  assert.equal(
    (await f.store.maps.read(f.book.id, map.id)).background.record.blob.sha256,
    frozen.background.record.blob.sha256,
  );
  const retiredAsset = await f.store.assets.setDeleted(f.book.id, asset, true);
  assert.match(
    (await f.store.maps.backgroundPreview(f.book.id, map)).dataUrl,
    /^data:image\/png;base64,/,
  );
  await assert.rejects(
    f.store.maps.setBackground(f.book.id, map, retiredAsset),
    /恢复/,
  );
  asset = await f.store.assets.setDeleted(f.book.id, retiredAsset, false);
  map = await f.store.maps.setBackground(f.book.id, map, asset);
  assert.equal(map.scale, null);
  assert.notEqual(
    map.background.record.blob.sha256,
    frozen.background.record.blob.sha256,
  );
  assert.equal(
    (await f.store.maps.backgroundPreview(f.book.id, frozen, true)).background
      .record.blob.sha256,
    frozen.background.record.blob.sha256,
  );
  const adopted = await f.store.maps.restoreVersion(f.book.id, map, frozen);
  assert.equal(
    adopted.background.record.blob.sha256,
    frozen.background.record.blob.sha256,
  );
  assert.equal(adopted.revision, map.revision + 1);
  assert.equal(adopted.creationHash, firstMap.creationHash);
  assert.ok(
    (await f.store.maps.history(f.book.id, map.id)).items.some(
      (v) => v.background?.record.blob.sha256 === asset.blob.sha256,
    ),
  );
  const backup = await f.store.createBackup(f.book.id, f.root),
    restored = await f.store.restoreBackup(backup.path);
  assert.notEqual(restored.id, f.book.id);
  assert.equal(
    (await f.store.maps.backgroundPreview(restored.id, adopted)).background
      .record.blob.sha256,
    frozen.background.record.blob.sha256,
  );
  assert.equal(
    (await f.store.maps.read(restored.id, adopted.id)).bookId,
    f.book.id,
  );
  const selectedHistory = await f.store.maps.setBackground(
    f.book.id,
    adopted,
    originalAsset,
    true,
  );
  assert.equal(
    selectedHistory.background.record.revision,
    originalAsset.revision,
  );
  assert.equal(selectedHistory.background.diskHash, originalAsset.diskHash);
});

test("actual map transaction preimage guard refuses an external edit between validation and journal; broken/future bytes remain untouched", async () => {
  const f = await fixture(),
    map = await f.store.maps.create(f.book.id, input()),
    file = f.file(map.id),
    commit = f.store.maps.commit.bind(f.store.maps);
  let external;
  f.store.maps.commit = async (...args) => {
    const data = JSON.parse(await readFile(file, "utf8"));
    data.title = "同修订外部修改";
    external = JSON.stringify(data, null, 2) + "\n";
    await writeFile(file, external);
    return commit(...args);
  };
  await assert.rejects(
    f.store.maps.save(f.book.id, input("旧基线调整"), map),
    /事务前像/,
  );
  assert.equal(await readFile(file, "utf8"), external);
  f.store.maps.commit = commit;
  assert.equal(
    (await f.store.maps.read(f.book.id, map.id)).title,
    "同修订外部修改",
  );
  const malformed = Buffer.from([0xc3, 0x28]);
  await writeFile(file, malformed);
  await assert.rejects(f.store.maps.read(f.book.id, map.id), /UTF-8/);
  assert.equal((await f.store.maps.list(f.book.id)).errors.length, 1);
  assert.deepEqual(await readFile(file), malformed);
  const future = { ...JSON.parse(external), schemaVersion: 99 };
  await writeFile(file, JSON.stringify(future));
  await assert.rejects(f.store.maps.creation(f.book.id, map.id), /版本/);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), future);
});

test("real pending journal recovery finds the same map creation exactly once; caller mutation before queue entry cannot alter captured geometry", async () => {
  const f = await fixture(),
    kernel = f.store.maps.storage,
    recover = kernel.recover.bind(kernel),
    id = randomUUID(),
    data = input();
  data.elements = [point(0.25, 0.5)];
  let interrupted = false;
  kernel.recover = async (root) => {
    const pending = await readFile(
      join(root, ".zinovel/pending.json"),
      "utf8",
    ).catch(() => "");
    if (pending && !interrupted) {
      interrupted = true;
      throw new Error("synthetic map after journal");
    }
    return recover(root);
  };
  const original = structuredClone(data),
    pending = f.store.maps.create(f.book.id, data, id);
  data.title = "调用后改变";
  data.elements[0].point.x = 0.9;
  await assert.rejects(pending, /synthetic map after journal/);
  const reopened = new NovelStore(join(f.root, "library"));
  const found = await reopened.maps.creation(f.book.id, id);
  assert.equal(found.title, original.title);
  assert.equal(found.elements[0].point.x, 0.25);
  assert.deepEqual(await reopened.maps.create(f.book.id, original, id), found);
  assert.equal((await reopened.maps.list(f.book.id)).total, 1);
});

test("background decode stays outside the shared manuscript queue and stale map/asset versions refuse the later commit", async () => {
  const f = await fixture(),
    map = await f.store.maps.create(f.book.id, input()),
    asset = await f.store.assets.import(f.book.id, await image(), assetInput);
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve)),
    original = f.store.maps.verifyImage.bind(f.store.maps);
  f.store.maps.verifyImage = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const selecting = f.store.maps.setBackground(f.book.id, map, asset);
  await started;
  const chapter = await f.store.readChapter(f.book.id, f.book.chapters[0].id);
  await f.store.saveChapter({
    bookId: f.book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: "底图解码期间手工保存成功。",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
  const changed = await f.store.maps.save(
    f.book.id,
    input("后来修改地图"),
    map,
  );
  release();
  await assert.rejects(selecting, /地图已被其他/);
  assert.equal(
    (await f.store.maps.read(f.book.id, changed.id)).background,
    null,
  );
  assert.equal(
    (await f.store.readChapter(f.book.id, chapter.id)).body,
    "底图解码期间手工保存成功。",
  );
  let enteredAsset, releaseAsset;
  const assetStarted = new Promise((resolve) => (enteredAsset = resolve)),
    assetGate = new Promise((resolve) => (releaseAsset = resolve));
  f.store.maps.verifyImage = async (...args) => {
    enteredAsset();
    await assetGate;
    return original(...args);
  };
  const selectingAsset = f.store.maps.setBackground(f.book.id, changed, asset);
  await assetStarted;
  await f.store.assets.save(
    f.book.id,
    { ...assetInput, title: "选择后改版" },
    asset,
  );
  releaseAsset();
  await assert.rejects(selectingAsset, /图像资源已被其他/);
  assert.equal(
    (await f.store.maps.read(f.book.id, changed.id)).background,
    null,
  );
});

test("map byte limit fails before journal/output, and paged summaries disclose unreadable records without sending geometry", async () => {
  const f = await fixture(),
    data = input();
  data.elements = Array.from({ length: 140 }, () => ({
    ...point(0.5, 0.5),
    notes: "字".repeat(8000),
  }));
  const pending = join(f.folder, ".zinovel/pending.json"),
    before = await readFile(pending);
  await assert.rejects(f.store.maps.create(f.book.id, data), /超过1MiB/);
  assert.deepEqual(await readFile(pending), before);
  await assert.rejects(readdir(join(f.folder, "world/maps")), {
    code: "ENOENT",
  });
  for (let i = 0; i < 41; i++)
    await f.store.maps.create(f.book.id, input("分页地图" + i));
  const futurePath = f.file(randomUUID()),
    future = Buffer.from('{"schemaVersion":99}');
  await writeFile(futurePath, future);
  const first = await f.store.maps.list(f.book.id, { query: "分页地图" }),
    second = await f.store.maps.list(f.book.id, { offset: 40 });
  assert.equal(first.total, 41);
  assert.equal(first.items.length, 40);
  assert.equal(second.items.length, 1);
  assert.equal(first.errors.length, 1);
  assert.equal(Object.hasOwn(first.items[0], "elements"), false);
  assert.deepEqual(await readFile(futurePath), future);
});

test("linked world/maps paths refuse writes outside the book, while corrupt immutable backgrounds refuse preview without altering map or blob", async () => {
  const linked = await fixture(),
    outside = join(linked.root, "outside");
  await mkdir(outside);
  await mkdir(join(linked.folder, "world"), { recursive: true });
  await symlink(
    outside,
    join(linked.folder, "world/maps"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    linked.store.maps.create(linked.book.id, input()),
    /链接/,
  );
  assert.deepEqual(await readdir(outside), []);
  const f = await fixture(),
    map = await f.store.maps.create(f.book.id, input()),
    bytes = await image(),
    asset = await f.store.assets.import(f.book.id, bytes, assetInput);
  const withBackground = await f.store.maps.setBackground(
      f.book.id,
      map,
      asset,
    ),
    raw = await readFile(f.file(map.id)),
    blob = join(f.folder, "assets/blobs", asset.blob.sha256 + ".jpeg"),
    damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 255;
  await writeFile(blob, damaged);
  await assert.rejects(
    f.store.maps.backgroundPreview(f.book.id, withBackground),
    /校验/,
  );
  assert.deepEqual(await readFile(blob), damaged);
  assert.deepEqual(await readFile(f.file(map.id)), raw);
});

test("corrupt or unknown history is disclosed and cannot be adopted over current geometry", async () => {
  const f = await fixture(),
    first = await f.store.maps.create(f.book.id, input());
  const second = await f.store.maps.save(f.book.id, input("第二版"), first);
  const current = await f.store.maps.save(f.book.id, input("第三版"), second);
  const directory = join(f.folder, ".zinovel/map-history", first.id),
    bad = join(directory, `1-${first.diskHash}.json`),
    unknown = join(directory, "future.json"),
    badBytes = Buffer.from([0xff, 0xfe]);
  await writeFile(bad, badBytes);
  await writeFile(unknown, '{"schemaVersion":99}');
  const before = await readFile(f.file(first.id)),
    history = await f.store.maps.history(f.book.id, first.id);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].revision, 2);
  assert.equal(history.errors.length, 2);
  await assert.rejects(f.store.maps.restoreVersion(f.book.id, current, first));
  assert.deepEqual(await readFile(f.file(first.id)), before);
  assert.deepEqual(await readFile(bad), badBytes);
  assert.equal(await readFile(unknown, "utf8"), '{"schemaVersion":99}');
});
