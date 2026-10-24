import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
const empty = () => ({ notes: "", epochs: [], entries: [] });
const fields = (r) => ({
  notes: r.notes,
  epochs: r.epochs,
  entries: r.entries,
});
const node = (map, parent = null, anchor = null, epoch = null) => ({
  mapId: map.id,
  parentId: parent?.id ?? null,
  anchorId: anchor?.id ?? null,
  epochId: epoch?.id ?? null,
  notes: "",
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-atlas-")),
    store = new NovelStore(join(root, "library")),
    book = await store.importBook("地图册合成作品", [
      { title: "旧信", body: "地图册不改原稿𠮷。" },
    ]);
  const map = async (title = "同名地图", elements = []) =>
    store.maps.create(book.id, {
      title,
      notes: "",
      era: "",
      canvas: { width: 1000, height: 700 },
      scale: null,
      elements,
    });
  const anchor = {
    id: randomUUID(),
    kind: "place",
    title: "城门",
    notes: "",
    point: { x: 0.2, y: 0.3 },
    locationId: null,
  };
  const world = await map("世界", [anchor]),
    city = await map("城市"),
    epoch = { id: randomUUID(), title: "河历三年", notes: "" };
  return {
    root,
    store,
    book,
    map,
    world,
    city,
    anchor,
    epoch,
    file: join(root, "library", book.id, "world/map-atlas.json"),
    folder: join(root, "library", book.id),
  };
}
test("atlas compare-and-swap preserves source frames, history and later revisions without duplicate creation", async () => {
  const f = await fixture(),
    before = await readFile(join(f.folder, "world/maps", f.world.id + ".json"));
  assert.equal(await f.store.atlas.read(f.book.id), null);
  let atlas = await f.store.atlas.save(
    f.book.id,
    {
      ...empty(),
      epochs: [f.epoch],
      entries: [node(f.world), node(f.city, f.world, f.anchor, f.epoch)],
    },
    null,
  );
  assert.equal(atlas.revision, 1);
  assert.deepEqual(
    await f.store.atlas.save(f.book.id, fields(atlas), atlas),
    atlas,
  );
  await assert.rejects(
    f.store.atlas.save(f.book.id, empty(), null),
    /其他操作/,
  );
  const first = atlas;
  atlas = await f.store.atlas.save(
    f.book.id,
    { ...fields(atlas), notes: "后来作者说明𠮷🌊" },
    atlas,
  );
  await assert.rejects(
    f.store.atlas.save(f.book.id, { ...fields(first), notes: "过期" }, first),
    /其他操作/,
  );
  assert.equal(
    (await f.store.atlas.history(f.book.id)).items[0].diskHash,
    first.diskHash,
  );
  const historicalView = await f.store.atlas.inspect(f.book.id, {
    historical: first,
    parentId: f.world.id,
    anchorId: f.anchor.id,
  });
  assert.equal(historicalView.record.diskHash, first.diskHash);
  assert.equal(historicalView.rows.length, 1);
  assert.equal(historicalView.rows[0].entry.mapId, f.city.id);
  assert.equal(historicalView.mapNames, "current");
  const restored = await f.store.atlas.restoreVersion(f.book.id, atlas, first);
  assert.equal(restored.revision, 3);
  assert.equal(restored.notes, first.notes);
  assert.equal((await f.store.atlas.history(f.book.id)).items.length, 2);
  assert.deepEqual(
    await readFile(join(f.folder, "world/maps", f.world.id + ".json")),
    before,
  );
  assert.equal(
    (await f.store.readChapter(f.book.id, f.book.chapters[0].id)).body,
    "地图册不改原稿𠮷。",
  );
});
test("new associations require same-book live maps and a live parent place/region, while retired or missing references remain diagnosable and removable", async () => {
  const f = await fixture(),
    other = await f.store.importBook("外书", [
      { title: "外书章", body: "外书原稿" },
    ]);
  const foreign = await f.store.maps.create(other.id, {
    title: "同名世界",
    notes: "",
    era: "",
    canvas: { width: 1000, height: 700 },
    scale: null,
    elements: [],
  });
  await assert.rejects(
    f.store.atlas.save(
      f.book.id,
      { ...empty(), entries: [node(foreign)] },
      null,
    ),
  );
  await assert.rejects(
    f.store.atlas.save(
      f.book.id,
      {
        ...empty(),
        entries: [node(f.world), node(f.city, f.world, { id: randomUUID() })],
      },
      null,
    ),
    /锚点/,
  );
  let atlas = await f.store.atlas.save(
    f.book.id,
    {
      ...empty(),
      epochs: [f.epoch],
      entries: [node(f.world), node(f.city, f.world, f.anchor)],
    },
    null,
  );
  const retired = await f.store.maps.setDeleted(f.book.id, f.world, true);
  const rows = await f.store.atlas.inspect(f.book.id);
  assert.equal(rows.rows[0].state, "retired");
  assert.equal(rows.rows[1].anchorState, "parent-unavailable");
  atlas = await f.store.atlas.save(
    f.book.id,
    {
      ...fields(atlas),
      notes: "保留旧失联关系",
      entries: atlas.entries.map((e) =>
        e.mapId === f.city.id ? { ...e, epochId: f.epoch.id } : e,
      ),
    },
    atlas,
  );
  const mapFile = join(f.folder, "world/maps", f.city.id + ".json");
  await rename(mapFile, mapFile + ".retained");
  assert.equal(
    (await f.store.atlas.inspect(f.book.id)).rows[1].state,
    "missing",
  );
  atlas = await f.store.atlas.save(
    f.book.id,
    {
      ...fields(atlas),
      entries: atlas.entries.map((e) => ({
        ...e,
        parentId: null,
        anchorId: null,
      })),
    },
    atlas,
  );
  assert.equal(atlas.entries[1].mapId, f.city.id);
  assert.equal(atlas.entries[1].epochId, f.epoch.id);
  assert.equal(
    (await f.store.maps.read(f.book.id, retired.id)).deletedAt,
    retired.deletedAt,
  );
});
test("atlas transaction preimages reject a real same-revision external change before journal creation", async () => {
  const f = await fixture(),
    atlas = await f.store.atlas.save(f.book.id, empty(), null),
    kernel = f.store.maps.storage,
    transaction = kernel.transaction.bind(kernel);
  let external;
  kernel.transaction = async (...args) => {
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    raw.notes = "真实外部目录修改";
    external = JSON.stringify(raw, null, 2) + "\n";
    await writeFile(f.file, external);
    return transaction(...args);
  };
  await assert.rejects(
    f.store.atlas.save(f.book.id, { ...empty(), notes: "旧输入" }, atlas),
    /前像/,
  );
  assert.equal(await readFile(f.file, "utf8"), external);
  assert.equal((await f.store.atlas.read(f.book.id)).notes, "真实外部目录修改");
});
test("real pending-journal interruption recovers one atlas revision and captures caller input before queue entry", async () => {
  const f = await fixture(),
    kernel = f.store.maps.storage,
    recover = kernel.recover.bind(kernel),
    value = { ...empty(), entries: [node(f.world)] };
  let interrupted = false;
  kernel.recover = async (root) => {
    const raw = await readFile(
      join(root, ".zinovel/pending.json"),
      "utf8",
    ).catch(() => "");
    if (raw && !interrupted) {
      interrupted = true;
      throw Error("synthetic atlas interruption");
    }
    return recover(root);
  };
  const saving = f.store.atlas.save(f.book.id, value, null);
  value.entries[0].notes = "调用后篡改输入";
  await assert.rejects(saving, /synthetic/);
  const reopened = new NovelStore(join(f.root, "library")),
    recovered = await reopened.atlas.read(f.book.id);
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.entries[0].notes, "");
  assert.equal(
    (await reopened.atlas.read(f.book.id)).diskHash,
    recovered.diskHash,
  );
});
test("corrupt/future atlas and history bytes remain unchanged and cannot be adopted; book backup restores source lineage independently", async () => {
  const f = await fixture();
  let atlas = await f.store.atlas.save(
    f.book.id,
    { ...empty(), entries: [node(f.world), node(f.city, f.world, f.anchor)] },
    null,
  );
  const first = atlas;
  atlas = await f.store.atlas.save(
    f.book.id,
    { ...fields(atlas), notes: "第二版" },
    atlas,
  );
  const backup = await f.store.createBackup(f.book.id, f.root),
    restored = await f.store.restoreBackup(backup.path);
  assert.notEqual(restored.id, f.book.id);
  const restoredAtlas = await f.store.atlas.read(restored.id);
  assert.equal(restoredAtlas.bookId, f.book.id);
  assert.equal(
    (await f.store.atlas.inspect(restored.id)).rows[1].anchorState,
    "ready",
  );
  await f.store.atlas.save(
    restored.id,
    { ...fields(restoredAtlas), notes: "恢复书独立修改" },
    restoredAtlas,
  );
  assert.equal((await f.store.atlas.read(f.book.id)).notes, "第二版");
  const history = join(
    f.folder,
    ".zinovel/map-atlas-history",
    first.revision + "-" + first.diskHash + ".json",
  );
  const malformed = Buffer.from([0xc3, 0x28]);
  await writeFile(history, malformed);
  assert.equal((await f.store.atlas.history(f.book.id)).errors.length, 1);
  await assert.rejects(
    f.store.atlas.restoreVersion(f.book.id, atlas, first),
    /UTF-8/,
  );
  const future = JSON.stringify({
    ...atlas,
    schemaVersion: 99,
    diskHash: undefined,
  });
  await writeFile(f.file, future);
  await assert.rejects(f.store.atlas.read(f.book.id), /版本/);
  await assert.rejects(f.store.atlas.save(f.book.id, empty(), atlas));
  assert.equal(await readFile(f.file, "utf8"), future);
  assert.deepEqual(await readFile(history), malformed);
});
test("oversized atlas input fails before dependency reads, journal changes or output", async () => {
  const f = await fixture();
  const epochs = Array.from({ length: 128 }, () => ({
    id: randomUUID(),
    title: "年代组",
    notes: "说".repeat(4000),
  }));
  const entries = Array.from({ length: 200 }, () => ({
    ...node({ id: randomUUID() }),
    notes: "明".repeat(4000),
  }));
  const pending = join(f.folder, ".zinovel/pending.json"),
    before = await readFile(pending);
  assert.throws(
    () => f.store.atlas.save(f.book.id, { ...empty(), epochs, entries }, null),
    /1MiB/,
  );
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.deepEqual(await readFile(pending), before);
});

