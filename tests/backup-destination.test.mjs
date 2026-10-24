import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-backup-destination-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("备份目标合成书", [
    { title: "旧信", body: "原稿𠮷🌊不因备份别名改变。" },
  ]);
  return { root, store, book, bookRoot: join(root, "library", book.id) };
}
for (const missingChild of [false, true])
  test(`backup refuses a directory alias into the source book before creating files (${missingChild ? "prospective child" : "existing root"})`, async () => {
    const f = await fixture(),
      alias = join(f.root, "looks-outside-library");
    await symlink(
      f.bookRoot,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const before = await readdir(f.bookRoot),
      manuscript = join(
        f.bookRoot,
        "manuscript",
        `${f.book.chapters[0].id}.md`,
      ),
      bytes = await readFile(manuscript);
    await assert.rejects(
      f.store.createBackup(
        f.book.id,
        missingChild ? join(alias, "not-created-yet") : alias,
      ),
      /内部|原书|源作品/,
    );
    assert.deepEqual(await readdir(f.bookRoot), before);
    assert.deepEqual(await readFile(manuscript), bytes);
  });
test("a genuinely external directory alias and a missing child remain valid backup destinations", async () => {
  const f = await fixture(),
    external = join(f.root, "external-storage"),
    alias = join(f.root, "external-alias");
  await mkdir(external);
  await symlink(
    external,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await f.store.createBackup(
    f.book.id,
    join(alias, "new-parent"),
  );
  const actual = await realpath(result.path);
  assert.ok(!relative(external, actual).startsWith(".."));
  const restored = await f.store.restoreBackup(result.path);
  assert.notEqual(restored.id, f.book.id);
  assert.equal(
    (await f.store.readChapter(restored.id, restored.chapters[0].id)).body,
    "原稿𠮷🌊不因备份别名改变。",
  );
});
