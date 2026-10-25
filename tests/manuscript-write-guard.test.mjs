import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-manuscript-guard-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("写入边界合成稿", [
    { title: "旧信", body: "作者旧稿𠮷🌊\r\n不可丢失。" },
  ]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    folder = join(root, "library", book.id),
    path = join(folder, "manuscript", chapter.id + ".md");
  const input = {
    bookId: book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body: "作者待保存的新稿𠮷🌊",
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  };
  return { root, store, book, chapter, folder, path, input };
}
async function atCommit(f, edit, operation) {
  const original = BookStorageKernel.prototype.transaction;
  let observed = false;
  BookStorageKernel.prototype.transaction = async function (
    root,
    changes,
    options,
  ) {
    if (
      root === f.folder &&
      Object.hasOwn(changes, `manuscript/${f.chapter.id}.md`)
    ) {
      observed = true;
      await edit();
    }
    return original.call(this, root, changes, options);
  };
  try {
    await operation();
    assert.equal(observed, true);
  } finally {
    BookStorageKernel.prototype.transaction = original;
  }
}
test("external manuscript edit at the commit handoff survives a stale manual save", async () => {
  const f = await fixture(),
    external = "外部作者刚保存的正文𠮷🌊\r\n必须保留。";
  await atCommit(
    f,
    () => writeFile(f.path, external),
    async () => {
      await assert.rejects(f.store.saveChapter(f.input), /前像|已改变/);
      assert.equal(await readFile(f.path, "utf8"), external);
    },
  );
});
test("external book metadata at the commit handoff prevents both metadata overwrite and body save", async () => {
  const f = await fixture(),
    path = join(f.folder, "book.json"),
    book = JSON.parse(await readFile(path, "utf8"));
  book.title = "外部刚修改的书名";
  book.revision++;
  const external = JSON.stringify(book, null, 2) + "\n",
    body = await readFile(f.path);
  await atCommit(
    f,
    () => writeFile(path, external),
    async () => {
      await assert.rejects(f.store.saveChapter(f.input), /前像|已改变/);
      assert.equal(await readFile(path, "utf8"), external);
      assert.deepEqual(await readFile(f.path), body);
    },
  );
});
test("a receipt identity occupied after preflight is preserved without applying the manuscript", async () => {
  const f = await fixture(),
    id = randomUUID(),
    receipt = {
      id,
      taskId: randomUUID(),
      beforeHash: f.chapter.diskHash,
      afterHash: digest(f.input.body),
    };
  const path = join(f.folder, ".zinovel/task-receipts", id + ".json"),
    external = '{"future":"保留已占用回执𠮷🌊"}\n',
    body = await readFile(f.path);
  await mkdir(join(f.folder, ".zinovel/task-receipts"), { recursive: true });
  await atCommit(
    f,
    () => writeFile(path, external),
    async () => {
      await assert.rejects(
        f.store.saveChapter(f.input, receipt),
        /前像|已改变/,
      );
      assert.equal(await readFile(path, "utf8"), external);
      assert.deepEqual(await readFile(f.path), body);
    },
  );
});
test("a caller cannot replace the queued manuscript payload before its write begins", async () => {
  const f = await fixture(),
    intended = f.input.body,
    pending = f.store.saveChapter(f.input);
  f.input.body = "队列后的另一份文本，不属于原保存操作";
  await pending;
  assert.equal(await readFile(f.path, "utf8"), intended);
});

test("an empty occupied receipt is never treated as absent", async () => {
  const f = await fixture(),
    id = randomUUID(),
    receipt = {
      id,
      taskId: randomUUID(),
      beforeHash: f.chapter.diskHash,
      afterHash: digest(f.input.body),
    };
  const path = join(f.folder, ".zinovel/task-receipts", id + ".json"),
    body = await readFile(f.path),
    metadata = await readFile(join(f.folder, "book.json"));
  await mkdir(join(f.folder, ".zinovel/task-receipts"), { recursive: true });
  await writeFile(path, "");
  await assert.rejects(f.store.saveChapter(f.input, receipt), /回执已存在/);
  assert.equal(await readFile(path, "utf8"), "");
  assert.deepEqual(await readFile(f.path), body);
  assert.deepEqual(await readFile(join(f.folder, "book.json")), metadata);
});

test("the accepted receipt is captured with its queued manuscript", async () => {
  const f = await fixture(),
    id = randomUUID(),
    taskId = randomUUID(),
    receipt = {
      id,
      taskId,
      beforeHash: f.chapter.diskHash,
      afterHash: digest(f.input.body),
    };
  const pending = f.store.saveChapter(f.input, receipt);
  receipt.id = randomUUID();
  receipt.taskId = randomUUID();
  receipt.afterHash = digest("another version");
  const saved = await pending;
  assert.equal(saved.status, "saved");
  const recorded = JSON.parse(
    await readFile(
      join(f.folder, ".zinovel/task-receipts", id + ".json"),
      "utf8",
    ),
  );
  assert.equal(recorded.id, id);
  assert.equal(recorded.taskId, taskId);
  assert.equal(recorded.afterHash, digest(f.input.body));
  assert.equal(await readFile(f.path, "utf8"), f.input.body);
});