test("paged atlas diagnostics keep missing, unreadable and same-name maps separate and return no geometry", async () => {
  const f = await fixture(),
    entries = [node(f.world)];
  for (let i = 0; i < 40; i++) entries.push(node(await f.map("同名地图")));
  await assert.rejects(
    f.store.atlas.save(f.book.id, { ...empty(), entries }, null),
    /40/,
  );
  let atlas = await f.store.atlas.save(
    f.book.id,
    { ...empty(), entries: entries.slice(0, 40) },
    null,
  );
  atlas = await f.store.atlas.save(
    f.book.id,
    { ...fields(atlas), entries },
    atlas,
  );
  const badFile = join(f.folder, "world/maps", entries[1].mapId + ".json");
  await writeFile(badFile, Buffer.from([0xc3, 0x28]));
  const page = await f.store.atlas.inspect(f.book.id),
    last = await f.store.atlas.inspect(f.book.id, { offset: 40 });
  assert.equal(page.total, 41);
  assert.equal(page.rows.length, 40);
  assert.equal(last.rows.length, 1);
  assert.equal(page.rows[1].state, "unreadable");
  assert.equal(page.rows[1].title, null);
  assert.equal(page.rows[0].entry.mapId, f.world.id);
  assert.equal(last.rows[0].entry.mapId, entries[40].mapId);
  assert.equal(JSON.stringify(page).includes('"elements"'), false);
  // The fixture's unlisted city is still an independent map; directory membership never deletes it.
  assert.equal((await readdir(join(f.folder, "world/maps"))).length, 42);
  const catalog = await f.store.maps.list(f.book.id);
  assert.equal(catalog.total, 41); // One deliberately unreadable map is disclosed separately.
  assert.equal(catalog.errors.length, 1);
  assert.equal((await f.store.maps.read(f.book.id, f.city.id)).id, f.city.id);
});
