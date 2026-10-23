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
import { NovelStore } from "../packages/novel-storage/store.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-pilots-")),
    library = join(root, "library"),
    store = new NovelStore(library),
    book = await store.importBook("试写合成作品", [
      { title: "正式首章", body: "首章必须保留 🌧️\r\n原始字节。" },
    ]),
    source = await store.materials.save(book.id, {
      kind: "idea",
      title: "码头取信",
      status: "planned",
      fields: {},
      notes: "取回旧信",
      chapterIds: [],
    }),
    group = await store.pilots.createGroup(book.id, {
      title: "雨夜同场景",
      scene: "追上即将离港的信使",
      sourceIds: [source.id],
    }),
    input = {
      title: "第一人称",
      pov: "林舟 / 第一人称",
      voice: "急促短句",
      action: "追上信使",
      obstacle: "渡船离港",
      promise: "解开父亲失踪之谜",
      body: "我冲下栈桥。🌧️\r\n船已经开了。",
    },
    pilot = await store.pilots.save(book.id, group.id, input);
  return {
    root,
    library,
    store,
    book,
    group,
    source,
    input,
    pilot,
    path: join(library, book.id, "pilots", `${pilot.id}.md`),
  };
}
test("same-scene branches remain independent; selection and feedback retain exact versions; promotion creates one new chapter", async () => {
  const { store, book, group, pilot, input, root } = await fixture(),
    before = await store.readChapter(book.id, book.chapters[0].id),
    branch = await store.pilots.save(
      book.id,
      group.id,
      {
        ...input,
        title: "第三人称",
        pov: "第三人称",
        voice: "克制",
        body: "他站在栈桥尽头。",
      },
      null,
      pilot,
    );
  assert.equal(branch.parent.id, pilot.id);
  assert.equal(branch.parent.bodyHash, pilot.bodyHash);
  let chosen = await store.pilots.choose(
    book.id,
    group,
    branch,
    "人物行动更明确",
  );
  assert.equal(chosen.selectionState, "current");
  const feedback = await store.pilots.addFeedback(book.id, branch, {
    source: "合成试读者甲 / 自愿反馈",
    comment: "想知道他为何不登船。",
  });
  const revised = await store.pilots.save(
    book.id,
    group.id,
    { ...branch, body: branch.body + "他退了一步。" },
    branch,
  );
  chosen = await store.pilots.readGroup(book.id, group.id);
  assert.equal(chosen.selectionState, "stale");
  assert.equal(chosen.selection.snapshot.body, branch.body);
  assert.equal(
    (await store.pilots.versions(book.id, branch.id, true))[0].snapshot.body,
    feedback.snapshot.body,
  );
  assert.equal((await store.pilots.read(book.id, pilot.id)).body, pilot.body);
  const result = await store.pilots.promote(book.id, revised, "雨港试写定稿");
  const repeat = await store.pilots.promote(book.id, revised, "不能重复插入");
  assert.equal(repeat.reused, true);
  assert.equal(result.chapterId, repeat.chapterId);
  assert.equal(repeat.book.chapters.length, 2);
  assert.equal(
    (await store.readChapter(book.id, result.chapterId)).body,
    revised.body,
  );
  assert.deepEqual(
    await store.readChapter(book.id, book.chapters[0].id),
    before,
  );
  const backup = await store.createBackup(book.id, join(root, "backups")),
    restored = await store.restoreBackup(backup.path);
  assert.notEqual(restored.id, book.id);
  assert.deepEqual(await store.pilots.read(restored.id, branch.id), revised);
  assert.deepEqual(await store.pilots.readGroup(restored.id, group.id), chosen);
  assert.deepEqual(await store.pilots.versions(restored.id, branch.id, true), [
    feedback,
  ]);
  assert.equal(
    (await store.pilots.promote(restored.id, revised, "恢复后的同版本"))
      .chapterId,
    result.chapterId,
  );
});
test("CAS checks metadata AND body; same revision external edits preserved, Unicode rejected intact, foreign references refused", async () => {
  const { store, book, group, pilot, input, path, library } = await fixture();
  await writeFile(path, pilot.body + "\n外部修改");
  for (const operation of [
    () => store.pilots.save(book.id, group.id, input, pilot),
    () => store.pilots.choose(book.id, group, pilot, "旧决定"),
    () =>
      store.pilots.addFeedback(book.id, pilot, {
        source: "甲",
        comment: "旧反馈",
      }),
    () => store.pilots.promote(book.id, pilot, "过期稿"),
    () => store.pilots.setDeleted(book.id, pilot, true),
    () => store.pilots.save(book.id, group.id, input, null, pilot),
  ])
    await assert.rejects(operation, /外部编辑/);
  let fresh = await store.pilots.read(book.id, pilot.id);
  assert.equal(fresh.externalChange, true);
  const metadata = join(library, book.id, "pilots", `${pilot.id}.json`),
    raw = await readFile(metadata, "utf8");
  await writeFile(metadata, raw + "\n");
  await assert.rejects(
    store.pilots.save(book.id, group.id, input, fresh),
    /外部编辑/,
  );
  fresh = await store.pilots.read(book.id, pilot.id);
  await assert.rejects(
    async () =>
      store.pilots.save(
        book.id,
        group.id,
        { ...input, body: "bad\ud800" },
        fresh,
      ),
    /完整文本/,
  );
  assert.equal(await readFile(path, "utf8"), pilot.body + "\n外部修改");
  assert.equal(await readFile(metadata, "utf8"), raw + "\n");
  const other = await store.createBook("另一本"),
    otherGroup = await store.pilots.createGroup(book.id, {
      title: "别的场景",
      scene: "登山",
    });
  await assert.rejects(store.pilots.read(other.id, pilot.id), /ENOENT/);
  await assert.rejects(
    store.pilots.save(book.id, otherGroup.id, input, fresh),
    /不属于/,
  );
  await assert.rejects(
    store.pilots.choose(book.id, otherGroup, fresh, "错误组"),
    /不属于/,
  );
  await assert.rejects(
    store.pilots.createGroup(other.id, {
      title: "别的",
      scene: "任务",
      sourceIds: [randomUUID()],
    }),
    /ENOENT/,
  );
  await assert.rejects(store.pilots.read(book.id, "../../outside"), /标识/);
});
test("source snapshots stay frozen while freshness changes; deletion is reversible and invalid records are reported", async () => {
  const { store, book, group, pilot, source, library } = await fixture();
  await store.materials.save(
    book.id,
    { ...source, notes: "改成另一封信" },
    source,
  );
  const freshGroup = await store.pilots.readGroup(book.id, group.id);
  assert.equal(freshGroup.sources[0].freshness, "stale");
  assert.equal(freshGroup.sources[0].data.notes, source.notes);
  const chosen = await store.pilots.choose(
    book.id,
    freshGroup,
    pilot,
    "保留第一人称",
  );
  await assert.rejects(
    store.pilots.choose(book.id, group, pilot, "旧组版本"),
    /外部编辑/,
  );
  const deleted = await store.pilots.setDeleted(book.id, pilot, true);
  assert.equal(
    (await store.pilots.readGroup(book.id, group.id)).selectionState,
    "deleted",
  );
  assert.equal(
    (await store.pilots.list(book.id, group.id)).items[0].deletedAt,
    deleted.deletedAt,
  );
  await assert.rejects(
    store.pilots.promote(book.id, deleted, "不能转章"),
    /恢复/,
  );
  const restored = await store.pilots.setDeleted(book.id, deleted, false);
  assert.equal(restored.id, pilot.id);
  assert.equal(restored.body, pilot.body);
  assert.equal(
    (await store.pilots.readGroup(book.id, group.id)).selectionState,
    "stale",
  );
  assert.equal(chosen.selection.snapshot.body, restored.body);
  const badId = randomUUID();
  await writeFile(
    join(library, book.id, "pilots", `${badId}.json`),
    "not json",
  );
  const listed = await store.pilots.list(book.id, group.id);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.errors[0].id, badId);
  assert.equal((await store.pilots.listGroups(book.id)).items[0].id, group.id);
});
test("partial multi-file trial save rolls forward on restart and retains prior version", async () => {
  const { store, book, pilot, path, library } = await fixture(),
    metaPath = join(library, book.id, "pilots", `${pilot.id}.json`),
    raw = await readFile(metaPath, "utf8"),
    data = JSON.parse(raw),
    nextBody = "事务恢复后的稿 🌊",
    history = `.zinovel/pilot-history/${pilot.id}/interrupted.json`;
  const { digest } = await import("../packages/novel-storage/store.mjs");
  data.revision++;
  data.hash = digest(nextBody);
  const after = JSON.stringify(data),
    pending = {
      id: randomUUID(),
      entries: [
        { path: `pilots/${pilot.id}.json`, before: raw, after },
        { path: `pilots/${pilot.id}.md`, before: pilot.body, after: nextBody },
        { path: history, before: null, after: raw },
      ],
    };
  await writeFile(
    join(library, book.id, ".zinovel", "pending.json"),
    JSON.stringify(pending),
  );
  await writeFile(metaPath, after);
  const restarted = new NovelStore(library),
    recovered = await restarted.pilots.read(book.id, pilot.id);
  assert.equal(recovered.body, nextBody);
  assert.equal(recovered.revision, pilot.revision + 1);
  assert.equal(recovered.externalChange, false);
  assert.equal(await readFile(join(library, book.id, history), "utf8"), raw);
  assert.equal(await readFile(path, "utf8"), nextBody);
  assert.equal(
    await readFile(join(library, book.id, ".zinovel", "pending.json"), "utf8"),
    "",
  );
});
test("invalid UTF-8, unsupported schema and linked directories are refused without mutation", async () => {
  const { store, book, pilot, input, group, path, library, root } =
    await fixture();
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    store.pilots.read(book.id, pilot.id),
    /encoded|encoding|UTF/i,
  );
  assert.deepEqual(await readFile(path), Buffer.from([0xc3, 0x28]));
  await writeFile(path, pilot.body);
  const metaPath = join(library, book.id, "pilots", `${pilot.id}.json`),
    raw = JSON.parse(await readFile(metaPath, "utf8"));
  raw.schemaVersion = 2;
  await writeFile(metaPath, JSON.stringify(raw));
  await assert.rejects(
    store.pilots.save(book.id, group.id, input, pilot),
    /版本不支持/,
  );
  const other = await store.createBook("链接边界"),
    external = join(root, "external");
  await mkdir(external);
  await symlink(external, join(library, other.id, "pilots"), "junction");
  await assert.rejects(
    store.pilots.createGroup(other.id, {
      title: "链接",
      scene: "不能写出作品",
    }),
    /链接/,
  );
  assert.deepEqual(await readdir(external), []);
});
