import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";

async function fixture() {
  const library = await mkdtemp(join(tmpdir(), "novel-structure-guard-"));
  const store = new NovelStore(library);
  const book = await store.importBook("目录写入合成书", [
    { title: "原章", body: "不能丢失的正文𠮷🙂\r\n", volume: "原卷" },
  ]);
  const root = join(library, book.id);
  return { library, store, book, root, metadata: join(root, "book.json") };
}
async function atCommit(f, edit, operation) {
  const original = BookStorageKernel.prototype.transaction;
  let observed = false;
  BookStorageKernel.prototype.transaction = async function (
    root,
    changes,
    options,
  ) {
    if (root === f.root && Object.hasOwn(changes, "book.json")) {
      observed = true;
      await edit(changes);
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
test("structure refuses an external same-revision book change at transaction handoff", async () => {
  const f = await fixture();
  const external =
    JSON.stringify({ ...f.book, title: "外部作者修改" }, null, 2) + "\n";
  await atCommit(
    f,
    () => writeFile(f.metadata, external),
    async () => {
      await assert.rejects(
        f.store.updateStructure(f.book.id, f.book.revision, {
          type: "chapter-trash",
          chapterId: f.book.chapters[0].id,
        }),
        /前像|已改变/,
      );
      assert.equal(await readFile(f.metadata, "utf8"), external);
      assert.equal(
        await readFile(
          join(f.root, "manuscript", f.book.chapters[0].id + ".md"),
          "utf8",
        ),
        "不能丢失的正文𠮷🙂\r\n",
      );
    },
  );
});
test("chapter creation preserves an external book change and creates no orphan manuscript", async () => {
  const f = await fixture(),
    before = await readdir(join(f.root, "manuscript"));
  const external =
    JSON.stringify({ ...f.book, title: "创建期间外部书名" }) + "\n";
  await atCommit(
    f,
    () => writeFile(f.metadata, external),
    async () => {
      await assert.rejects(
        f.store.createChapter(f.book.id, "新章"),
        /前像|已改变/,
      );
      assert.equal(await readFile(f.metadata, "utf8"), external);
      assert.deepEqual(await readdir(join(f.root, "manuscript")), before);
    },
  );
});
test("a newly occupied manuscript identity is not overwritten by createChapter", async () => {
  const f = await fixture(),
    before = await readFile(f.metadata);
  let occupied;
  await atCommit(
    f,
    async (changes) => {
      occupied = join(
        f.root,
        Object.keys(changes).find((p) => p.startsWith("manuscript/")),
      );
      await mkdir(join(f.root, "manuscript"), { recursive: true });
      await writeFile(occupied, "已占用的新章身份𠮷🙂");
    },
    async () => {
      await assert.rejects(
        f.store.createChapter(f.book.id, "新章"),
        /前像|已改变/,
      );
      assert.equal(await readFile(occupied, "utf8"), "已占用的新章身份𠮷🙂");
      assert.deepEqual(await readFile(f.metadata), before);
    },
  );
});
test("queued structure mutation captures the author request before yielding", async () => {
  const f = await fixture(),
    mutation = {
      type: "volume-rename",
      volumeId: f.book.volumes[0].id,
      title: "作者确认卷名",
    };
  const pending = f.store.updateStructure(f.book.id, f.book.revision, mutation);
  mutation.title = "调用后被换掉的卷名";
  const saved = await pending;
  assert.equal(saved.volumes[0].title, "作者确认卷名");
});
