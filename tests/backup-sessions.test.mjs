import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BackupSessions } from "../packages/novel-storage/backup-sessions.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bookId = randomUUID(),
  foreign = randomUUID();
function fixture() {
  const snapshot = {
      id: randomUUID(),
      hash: "a".repeat(64),
      createdAt: new Date().toISOString(),
      files: 4,
      logicalBytes: 12,
    },
    vaultId = randomUUID();
  let options, release, restoreOptions;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const list = { vaultId, bookId, snapshots: [snapshot], errors: [] };
  const service = new BackupSessions({
    list: async () => structuredClone(list),
    capture: async (_book, path, input) => {
      options = input;
      await gate;
      input.signal.throwIfAborted();
      return {
        path,
        snapshotId: snapshot.id,
        hash: snapshot.hash,
        files: 4,
        logicalBytes: 12,
        copiedBytes: 0,
      };
    },
    restore: async (_path, _id, input) => {
      restoreOptions = input;
      return { id: randomUUID() };
    },
  });
  return {
    service,
    list,
    snapshot,
    vaultId,
    release,
    options: () => options,
    restoreOptions: () => restoreOptions,
  };
}
test("native selection tokens and background jobs are scoped to exact window and book", async () => {
  const f = fixture(),
    selected = await f.service.open(11, bookId, "native-picked-directory");
  assert.equal(selected.canCapture, true);
  await assert.rejects(f.service.refresh(12, bookId, selected.token), /不属于/);
  assert.throws(
    () => f.service.startSelected(11, foreign, selected.token),
    /不属于/,
  );
  const job = f.service.startSelected(11, bookId, selected.token);
  assert.throws(() => f.service.status(12, bookId, job.id), /不属于/);
  assert.throws(() => f.service.cancel(11, foreign, job.id), /不属于/);
  assert.throws(() => f.service.startNew(11, bookId, "another"), /进行中/);
  assert.equal(f.options().existingVault, true);
  assert.equal(f.options().expectedVaultId, f.vaultId);
  f.service.cancel(11, bookId, job.id);
  f.release();
  await tick();
  assert.equal(f.service.status(11, bookId, job.id).status, "cancelled");
});
test("committing jobs cannot be cancelled and later successful commits remain completed", async () => {
  const f = fixture(),
    job = f.service.startNew(11, bookId, "native");
  f.options().onCommitting();
  assert.equal(f.service.cancel(11, bookId, job.id).cancelled, false);
  f.release();
  await tick();
  assert.equal(f.service.status(11, bookId, job.id).status, "completed");
  const selected = await f.service.completed(11, bookId, job.id);
  assert.equal(selected.total, 1);
});
test("stop aborts precommit work, waits for settlement and denies future picker capabilities", async () => {
  const f = fixture(),
    job = f.service.startNew(11, bookId, "native");
  const stopped = f.service.stop();
  assert.equal(f.options().signal.aborted, true);
  f.release();
  await stopped;
  assert.equal(f.service.status(11, bookId, job.id).status, "cancelled");
  await assert.rejects(f.service.open(11, bookId, "native"), /关闭/);
  assert.throws(() => f.service.startNew(11, bookId, "native"), /关闭/);
});
test("restore is authorized to a selected exact snapshot hash and original vault identity", async () => {
  const f = fixture(),
    selected = await f.service.open(11, bookId, "native");
  await assert.rejects(
    f.service.restore(
      11,
      bookId,
      selected.token,
      f.snapshot.id,
      "b".repeat(64),
    ),
    /未在/,
  );
  await f.service.restore(
    11,
    bookId,
    selected.token,
    f.snapshot.id,
    f.snapshot.hash,
  );
  assert.deepEqual(f.restoreOptions(), {
    expectedHash: f.snapshot.hash,
    expectedVaultId: f.vaultId,
  });
  f.list.vaultId = randomUUID();
  await assert.rejects(
    f.service.refresh(11, bookId, selected.token),
    /身份已改变/,
  );
});
test("foreign-book vault selection permits explicit restore but never appends current-book content", async () => {
  const f = fixture();
  f.list.bookId = foreign;
  const selected = await f.service.open(
    11,
    bookId,
    "explicitly-picked-foreign-vault",
  );
  assert.equal(selected.canCapture, false);
  assert.throws(
    () => f.service.startSelected(11, bookId, selected.token),
    /其他作品/,
  );
  await f.service.restore(
    11,
    bookId,
    selected.token,
    f.snapshot.id,
    f.snapshot.hash,
  );
});
test("pagination exposes every selected committed generation and reopening the app does not revive capabilities", async () => {
  const f = fixture();
  f.list.snapshots = Array.from({ length: 101 }, () => ({
    ...f.snapshot,
    id: randomUUID(),
  }));
  const selected = await f.service.open(11, bookId, "native");
  assert.equal(selected.snapshots.length, 50);
  assert.equal(selected.pages, 3);
  assert.equal(
    f.service.page(11, bookId, selected.token, 2).snapshots.length,
    1,
  );
  assert.throws(() => f.service.page(11, bookId, selected.token, -1), /页码/);
  const reopened = fixture();
  await assert.rejects(
    reopened.service.refresh(11, bookId, selected.token),
    /不属于/,
  );
});
