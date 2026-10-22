import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeThreeWay } from "../packages/novel-domain/merge.mjs";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";

test("three-way merge combines disjoint changes and leaves overlaps for explicit review", () => {
  const base = "🙂旧港。\n中间不变。\n旧信。";
  const merged = mergeThreeWay(
    base,
    base.replace("旧港", "新港"),
    base.replace("旧信", "长信"),
  );
  assert.equal(merged.automatic, true);
  assert.equal(merged.body, "🙂新港。\n中间不变。\n长信。");
  assert.equal(mergeThreeWay("甲", "甲乙", "甲丙").automatic, false);
  assert.equal(mergeThreeWay("甲乙", "甲", "甲丙").automatic, false);
  assert.equal(mergeThreeWay(null, "本地", "磁盘").automatic, false);
  assert.equal(mergeThreeWay("甲", "甲", "乙").body, "乙");
  const emoji = mergeThreeWay("🙂|🌊", "🙃|🌊", "🙂|🌧");
  assert.equal(emoji.body, "🙃|🌧");
  assert.equal(emoji.automatic, true);
});

test("choosing either conflict side durably preserves base/local/remote; stale remote cannot be accepted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new NovelStore(root),
    base = "共同原稿。";
  const book = await store.importBook("合成冲突", [
      { title: "开头", body: base },
    ]),
    chapterId = book.chapters[0].id;
  const file = join(root, book.id, "manuscript", `${chapterId}.md`),
    remote = "磁盘改稿。",
    local = "本地改稿。";
  await writeFile(file, remote);
  const input = {
    bookId: book.id,
    chapterId,
    expectedRemoteHash: digest(remote),
    expectedRemoteRevision: 1,
    localBody: local,
    localTitle: "开头",
    baseBody: base,
  };
  await store.archiveConflict(input);
  assert.equal(await readFile(file, "utf8"), remote);
  const history = await new NovelStore(root).history(book.id, chapterId);
  for (const body of [base, local, remote])
    assert.ok(history.some((version) => version.body === body));
  await writeFile(file, "磁盘第二次修改。");
  await assert.rejects(store.archiveConflict(input), /再次改变/);
  assert.equal(await readFile(file, "utf8"), "磁盘第二次修改。");
});
