import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { BookStorageKernel } from "../packages/novel-storage/kernel.mjs";

async function fixture() {
  const library = await mkdtemp(join(tmpdir(), "novel-annotation-guard-"));
  const store = new NovelStore(library);
  const book = await store.importBook("批注写入合成书", [
    { title: "原章", body: "正文𠮷🙂原始证据" },
  ]);
  const root = join(library, book.id),
    chapterId = book.chapters[0].id;
  const state = await store.readAnnotations(book.id, chapterId);
  const mutation = {
    type: "create",
    kind: "note",
    title: "作者批注",
    text: "原意",
    start: 0,
    end: 2,
  };
  const save = () =>
    store.mutateAnnotations(
      book.id,
      chapterId,
      state.revision,
      state.metadataHash,
      state.bodyHash,
      mutation,
    );
  return {
    library,
    store,
    book,
    root,
    chapterId,
    mutation,
    save,
    path: join(root, "annotations", chapterId + ".json"),
  };
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
      root === f.root &&
      Object.hasOwn(changes, `annotations/${f.chapterId}.json`)
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
test("an occupied annotation file survives the transaction handoff", async () => {
  const f = await fixture(),
    external = '{"future":"外部批注原件"}\n';
  await atCommit(
    f,
    async () => {
      await mkdir(join(f.root, "annotations"), { recursive: true });
      await writeFile(f.path, external);
    },
    async () => {
      await assert.rejects(f.save(), /前像|已改变/);
      assert.equal(await readFile(f.path, "utf8"), external);
    },
  );
});
test("a body change at annotation commit rejects the stale anchor without writing annotations", async () => {
  const f = await fixture(),
    body = join(f.root, "manuscript", f.chapterId + ".md");
  await atCommit(
    f,
    () => writeFile(body, "外部新正文"),
    async () => {
      await assert.rejects(f.save(), /前像|已改变/);
      assert.equal(await readFile(body, "utf8"), "外部新正文");
      await assert.rejects(access(f.path), { code: "ENOENT" });
    },
  );
});
test("a concurrent chapter trash refuses annotation commit and preserves book bytes", async () => {
  const f = await fixture(),
    path = join(f.root, "book.json");
  const changed = structuredClone(f.book);
  changed.chapters[0].deletedAt = new Date().toISOString();
  const external = JSON.stringify(changed) + "\n";
  await atCommit(
    f,
    () => writeFile(path, external),
    async () => {
      await assert.rejects(f.save(), /前像|已改变/);
      assert.equal(await readFile(path, "utf8"), external);
      await assert.rejects(access(f.path), { code: "ENOENT" });
    },
  );
});
test("an empty occupied annotation file is rejected and preserved", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "annotations"), { recursive: true });
  await writeFile(f.path, "");
  await assert.rejects(f.save());
  assert.equal(await readFile(f.path, "utf8"), "");
});
test("queued annotation mutation captures the original author request", async () => {
  const f = await fixture(),
    pending = f.save();
  f.mutation.text = "调用之后另一个请求";
  await pending;
  const state = await f.store.readAnnotations(f.book.id, f.chapterId);
  assert.equal(state.items[0].text, "原意");
});

test("read-only dependency guards never rewrite or journal their inputs", async () => {
  const f = await fixture(),
    kernel = new BookStorageKernel(f.library);
  const bookRaw = await readFile(join(f.root, "book.json"), "utf8");
  await kernel.exclusive(() =>
    kernel.transaction(
      f.root,
      { "dependency-test.json": "{}\n" },
      {
        expectedBefore: { "dependency-test.json": null },
        expectedReadOnly: { "book.json": bookRaw },
      },
    ),
  );
  assert.equal(await readFile(join(f.root, "book.json"), "utf8"), bookRaw);
  const { readdir } = await import("node:fs/promises");
  const folder = join(f.root, ".zinovel/transactions");
  for (const name of await readdir(folder)) {
    const record = JSON.parse(await readFile(join(folder, name), "utf8"));
    if (record.entries.some((e) => e.path === "dependency-test.json"))
      assert.deepEqual(
        record.entries.map((e) => e.path),
        ["dependency-test.json"],
      );
  }
});

test("invalid read-only guard conditions refuse changes without creating a journal", async () => {
  const f = await fixture(),
    kernel = new BookStorageKernel(f.library);
  const pending = await readFile(join(f.root, ".zinovel/pending.json"));
  for (const expectedReadOnly of [
    null,
    [],
    { "probe.json": "" },
    { "book.json": null },
    { "../outside": "" },
  ]) {
    await assert.rejects(
      kernel.exclusive(() =>
        kernel.transaction(
          f.root,
          { "probe.json": "{}" },
          { expectedReadOnly },
        ),
      ),
    );
    await assert.rejects(access(join(f.root, "probe.json")), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await readFile(join(f.root, ".zinovel/pending.json")),
      pending,
    );
  }
});

test(
  "Windows case aliases cannot make a read-only dependency writable",
  { skip: process.platform !== "win32" },
  async () => {
    const f = await fixture(),
      kernel = new BookStorageKernel(f.library);
    const path = join(f.root, "book.json"),
      before = await readFile(path, "utf8");
    await assert.rejects(
      kernel.exclusive(() =>
        kernel.transaction(
          f.root,
          { "book.json": "{}" },
          {
            expectedReadOnly: { "BOOK.JSON": before },
          },
        ),
      ),
      /只读前像/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  },
);
