import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { NovelStore } from "../packages/novel-storage/store.mjs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-vault-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.importBook("增量合成原稿", [
    { title: "旧信", body: "原始正文𠮷🌊。" },
  ]);
  return { root, store, book, destination: join(root, "independent-backups") };
}
const snapshot = async (backup) =>
  JSON.parse(
    await readFile(
      join(backup.path, "snapshots", backup.snapshotId + ".json"),
      "utf8",
    ),
  );
const commitCount = async (path) =>
  (await readdir(join(path, "snapshots"))).length;
async function edit(f, body) {
  const chapter = await f.store.readChapter(f.book.id, f.book.chapters[0].id);
  return f.store.saveChapter({
    bookId: f.book.id,
    chapterId: chapter.id,
    title: chapter.title,
    body,
    expectedRevision: chapter.revision,
    expectedHash: chapter.diskHash,
  });
}
test("incremental generations keep full logical manifests, copy only unseen bytes and restore any generation after a whole-vault move", async () => {
  const f = await setup(),
    first = await f.store.backups.capture(f.book.id, f.destination);
  const repeated = await f.store.backups.capture(f.book.id, f.destination);
  assert.equal(repeated.path, first.path);
  assert.notEqual(repeated.snapshotId, first.snapshotId);
  assert.equal(repeated.copiedBytes, 0);
  assert.equal(repeated.newObjects, 0);
  assert.deepEqual(
    (await snapshot(first)).files,
    (await snapshot(repeated)).files,
  );
  await edit(f, "后续手写原稿。𠮷🌊");
  const latest = await f.store.backups.capture(f.book.id, f.destination);
  assert.ok(latest.copiedBytes > 0);
  assert.ok(latest.newObjects > 0);
  const firstHashes = new Set(
    (await snapshot(first)).files.map((file) => file.sha256),
  );
  const newFiles = new Map(
    (await snapshot(latest)).files
      .filter((file) => !firstHashes.has(file.sha256))
      .map((file) => [file.sha256, file.bytes]),
  );
  assert.equal(
    latest.copiedBytes,
    [...newFiles.values()].reduce((a, b) => a + b, 0),
  );
  const moved = join(f.root, "搬移后的完整备份库");
  await cp(first.path, moved, { recursive: true, errorOnExist: true });
  assert.equal((await f.store.backups.list(moved)).snapshots.length, 3);
  const old = await f.store.backups.restore(moved, first.snapshotId),
    current = await f.store.backups.restore(moved, latest.snapshotId);
  assert.notEqual(old.id, current.id);
  assert.notEqual(current.id, f.book.id);
  assert.equal(
    (await f.store.readChapter(old.id, old.chapters[0].id)).body,
    "原始正文𠮷🌊。",
  );
  assert.equal(
    (await f.store.readChapter(current.id, current.chapters[0].id)).body,
    "后续手写原稿。𠮷🌊",
  );
  assert.equal(
    (await f.store.readChapter(f.book.id, f.book.chapters[0].id)).body,
    "后续手写原稿。𠮷🌊",
  );
});
test("identical source bytes share one immutable backup object without linking source files", async () => {
  const f = await setup(),
    bookRoot = join(f.store.root, f.book.id);
  await writeFile(
    join(bookRoot, "source-one.bin"),
    Buffer.from([0, 255, 128, 1]),
  );
  await writeFile(
    join(bookRoot, "source-two.bin"),
    Buffer.from([0, 255, 128, 1]),
  );
  const saved = await f.store.backups.capture(f.book.id, f.destination),
    manifest = await snapshot(saved);
  const one = manifest.files.find((file) => file.path === "source-one.bin"),
    two = manifest.files.find((file) => file.path === "source-two.bin");
  assert.equal(one.sha256, two.sha256);
  const object = join(saved.path, "objects", one.sha256),
    bytes = await readFile(object);
  await writeFile(join(bookRoot, "source-one.bin"), "changed live source");
  assert.deepEqual(await readFile(object), bytes);
});
test("damaged reused objects prevent new commits and restore without replacing any original or historical bytes", async () => {
  const f = await setup(),
    saved = await f.store.backups.capture(f.book.id, f.destination),
    manifest = await snapshot(saved);
  const file = manifest.files.find((file) =>
      file.path.startsWith("manuscript/"),
    ),
    path = join(saved.path, "objects", file.sha256),
    original = await readFile(path),
    manifestBytes = await readFile(
      join(saved.path, "snapshots", saved.snapshotId + ".json"),
    );
  await writeFile(path, Buffer.alloc(original.length, 88));
  const books = await readdir(f.store.root);
  await assert.rejects(
    f.store.backups.restore(saved.path, saved.snapshotId),
    /损坏/,
  );
  await assert.rejects(
    f.store.backups.capture(f.book.id, f.destination),
    /损坏/,
  );
  assert.deepEqual(await readdir(f.store.root), books);
  assert.equal(await commitCount(saved.path), 1);
  assert.deepEqual(
    await readFile(join(saved.path, "snapshots", saved.snapshotId + ".json")),
    manifestBytes,
  );
  await writeFile(path, original); // Explicitly repair only this owned synthetic fixture.
  assert.ok((await f.store.backups.restore(saved.path, saved.snapshotId)).id);
});
test("cancel before commit retains previous generations and leaves reusable objects without a false successful snapshot", async () => {
  const f = await setup(),
    first = await f.store.backups.capture(f.book.id, f.destination);
  await edit(f, "取消期间已存在的作者新稿。");
  const controller = new AbortController();
  await assert.rejects(
    f.store.backups.capture(f.book.id, f.destination, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === "ready-to-commit") controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(await commitCount(first.path), 1);
  assert.ok((await f.store.backups.restore(first.path, first.snapshotId)).id);
  const resumed = await f.store.backups.capture(f.book.id, f.destination);
  assert.equal(resumed.copiedBytes, 0);
  assert.equal(resumed.newObjects, 0);
  const restored = await f.store.backups.restore(
    first.path,
    resumed.snapshotId,
  );
  assert.equal(
    (await f.store.readChapter(restored.id, restored.chapters[0].id)).body,
    "取消期间已存在的作者新稿。",
  );
});
test("logical capacity, managed-library aliases and unknown destination folders reject before adoption", async () => {
  const f = await setup();
  await assert.rejects(
    f.store.backups.capture(f.book.id, f.destination, { maxBytes: 1 }),
    /上限/,
  );
  await assert.rejects(readdir(f.destination), { code: "ENOENT" });
  const alias = join(f.root, "library-alias");
  await symlink(
    f.store.root,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.store.backups.capture(f.book.id, join(alias, "not-created")),
    /书库/,
  );
  const target = join(f.destination, `zinovel-vault-${f.book.id}`);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "user-file.txt"), "keep");
  await assert.rejects(f.store.backups.capture(f.book.id, f.destination));
  assert.deepEqual(await readdir(target), ["user-file.txt"]);
});
test("writer locks are fail-closed, never reclaimed just because their PID appears stale", async () => {
  const f = await setup(),
    first = await f.store.backups.capture(f.book.id, f.destination),
    lock = join(first.path, ".writer.lock"),
    sentinel = "synthetic owner, keep even when stale";
  await writeFile(lock, sentinel, { flag: "wx" });
  await assert.rejects(
    f.store.backups.capture(f.book.id, f.destination),
    /写入锁/,
  );
  assert.equal(await readFile(lock, "utf8"), sentinel);
  assert.equal(await commitCount(first.path), 1);
  await unlink(lock); // Explicitly release the lock created by this test, not another writer.
  assert.equal(
    (await f.store.backups.capture(f.book.id, f.destination)).copiedBytes,
    0,
  );
});
test("future and hash-valid duplicate-path manifests remain preserved and cannot restore", async () => {
  const f = await setup(),
    saved = await f.store.backups.capture(f.book.id, f.destination),
    original = await snapshot(saved),
    path = join(saved.path, "snapshots", saved.snapshotId + ".json");
  const future = { ...original, version: 99 };
  await writeFile(path, JSON.stringify(future));
  const listed = await f.store.backups.list(saved.path);
  assert.equal(listed.snapshots.length, 0);
  assert.equal(listed.errors.length, 1);
  await assert.rejects(
    f.store.backups.restore(saved.path, saved.snapshotId),
    /格式/,
  );
  const { hash, ...projection } = original;
  projection.files.push({
    ...projection.files[0],
    path: projection.files[0].path.toUpperCase(),
  });
  const duplicate = {
    ...projection,
    hash: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
  };
  await writeFile(path, JSON.stringify(duplicate));
  await assert.rejects(
    f.store.backups.restore(saved.path, saved.snapshotId),
    /重复/,
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), duplicate);
});

