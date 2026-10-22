import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore, digest } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { TaskAcceptance } from "../packages/novel-harness/acceptance.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-acceptance-")),
    body = "雨𠮷🌊旧信";
  const store = new NovelStore(join(root, "library")),
    journal = new TaskJournal(join(root, "tasks"));
  const book = await store.importBook("合成接受验证", [
    { title: "旧信", body },
  ]);
  const chapter = await store.readChapter(book.id, book.chapters[0].id),
    id = randomUUID();
  await journal.create(
    { id, bookId: book.id, chapterId: chapter.id, status: "preparing" },
    {
      context: body,
      selectedText: "旧信",
      target: {
        bookId: book.id,
        chapterId: chapter.id,
        body,
        start: 5,
        end: 7,
        baseHash: chapter.diskHash,
      },
    },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", { candidate: "模型原文" });
  return {
    store,
    journal,
    id,
    book,
    chapter,
    body,
    file: join(root, "library", book.id, "manuscript", `${chapter.id}.md`),
    directory: join(root, "library", book.id),
  };
}

test("host acceptance is durable, retains both candidates and cannot replay after a later author edit", async () => {
  const f = await fixture(),
    service = new TaskAcceptance(f.journal, f.store);
  const result = await service.accept(f.id, "作者调整");
  assert.equal(result.chapter.body, "雨𠮷🌊作者调整");
  assert.equal((await f.journal.read(f.id)).record.candidate, "模型原文");
  assert.equal((await f.journal.read(f.id)).record.acceptedText, "作者调整");
  assert.equal(
    (await service.accept(f.id, "作者调整")).chapter.revision,
    result.chapter.revision,
  );
  const listed = (await f.journal.list())[0];
  assert.equal("acceptance" in listed, false);
  assert.equal("acceptedText" in listed, false);
  await writeFile(f.file, "作者后续稿", "utf8");
  await assert.rejects(service.accept(f.id, "作者调整"), /状态已变化/);
  assert.equal(await readFile(f.file, "utf8"), "作者后续稿");
});

test("partially applied manuscript transaction rolls its acceptance receipt forward before task recovery", async () => {
  const f = await fixture();
  await assert.rejects(
    new TaskAcceptance(f.journal, f.store, async (stage) => {
      if (stage === "manuscript-saved") throw new Error("interruption");
    }).accept(f.id, "作者调整"),
    /interruption/,
  );
  const { record } = await f.journal.read(f.id),
    transactionDirectory = join(f.directory, ".zinovel", "transactions");
  let interrupted;
  for (const name of await readdir(transactionDirectory)) {
    const raw = await readFile(join(transactionDirectory, name), "utf8");
    if (
      JSON.parse(raw).entries.some((entry) =>
        entry.path.includes(record.acceptance.id),
      )
    )
      interrupted = raw;
  }
  assert.ok(interrupted);
  // A valid crash layout: book metadata landed, manuscript and receipt did not.
  await writeFile(f.file, f.body);
  const receiptPath = join(
    f.directory,
    ".zinovel",
    "task-receipts",
    `${record.acceptance.id}.json`,
  );
  await rename(receiptPath, `${receiptPath}.held`);
  await writeFile(join(f.directory, ".zinovel", "pending.json"), interrupted);
  await new TaskAcceptance(f.journal, f.store).recoverAll();
  assert.equal((await f.journal.read(f.id)).record.status, "applied");
  assert.equal(await readFile(f.file, "utf8"), "雨𠮷🌊作者调整");
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).taskId, f.id);
});

test("matching candidate bytes alone cannot manufacture acceptance without a transactional receipt", async () => {
  const f = await fixture();
  await assert.rejects(
    new TaskAcceptance(f.journal, f.store, async () => {
      throw new Error("interruption");
    }).accept(f.id, "作者调整"),
    /interruption/,
  );
  await writeFile(f.file, "雨𠮷🌊作者调整");
  await new TaskAcceptance(f.journal, f.store).recoverAll();
  assert.equal(
    (await f.journal.read(f.id)).record.status,
    "acceptance-uncertain",
  );
});

test("interruption before manuscript save returns to review without replaying the write", async () => {
  const f = await fixture();
  const service = new TaskAcceptance(f.journal, f.store, async (stage) => {
    if (stage === "intent-written") throw new Error("synthetic interruption");
  });
  await assert.rejects(service.accept(f.id, "作者调整"), /synthetic/);
  assert.equal((await f.journal.read(f.id)).record.status, "accepting");
  const recovered = new TaskAcceptance(f.journal, f.store);
  assert.equal(await recovered.recoverAll(), 1);
  assert.equal((await f.journal.read(f.id)).record.status, "awaiting-review");
  assert.equal(await readFile(f.file, "utf8"), f.body);
  assert.equal(await recovered.recoverAll(), 0);
});

test("interruption after durable save repairs the task receipt even after later edits, without changing current text", async () => {
  for (const changed of [false, true]) {
    const f = await fixture();
    const service = new TaskAcceptance(f.journal, f.store, async (stage) => {
      if (stage === "manuscript-saved")
        throw new Error("synthetic interruption");
    });
    await assert.rejects(service.accept(f.id, "作者调整"), /synthetic/);
    if (changed) await writeFile(f.file, "外部另稿");
    const before = await readFile(f.file, "utf8"),
      recovered = new TaskAcceptance(f.journal, f.store);
    await recovered.recoverAll();
    const { record } = await f.journal.read(f.id);
    assert.equal(record.status, "applied");
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.equal(record.appliedHash, digest("雨𠮷🌊作者调整"));
    if (changed)
      await assert.rejects(recovered.accept(f.id, "作者调整"), /状态已变化/);
  }
});

test("a competing external save after intent cannot be overwritten, and a failed receipt does not hide the saved result", async () => {
  const f = await fixture();
  const service = new TaskAcceptance(f.journal, f.store, async (stage) => {
    if (stage === "intent-written") await writeFile(f.file, "竞争修改");
  });
  assert.equal((await service.accept(f.id, "作者调整")).status, "conflict");
  assert.equal(
    (await f.journal.read(f.id)).record.status,
    "acceptance-uncertain",
  );
  assert.equal(await readFile(f.file, "utf8"), "竞争修改");
  const g = await fixture(),
    normalTransition = g.journal.transition.bind(g.journal);
  g.journal.transition = (id, status, changes) =>
    status === "applied"
      ? Promise.reject(new Error("synthetic receipt I/O failure"))
      : normalTransition(id, status, changes);
  const result = await new TaskAcceptance(g.journal, g.store).accept(
    g.id,
    "作者调整",
  );
  assert.equal(result.receiptPending, true);
  assert.equal(result.chapter.body, await readFile(g.file, "utf8"));
  g.journal.transition = normalTransition;
  await new TaskAcceptance(g.journal, g.store).recoverAll();
  assert.equal((await g.journal.read(g.id)).record.status, "applied");
});
