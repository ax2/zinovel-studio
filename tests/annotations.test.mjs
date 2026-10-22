import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnchor,
  resolveAnchor,
} from "../packages/novel-domain/anchors.mjs";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";

test("anchors relocate by quote/context and report deleted or ambiguous references without guessing", () => {
  const body = "𠮷🙂林舟把旧信放在窗台。灯亮了。";
  const anchor = createAnchor(body, 7, 9, digest(body));
  assert.equal(anchor.quote, "旧信");
  assert.deepEqual(
    resolveAnchor("序章。" + body, anchor, digest("序章。" + body)),
    { status: "relocated", start: 10, end: 12 },
  );
  assert.equal(
    resolveAnchor(body.replace("旧信", "纸船"), anchor, "different").status,
    "missing",
  );
  assert.equal(
    resolveAnchor(body + "\n" + body, anchor, "different").status,
    "ambiguous",
  );
  const cursor = createAnchor(body, 9, 9, digest(body));
  assert.equal(resolveAnchor("序章。" + body, cursor, "different").start, 12);
  assert.equal(
    resolveAnchor("", createAnchor("", 0, 0, digest("")), digest("")).status,
    "exact",
  );
  assert.equal(
    resolveAnchor("新正文", createAnchor("", 0, 0, digest("")), "new").status,
    "missing",
  );
  assert.throws(() => createAnchor(body, 1, 4, digest(body)), /Unicode/);
});

test("annotations use revision and body guards, survive backup and restore independently of manuscript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-marks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, "library"),
    store = new NovelStore(library);
  await store.initialize();
  const body = "林舟把旧信放在窗台。";
  const book = await store.importBook("合成批注测试", [
    { title: "窗台", body },
  ]);
  const chapterId = book.chapters[0].id;
  const path = join(library, book.id, "manuscript", `${chapterId}.md`);
  let state = await store.readAnnotations(book.id, chapterId);
  const mutate = (mutation, current = state) =>
    store.mutateAnnotations(
      book.id,
      chapterId,
      current.revision,
      current.metadataHash,
      current.bodyHash,
      mutation,
    );
  await mutate({
    type: "create",
    kind: "note",
    title: "信的来历",
    text: "后文回应",
    start: 3,
    end: 5,
  });
  await assert.rejects(
    mutate({
      type: "create",
      kind: "bookmark",
      title: "旧状态",
      text: "",
      start: 0,
      end: 0,
    }),
    /批注已被修改/,
  );
  state = await new NovelStore(library).readAnnotations(book.id, chapterId);
  assert.equal(state.items[0].anchor.quote, "旧信");
  assert.equal(await readFile(path, "utf8"), body);
  await writeFile(path, "序章。" + body);
  await assert.rejects(
    mutate({ type: "reanchor", id: state.items[0].id, start: 0, end: 3 }),
    /正文已改变/,
  );
  state = await store.readAnnotations(book.id, chapterId);
  assert.equal(state.items[0].location.start, 6);
  await mutate({ type: "trash", id: state.items[0].id });
  state = await store.readAnnotations(book.id, chapterId);
  assert.ok(state.items[0].deletedAt);
  await mutate({ type: "restore", id: state.items[0].id });
  state = await store.readAnnotations(book.id, chapterId);
  await mutate({ type: "resolved", id: state.items[0].id, value: true });
  state = await store.readAnnotations(book.id, chapterId);
  const metadata = join(library, book.id, "annotations", `${chapterId}.json`);
  const raw = await readFile(metadata, "utf8");
  await writeFile(metadata, raw + "\n");
  await assert.rejects(
    mutate({ type: "resolved", id: state.items[0].id, value: false }),
    /批注已被修改/,
  );
  await mkdir(join(root, "backup"));
  const backup = await store.createBackup(book.id, join(root, "backup"));
  const restored = await store.restoreBackup(backup.path);
  const recovered = await store.readAnnotations(restored.id, chapterId);
  assert.equal(recovered.items[0].resolved, true);
  assert.equal(recovered.items[0].location.start, 6);
  assert.equal(recovered.items[0].deletedAt, undefined);
});