test("objects reused earlier in an operation are revalidated before snapshot commit", async () => {
  const f = await setup(),
    first = await f.store.backups.capture(f.book.id, f.destination);
  const manifest = await snapshot(first),
    unchanged = manifest.files.find((file) =>
      file.path.startsWith("manuscript/"),
    );
  await writeFile(
    join(f.store.root, f.book.id, "new-sidecar.txt"),
    "new object",
  );
  let changed = false;
  await assert.rejects(
    f.store.backups.capture(f.book.id, f.destination, {
      onProgress: async (event) => {
        if (event.phase === "object-written" && !changed) {
          changed = true;
          await writeFile(
            join(first.path, "objects", unchanged.sha256),
            Buffer.alloc(unchanged.bytes, 89),
          );
        }
      },
    }),
    /损坏/,
  );
  assert.equal(await commitCount(first.path), 1);
});

for (const checkpoint of ["ready-to-commit", "committed"])
  test(`real process termination at ${checkpoint} preserves earlier generations and leaves ownership locks untouched`, async () => {
    const f = await setup(),
      first = await f.store.backups.capture(f.book.id, f.destination);
    await edit(f, "进程中断前的新稿。");
    let childPid;
    const child = execFile(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/vault-crash.mjs", import.meta.url)),
        f.store.root,
        f.book.id,
        f.destination,
        checkpoint,
      ],
      { windowsHide: true, timeout: 20000 },
    );
    childPid = child.pid;
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
    });
    assert.equal(exitCode, 91);
    const listed = await f.store.backups.list(first.path);
    assert.equal(listed.snapshots.length, checkpoint === "committed" ? 2 : 1);
    assert.equal(
      (
        await f.store.readChapter(
          (await f.store.backups.restore(first.path, first.snapshotId)).id,
          f.book.chapters[0].id,
        )
      ).body,
      "原始正文𠮷🌊。",
    );
    const lockPath = join(first.path, ".writer.lock"),
      lockBytes = await readFile(lockPath),
      owner = JSON.parse(lockBytes);
    assert.equal(owner.pid, childPid);
    await assert.rejects(
      f.store.backups.capture(f.book.id, f.destination),
      /写入锁/,
    );
    assert.deepEqual(await readFile(lockPath), lockBytes);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    await unlink(lockPath); // Explicit QA recovery of this proven-exited synthetic owner; not an automatic product feature.
    const resumed = await f.store.backups.capture(f.book.id, f.destination);
    assert.equal(resumed.copiedBytes, 0);
    const restored = await f.store.backups.restore(
      first.path,
      resumed.snapshotId,
    );
    assert.equal(
      (await f.store.readChapter(restored.id, restored.chapters[0].id)).body,
      "进程中断前的新稿。",
    );
  });

