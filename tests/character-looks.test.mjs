import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  characterLookInput,
  characterLookExpected,
} from "../packages/novel-domain/character-looks.mjs";

const choice = "confirm-portrait-choice-v1";
const expected = (r) =>
  r ? { revision: r.revision, diskHash: r.diskHash } : null;
const ref = (r) => ({ id: r.id, ...expected(r) });
const input = (title = "旧港少年𠮷🌊") => ({
  title,
  age: "约十六岁",
  outfit: "旧蓝外套",
  expression: "戒备",
  view: "正面",
  period: "第一卷",
  constraints: "左眉短疤",
  notes: "合成形象，不代表真实人物",
});
const material = (title = "林渡") => ({
  kind: "character",
  title,
  status: "planned",
  fields: { appearance: "蓝衣短疤" },
  notes: "合成",
  chapterIds: [],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-looks-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("人物形象合成作品", [
    { title: "旧港", body: "原稿𠮷🌊\r\n保持不变。" },
  ]);
  const character = await store.materials.save(book.id, material());
  const bytes = await sharp({
    create: { width: 48, height: 64, channels: 3, background: "#147b82" },
  })
    .png()
    .toBuffer();
  const assetInput = {
    title: "原始定妆候选",
    purpose: "portrait",
    source: "程序生成",
    rights: "合成验收",
    notes: "",
    linkedIds: [character.id],
  };
  const asset = await store.assets.import(book.id, bytes, assetInput),
    id = randomUUID();
  const folder = join(root, "library", book.id),
    path = join(folder, "world/character-looks", character.id + ".json");
  const save = (
    collection,
    fields = input(),
    image = ref(asset),
    entryId = id,
  ) =>
    store.characterLooks.save(
      book.id,
      ref(character),
      expected(collection?.record),
      entryId,
      fields,
      image,
    );
  const choose = (collection, entryId = id) =>
    store.characterLooks.choose(
      book.id,
      ref(character),
      expected(collection.record),
      entryId,
      choice,
    );
  return {
    root,
    store,
    book,
    character,
    asset,
    assetInput,
    bytes,
    folder,
    path,
    id,
    save,
    choose,
  };
}

test("appearance edits, resource replacements and manuscript work never silently replace an explicitly chosen frozen version", async () => {
  const f = await fixture();
  const body = await f.store.readChapter(f.book.id, f.book.chapters[0].id);
  assert.equal(
    (await f.store.characterLooks.read(f.book.id, f.character.id)).record,
    null,
  );
  let state = await f.save(null);
  assert.equal(state.record.selected, null);
  state = await f.choose(state);
  assert.equal(state.selectedEntry.input.title, input().title);
  const fixed = state.selectedEntry;
  state = await f.save(
    state,
    { ...input(), age: "三十岁", outfit: "灰色大衣" },
    null,
  );
  assert.equal(state.record.entries[0].revision, 2);
  assert.deepEqual(state.selectedEntry, fixed);
  const fixedPreview = await f.store.characterLooks.preview(
    f.book.id,
    f.character.id,
    expected(state.record),
    f.id,
    true,
  );
  assert.equal(fixedPreview.blob.sha256, f.asset.blob.sha256);
  const bytes2 = await sharp({
    create: { width: 32, height: 40, channels: 3, background: "#833c72" },
  })
    .png()
    .toBuffer();
  const changedAsset = await f.store.assets.replace(f.book.id, bytes2, f.asset);
  assert.notEqual(changedAsset.blob.sha256, fixed.asset.record.blob.sha256);
  const historicalPreview = await f.store.characterLooks.preview(
    f.book.id,
    f.character.id,
    expected(state.record),
    f.id,
    true,
  );
  assert.equal(historicalPreview.blob.sha256, fixed.asset.record.blob.sha256);
  state = await f.save(
    state,
    { ...input(), title: "新衣版本" },
    ref(changedAsset),
  );
  assert.deepEqual(state.selectedEntry, fixed);
  state = await f.choose(state);
  assert.equal(state.selectedEntry.input.title, "新衣版本");
  assert.equal(
    state.selectedEntry.asset.record.blob.sha256,
    changedAsset.blob.sha256,
  );
  assert.equal((await f.store.readChapter(f.book.id, body.id)).body, body.body);
  assert.deepEqual(
    (
      await new NovelStore(join(f.root, "library")).characterLooks.read(
        f.book.id,
        f.character.id,
      )
    ).selectedEntry,
    state.selectedEntry,
  );
});

test("queued inputs are captured, concurrent stale saves reject, and character baseline changes require a fresh author review", async () => {
  const f = await fixture();
  let release;
  const held = f.store.characterLooks.storage.exclusive(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  await new Promise((done) => setImmediate(done));
  const fields = input(),
    image = ref(f.asset),
    character = ref(f.character);
  const saving = f.store.characterLooks.save(
    f.book.id,
    character,
    null,
    f.id,
    fields,
    image,
  );
  fields.title = "不应进入队列";
  image.id = randomUUID();
  character.id = randomUUID();
  release();
  await held;
  let state = await saving;
  assert.equal(state.record.entries[0].input.title, input().title);
  const results = await Promise.allSettled([
    f.save(state, input("A"), null),
    f.save(state, input("B"), null),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /其他操作/,
  );
  state = await f.store.characterLooks.read(f.book.id, f.character.id);
  const before = await readFile(f.path);
  await f.store.materials.save(
    f.book.id,
    { ...material(), notes: "人物已改" },
    f.character,
  );
  await assert.rejects(f.choose(state), /人物资料已改变/);
  assert.deepEqual(await readFile(f.path), before);
});

test("cross-character, wrong-purpose, foreign-book, missing-confirmation and malformed Unicode requests never choose an image", async () => {
  const f = await fixture(),
    other = await f.store.materials.save(f.book.id, material("另一人物"));
  await assert.rejects(
    f.store.characterLooks.save(
      f.book.id,
      ref(other),
      null,
      randomUUID(),
      input(),
      ref(f.asset),
    ),
    /关联此人物/,
  );
  const cover = await f.store.assets.import(f.book.id, f.bytes, {
    ...f.assetInput,
    purpose: "cover",
  });
  await assert.rejects(f.save(null, input(), ref(cover)), /定妆资源/);
  const foreign = await f.store.createBook("另一作品");
  await assert.rejects(
    f.store.characterLooks.save(
      foreign.id,
      ref(f.character),
      null,
      randomUUID(),
      input(),
      ref(f.asset),
    ),
  );
  const state = await f.save(null),
    before = await readFile(f.path);
  assert.throws(
    () =>
      f.store.characterLooks.choose(
        f.book.id,
        ref(f.character),
        expected(state.record),
        f.id,
        "",
      ),
    /明确确认/,
  );
  assert.throws(
    () => characterLookInput({ ...input(), notes: "断字\ud800" }),
    /Unicode/,
  );
  assert.equal(
    characterLookInput({ ...input(""), notes: "\ud800" }, { draft: true })
      .title,
    "",
  );
  assert.throws(
    () => characterLookInput({ ...input(), path: "C:/private" }),
    /格式/,
  );
  assert.throws(
    () => characterLookExpected({ ...expected(state.record), future: 1 }),
    /格式/,
  );
  assert.deepEqual(await readFile(f.path), before);
});

test("selected appearances survive backup to a new book ID with historical image bytes and selection provenance intact", async () => {
  const f = await fixture();
  let state = await f.choose(await f.save(null));
  state = await f.save(state, { ...input(), outfit: "后来衣装" }, null);
  const backup = await f.store.createBackup(f.book.id, f.root),
    restored = await f.store.restoreBackup(backup.path);
  assert.notEqual(restored.id, f.book.id);
  const reopened = await f.store.characterLooks.read(
    restored.id,
    f.character.id,
  );
  assert.ok(reopened.selectedEntry);
  assert.equal(reopened.selectedError, null);
  assert.deepEqual(reopened.selectedEntry, state.selectedEntry);
  const restoredPreview = await f.store.characterLooks.preview(
    restored.id,
    f.character.id,
    expected(reopened.record),
    f.id,
    true,
  );
  assert.equal(restoredPreview.blob.sha256, f.asset.blob.sha256);
  assert.equal(reopened.record.bookId, f.book.id);
  assert.deepEqual(
    await readFile(
      join(
        f.root,
        "library",
        restored.id,
        "assets/blobs",
        f.asset.blob.sha256 + ".png",
      ),
    ),
    f.bytes,
  );
  const currentCharacter = await f.store.materials.read(
    restored.id,
    f.character.id,
  );
  const cleared = await f.store.characterLooks.choose(
    restored.id,
    ref(currentCharacter),
    expected(reopened.record),
    null,
    choice,
  );
  assert.equal(cleared.record.selected, null);
  const original = await f.store.characterLooks.read(f.book.id, f.character.id);
  assert.deepEqual(original.selectedEntry, state.selectedEntry);
});

test("a slow image preview releases the book queue and rejects an appearance selection changed during decode", async () => {
  const f = await fixture(),
    state = await f.choose(await f.save(null));
  const decode = f.store.assets.decode.bind(f.store.assets);
  let release, signal;
  const gate = new Promise((done) => {
      release = done;
    }),
    entered = new Promise((done) => {
      signal = done;
    });
  f.store.assets.decode = async (...args) => {
    signal();
    await gate;
    return decode(...args);
  };
  const preview = f.store.characterLooks.preview(
    f.book.id,
    f.character.id,
    expected(state.record),
    f.id,
    true,
  );
  await entered;
  const next = await f.save(state, input("预览中仍可保存形象"), null);
  release();
  await assert.rejects(preview, /其他操作/);
  assert.equal(next.record.entries[0].input.title, "预览中仍可保存形象");
  assert.equal(next.selectedEntry.input.title, input().title);
});

test("history corruption is visible and retained; future collections refuse overwrites rather than appearing empty", async () => {
  const f = await fixture(),
    state = await f.choose(await f.save(null));
  const selection = state.record.selected,
    history = join(
      f.folder,
      ".zinovel/character-look-history",
      f.character.id,
      `${selection.source.revision}-${selection.source.diskHash}.json`,
    );
  await writeFile(history, "{坏的历史");
  const before = await readFile(f.path),
    damaged = await f.store.characterLooks.read(f.book.id, f.character.id);
  assert.equal(damaged.selectedEntry, null);
  assert.ok(damaged.selectedError);
  assert.equal(damaged.record.selected.entryId, f.id);
  await assert.rejects(f.save(damaged, input("仍需保留"), null), /历史/);
  assert.deepEqual(await readFile(f.path), before);
  const future = JSON.stringify({
    ...state.record,
    diskHash: undefined,
    schemaVersion: 99,
  });
  await writeFile(f.path, future);
  await assert.rejects(
    f.store.characterLooks.read(f.book.id, f.character.id),
    /版本/,
  );
  await assert.rejects(f.save(state, input("不应写"), null), /版本/);
  assert.equal(await readFile(f.path, "utf8"), future);
});

test("explicit unselection is required before recycling and recycled image resources cannot become a new current portrait", async () => {
  const f = await fixture();
  let state = await f.choose(await f.save(null));
  await assert.rejects(
    f.store.characterLooks.setDeleted(
      f.book.id,
      f.character.id,
      expected(state.record),
      f.id,
      true,
    ),
    /先明确取消/,
  );
  state = await f.choose(state, null);
  state = await f.store.characterLooks.setDeleted(
    f.book.id,
    f.character.id,
    expected(state.record),
    f.id,
    true,
  );
  await assert.rejects(f.choose(state), /未回收/);
  state = await f.store.characterLooks.setDeleted(
    f.book.id,
    f.character.id,
    expected(state.record),
    f.id,
    false,
  );
  await f.store.assets.setDeleted(f.book.id, f.asset, true);
  await assert.rejects(f.choose(state), /图像资源已回收/);
  assert.equal(
    (await f.store.characterLooks.read(f.book.id, f.character.id)).record
      .selected,
    null,
  );
});

test("archived books and linked appearance directories reject writes and preserve all originals", async () => {
  const f = await fixture(),
    state = await f.save(null),
    before = await readFile(f.path);
  await f.store.updateStructure(f.book.id, f.book.revision, {
    type: "book-archive",
    archived: true,
  });
  await assert.rejects(f.choose(state), /归档/);
  assert.deepEqual(await readFile(f.path), before);
  const g = await fixture(),
    outside = join(g.root, "outside");
  await mkdir(outside);
  await mkdir(join(g.folder, "world"), { recursive: true });
  await symlink(
    outside,
    join(g.folder, "world/character-looks"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(g.save(null), /链接/);
});

for (const [stage, code] of [
  ["journal", 97],
  ["first-file", 98],
]) {
  test(`actual process exit after ${stage} recovers both fixed selection and its historical source once`, async () => {
    const f = await fixture();
    await f.save(null);
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/character-look-crash.mjs", import.meta.url),
        ),
        join(f.root, "library"),
        f.book.id,
        f.character.id,
        stage,
      ],
      { windowsHide: true, timeout: 20000, encoding: "utf8" },
    );
    assert.equal(child.status, code, child.stderr);
    const pending = JSON.parse(
      await readFile(join(f.folder, ".zinovel/pending.json"), "utf8"),
    );
    assert.equal(pending.entries.length, 2);
    const reopened = new NovelStore(join(f.root, "library"));
    const state = await reopened.characterLooks.read(f.book.id, f.character.id);
    assert.equal(state.record.selected.entryId, f.id);
    assert.equal(state.selectedEntry.input.title, input().title);
    assert.equal(state.selectedError, null);
    const after = await readFile(f.path);
    assert.deepEqual(
      (await reopened.characterLooks.read(f.book.id, f.character.id)).record,
      state.record,
    );
    assert.deepEqual(await readFile(f.path), after);
    assert.equal(
      await readFile(join(f.folder, ".zinovel/pending.json"), "utf8"),
      "",
    );
  });
}
