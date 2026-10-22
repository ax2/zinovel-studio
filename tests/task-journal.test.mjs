import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";

test("startup recovery reaches tasks beyond the bounded UI list", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-task-pages-"));
  const journal = new TaskJournal(root);
  for (let i = 0; i < 201; i++) {
    await journal.create(
      {
        id: randomUUID(),
        status: "preparing",
        startedAt: new Date(i * 1000).toISOString(),
      },
      { context: "合成任务" },
    );
  }
  assert.equal((await journal.list(undefined, 1000)).length, 200);
  assert.equal(await journal.recoverInterrupted(), 201);
  assert.equal(await journal.recoverInterrupted(), 0);
});

test("task journal preserves frozen Chinese input and candidate across restart without replaying interrupted work", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-task-"));
  const journal = new TaskJournal(root),
    id = randomUUID(),
    other = randomUUID();
  const snapshot = {
    context: "旧港的信𠮷🌊",
    selectedText: "旧港",
    target: { bookId: randomUUID(), chapterId: randomUUID(), start: 0, end: 2 },
  };
  await journal.create(
    {
      id,
      bookId: snapshot.target.bookId,
      status: "preparing",
      startedAt: "2026-10-22T15:00:00Z",
    },
    snapshot,
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", { candidate: "雾港的灯" });
  await journal.create(
    { id: other, status: "preparing", startedAt: "2026-10-22T15:01:00Z" },
    { context: "未发出的任务" },
  );
  const reopened = new TaskJournal(root);
  assert.equal(await reopened.recoverInterrupted(), 1);
  assert.equal((await reopened.read(other)).record.status, "interrupted");
  assert.deepEqual((await reopened.read(id)).snapshot, snapshot);
  assert.equal((await reopened.read(id)).record.candidate, "雾港的灯");
  const listing = await reopened.list(snapshot.target.bookId);
  assert.equal(listing.length, 1);
  assert.equal(listing[0].hasCandidate, true);
  assert.equal("candidate" in listing[0], false);
  await reopened.transition(id, "applied", { appliedHash: "saved-body-hash" });
  await assert.rejects(reopened.transition(id, "applied"), /状态/);
  assert.equal((await reopened.read(id)).record.candidate, "雾港的灯");
});

test("task journal rejects target rewrites, traversal and linked task directories and preserves damaged records", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-task-"));
  const journal = new TaskJournal(root),
    id = randomUUID();
  await journal.create(
    { id, status: "preparing", startedAt: "2026-10-22T15:00:00Z" },
    { context: "作者原稿" },
  );
  await assert.rejects(
    journal.transition(id, "running", { bookId: "different-book" }),
    /身份或范围/,
  );
  await assert.rejects(journal.read("../outside"), /标识/);
  const linked = randomUUID();
  await symlink(join(root, id), join(root, linked), "junction");
  await assert.rejects(journal.read(linked), /链接/);
  const path = join(root, id, "task.json");
  await writeFile(path, "{broken");
  assert.deepEqual(await journal.list(), []);
  assert.equal(await readFile(path, "utf8"), "{broken");
});
