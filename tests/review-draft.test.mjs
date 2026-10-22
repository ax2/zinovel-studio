import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { reviewContent } from "../packages/novel-domain/review-content.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-review-draft-")),
    id = randomUUID(),
    journal = new TaskJournal(root);
  await journal.create(
    { id, status: "preparing", bookId: randomUUID(), chapterId: randomUUID() },
    { context: "合成正文", target: { body: "合成正文" } },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: "模型候选𠮷🌊\r\n",
  });
  return { root, id, journal };
}
test("review drafts retain the immutable model proposal, survive restart and reject stale concurrent saves", async () => {
  const { root, id, journal } = await fixture();
  const before = await readFile(join(root, id, "task.json"));
  const draft = await journal.saveReviewDraft(id, "作者审阅𠮷🌊\r\n", 0);
  assert.equal(draft.revision, 1);
  const restarted = new TaskJournal(root);
  assert.deepEqual((await restarted.read(id)).reviewDraft, draft);
  assert.deepEqual(await readFile(join(root, id, "task.json")), before);
  const concurrent = await Promise.allSettled([
    journal.saveReviewDraft(id, "第一份", 1),
    journal.saveReviewDraft(id, "过期第二份", 1),
  ]);
  assert.equal(concurrent[0].status, "fulfilled");
  assert.equal(concurrent[1].status, "rejected");
  assert.equal((await journal.read(id)).reviewDraft.text, "第一份");
  await assert.rejects(
    journal.saveReviewDraft(id, "x".repeat(120001), 2),
    /无效/,
  );
  await journal.transition(id, "discarded");
  await assert.rejects(journal.saveReviewDraft(id, "不能写", 2), /当前不能/);
});
test("corrupt or foreign review drafts are preserved and cannot silently overwrite or replace the original candidate", async () => {
  const { root, id, journal } = await fixture();
  await journal.saveReviewDraft(id, "审阅稿", 0);
  const path = join(root, id, "review.json");
  const draft = JSON.parse(await readFile(path, "utf8"));
  draft.sourceCandidateHash = "0".repeat(64);
  await writeFile(path, JSON.stringify(draft));
  const before = await readFile(path);
  const task = await journal.read(id);
  assert.equal(task.reviewDraft, null);
  assert.match(task.reviewDraftError, /无法读取/);
  assert.equal(task.record.candidate, "模型候选𠮷🌊\r\n");
  await assert.rejects(journal.saveReviewDraft(id, "覆盖尝试", 1), /无效/);
  assert.deepEqual(await readFile(path), before);
});
test("an obstructed review draft path reports failure and preserves prior source records", async () => {
  const { root, id, journal } = await fixture();
  await mkdir(join(root, id, "review.json"));
  const before = await readFile(join(root, id, "task.json"));
  await assert.rejects(journal.saveReviewDraft(id, "写入受阻", 0));
  assert.deepEqual(await readFile(join(root, id, "task.json")), before);
  assert.equal((await journal.read(id)).reviewDraft, null);
});

test("a review saved after recovered acceptance supersedes that intent, while an older draft does not", async () => {
  const { root, id, journal } = await fixture();
  await journal.saveReviewDraft(id, "接受之前的旧草稿", 0);
  const intent = { id: randomUUID(), acceptedText: "中断接受时作者确认的文字" };
  await journal.transition(id, "accepting", { acceptance: intent });
  await journal.transition(id, "awaiting-review", {
    acceptanceRecovery: "original-text-retained",
  });
  assert.equal(reviewContent(await journal.read(id)).text, intent.acceptedText);
  const updated = await journal.saveReviewDraft(id, "恢复后新存的草稿𠮷🌊", 1);
  assert.equal(updated.afterAcceptanceId, intent.id);
  const restored = await new TaskJournal(root).read(id);
  assert.equal(reviewContent(restored).text, "恢复后新存的草稿𠮷🌊");
  assert.equal(reviewContent(restored).source, "saved-review");
});