test("a notification failure or late cancellation after commit cannot disguise an already recoverable snapshot as failure", async () => {
  const f = await setup(),
    controller = new AbortController();
  const saved = await f.store.backups.capture(f.book.id, f.destination, {
    signal: controller.signal,
    onProgress: (event) => {
      if (event.phase === "committed") {
        controller.abort();
        throw new Error("synthetic observer error");
      }
    },
  });
  assert.equal(saved.notificationFailed, true);
  assert.equal(await commitCount(saved.path), 1);
  assert.ok((await f.store.backups.restore(saved.path, saved.snapshotId)).id);
  assert.equal(
    (await f.store.backups.capture(f.book.id, f.destination)).copiedBytes,
    0,
  );
});

test("incremental restore keeps current manuscript, old frozen publication images, private asset records and immutable original provenance", async () => {
  const f = await setup();
  const bytes = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: 17, g: 82, b: 126, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const asset = await f.store.assets.import(f.book.id, bytes, {
    title: "合成封面",
    purpose: "cover",
    source: "合成测试",
    rights: "测试",
    notes: "PRIVATE_ASSET_NOTES_SYNTHETIC",
    linkedIds: [],
  });
  const publication = await f.store.publication.capture(f.book.id, {
    catalogHash: (await f.store.publication.catalog(f.book.id)).hash,
    chapterIds: [f.book.chapters[0].id],
    metadata: {
      title: "公开合成书",
      author: "合成作者",
      synopsis: "",
      rights: "测试",
      aiDisclosure: "测试",
    },
    resources: [
      {
        asset: {
          id: asset.id,
          revision: asset.revision,
          diskHash: asset.diskHash,
        },
        placement: "cover",
        chapterId: null,
        alt: "合成封面",
        caption: "",
        credit: "",
      },
    ],
  });
  const images = await f.store.publicationResources.images(
    f.book.id,
    publication,
  );
  await edit(f, "冻结出版之后的当前正文。");
  const saved = await f.store.backups.capture(f.book.id, f.destination),
    restored = await f.store.backups.restore(saved.path, saved.snapshotId);
  assert.equal(
    (await f.store.readChapter(restored.id, restored.chapters[0].id)).body,
    "冻结出版之后的当前正文。",
  );
  const frozen = await f.store.publication.read(
    restored.id,
    publication.id,
    publication.hash,
  );
  assert.deepEqual(frozen, publication);
  assert.deepEqual(
    await f.store.publicationResources.images(restored.id, frozen),
    images,
  );
  const copiedCard = await f.store.assets.read(restored.id, asset.id);
  assert.equal(copiedCard.notes, "PRIVATE_ASSET_NOTES_SYNTHETIC");
  assert.doesNotMatch(JSON.stringify(frozen), /PRIVATE_ASSET_NOTES_SYNTHETIC/);
});
