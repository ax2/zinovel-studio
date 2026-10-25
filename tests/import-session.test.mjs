import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportSessions } from "../packages/novel-storage/import-session.mjs";
import { NovelStore } from "../packages/novel-storage/store.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zinovel-import-review-"));
  const file = join(dir, "合成稿.txt"),
    body = "第一卷 海港\n第一章 信\n甲𠮷🙂乙\n第二章 灯\n尾声";
  await writeFile(file, body);
  const commits = [],
    sessions = new ImportSessions({
      createBook: async (title, chapters) => {
        commits.push({ title, chapters });
        return { id: "synthetic", chapters };
      },
    });
  const selected = await sessions.choose([file]);
  return { sessions, selected, file, body, commits };
}

test("manual split/rename/merge conserves Unicode body and only final confirmed revision is imported", async () => {
  const { sessions, selected, file, body, commits } = await fixture();
  const first = selected.preview.chapters[0],
    baseline = JSON.stringify(selected);
  let result = sessions.edit(selected.id, selected.revision, {
    type: "split",
    chapterId: first.id,
    offset: 3,
    title: "第二段",
  });
  assert.equal(result.preview.chapters[0].body, "甲𠮷");
  assert.equal(result.preview.chapters[1].body, "🙂乙");
  assert.equal(result.preview.chapters[0].id, first.id);
  assert.notEqual(result.preview.chapters[1].id, first.id);
  result = sessions.edit(result.id, result.revision, {
    type: "rename",
    chapterId: first.id,
    title: "新章名",
    volume: "新卷名",
  });
  result = sessions.edit(result.id, result.revision, {
    type: "merge-next",
    chapterId: first.id,
    separator: "",
  });
  assert.equal(result.preview.chapters[0].body, first.body);
  assert.equal(result.preview.chapters[0].title, "新章名");
  assert.equal(result.preview.chapters[0].volume, "新卷名");
  assert.equal(
    result.preview.totalCharacters,
    selected.preview.totalCharacters,
  );
  assert.equal(JSON.stringify(selected), baseline);
  await assert.rejects(
    sessions.commit(selected.id, selected.revision, "旧预览不得提交"),
    /已经改变/,
  );
  assert.equal(commits.length, 0);
  await sessions.commit(result.id, result.revision, "明确确认的作品");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].chapters[0].body, first.body);
  assert.equal(await readFile(file, "utf8"), body);
  await assert.rejects(
    sessions.commit(result.id, result.revision, "重复"),
    /失效/,
  );
});

test("invalid split, stale/missing IDs and malformed labels cannot mutate an accepted preview", async () => {
  const { sessions, selected } = await fixture(),
    chapterId = selected.preview.chapters[0].id;
  for (const offset of [0, -1, 2, 4, 6, 1.5, "3"]) {
    assert.throws(() =>
      sessions.edit(selected.id, selected.revision, {
        type: "split",
        chapterId,
        offset,
        title: "后半",
      }),
    );
  }
  for (const title of ["", "\ud800", "a\nb", "x".repeat(201)])
    assert.throws(() =>
      sessions.edit(selected.id, selected.revision, {
        type: "rename",
        chapterId,
        title,
        volume: "",
      }),
    );
  assert.throws(
    () =>
      sessions.edit(selected.id, selected.revision, {
        type: "split",
        chapterId: "other",
        offset: 1,
        title: "x",
      }),
    /失效/,
  );
  assert.throws(
    () =>
      sessions.edit(selected.id, selected.revision, {
        type: "merge-next",
        chapterId,
        separator: "arbitrary replacement",
      }),
    /分隔/,
  );
  const result = await sessions.commit(
    selected.id,
    selected.revision,
    "原预览",
  );
  assert.equal(result.chapters[0].body, "甲𠮷🙂乙");
});

test("reset returns exact original frozen chapter IDs/body/metadata without re-reading changed source", async () => {
  const { sessions, selected, file } = await fixture(),
    first = selected.preview.chapters[0];
  let edited = sessions.edit(selected.id, selected.revision, {
    type: "merge-next",
    chapterId: first.id,
    separator: "\n\n",
  });
  assert.equal(edited.preview.chapters.length, 1);
  assert.equal(edited.preview.chapters[0].body, first.body + "\n\n尾声");
  await writeFile(file, "外部最新稿");
  edited = sessions.edit(edited.id, edited.revision, { type: "reset" });
  assert.deepEqual(edited.preview, selected.preview);
  assert.notEqual(edited.revision, selected.revision);
  assert.equal(await readFile(file, "utf8"), "外部最新稿");
});

test("host snapshots cannot be changed through response objects, and a fresh preview revokes even the original token", async () => {
  const { sessions, selected, file } = await fixture(),
    original = selected.preview.chapters[0].body;
  selected.preview.chapters[0].body = "renderer tampering";
  selected.preview.sources[0].sha256 = "tampering";
  const result = sessions.edit(selected.id, selected.revision, {
    type: "reset",
  });
  assert.equal(result.preview.chapters[0].body, original);
  assert.match(result.preview.sources[0].sha256, /^[a-f0-9]{64}$/);
  await writeFile(file, "新的未分章稿");
  const fresh = await sessions.preview(selected.id, "utf-8", false);
  await assert.rejects(
    sessions.commit(selected.id, selected.revision, "旧"),
    /已经改变/,
  );
  assert.equal(
    (await sessions.commit(fresh.id, fresh.revision, "新")).chapters[0].body,
    "新的未分章稿",
  );
});

test("overlapping reads cannot replace the latest requested preview or leave a stale failed preview committable", async () => {
  const resolvers = [],
    preview = () => new Promise((resolve) => resolvers.push(resolve));
  const sessions = new ImportSessions({
    preview,
    createBook: async () => ({}),
  });
  const sample = (text) => ({
    chapters: [{ title: "章", volume: "", body: text }],
    sources: [],
    encoding: "utf-8",
    split: false,
  });
  const choosing = sessions.choose(["native-selected"]);
  resolvers.shift()(sample("initial"));
  const selected = await choosing;
  const earlier = sessions.preview(selected.id, "utf-8", true);
  const rejected = assert.rejects(earlier, /已经改变/);
  const later = sessions.preview(selected.id, "utf-8", false);
  resolvers[1](sample("latest"));
  const result = await later;
  resolvers[0](sample("out-of-order earlier"));
  await rejected;
  assert.equal(
    sessions.edit(result.id, result.revision, { type: "reset" }).preview
      .chapters[0].body,
    "latest",
  );
});

test("a pending commit blocks duplicate writes, and failed creation preserves the same preview for retry", async () => {
  let settle,
    calls = 0;
  const sessions = new ImportSessions({
    preview: async () => ({
      chapters: [{ title: "章", volume: "", body: "稿" }],
      sources: [],
    }),
    createBook: () => {
      calls++;
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
  });
  const selected = await sessions.choose(["native-selected"]);
  const pending = sessions.commit(selected.id, selected.revision, "书");
  const failed = assert.rejects(pending, /disk failure/);
  await assert.rejects(
    sessions.commit(selected.id, selected.revision, "重复"),
    /正在创建/,
  );
  await assert.rejects(
    sessions.preview(selected.id, "utf-8", false),
    /正在创建/,
  );
  settle.reject(new Error("disk failure"));
  await failed;
  const retry = sessions.commit(selected.id, selected.revision, "重试");
  settle.resolve({ id: "once" });
  assert.deepEqual(await retry, { id: "once" });
  assert.equal(calls, 2);
});

test("choosing a sixth session expires the old token instead of using another session's chapters", async () => {
  const { sessions, selected, file } = await fixture();
  for (let i = 0; i < 5; i++) await sessions.choose([file]);
  await assert.rejects(
    sessions.commit(selected.id, selected.revision, "已过期"),
    /失效/,
  );
});

test("an oversized chapter fails before creating a book, then manual split retries against the same frozen source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zinovel-import-large-review-")),
    source = join(dir, "未分章原稿.txt");
  const body = "甲".repeat(3 * 1024 * 1024);
  await writeFile(source, body);
  const store = new NovelStore(join(dir, "library"));
  await store.initialize();
  const sessions = new ImportSessions({
    createBook: (title, chapters) => store.importBook(title, chapters),
  });
  const selected = await sessions.choose([source]);
  await assert.rejects(
    sessions.commit(selected.id, selected.revision, "需拆分的大稿"),
    /单章过大/,
  );
  assert.equal((await store.listBooks()).books.length, 0);
  const divided = sessions.edit(selected.id, selected.revision, {
    type: "split",
    chapterId: selected.preview.chapters[0].id,
    offset: body.length / 2,
    title: "后半章",
  });
  const book = await sessions.commit(
    divided.id,
    divided.revision,
    "分章后确认",
  );
  assert.equal(book.chapters.length, 2);
  const contents = await Promise.all(
    book.chapters.map((chapter) => store.readChapter(book.id, chapter.id)),
  );
  assert.equal(contents.map((chapter) => chapter.body).join(""), body);
  assert.equal(await readFile(source, "utf8"), body);
});
