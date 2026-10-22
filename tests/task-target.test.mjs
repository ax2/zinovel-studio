import test from "node:test";
import assert from "node:assert/strict";
import {
  bindWritingTarget,
  validateAcceptance,
} from "../packages/novel-harness/target.mjs";

test("writing targets reject mismatched selection and changed disk baselines but allow completed autosaves", () => {
  const body = "雨𠮷🌊旧信",
    chapter = { id: "chapter", title: "旧信", body, diskHash: "current" };
  const target = {
    bookId: "book",
    chapterId: "chapter",
    body,
    start: 1,
    end: 5,
    baseHash: "before-autosave",
  };
  const bound = bindWritingTarget(target, body, "𠮷🌊", chapter);
  assert.equal(bound.baseHash, "current");
  assert.equal(bound.chapterTitle, "旧信");
  assert.throws(
    () => bindWritingTarget({ ...target, end: 999 }, body, "𠮷🌊", chapter),
    /选区/,
  );
  assert.throws(
    () => bindWritingTarget(target, body, "other", chapter),
    /选区/,
  );
  assert.throws(
    () =>
      bindWritingTarget(target, body, "𠮷🌊", {
        ...chapter,
        body: "外部稿",
        diskHash: "changed",
      }),
    /外部改变/,
  );
  const unsaved = { ...target, body: "雨𠮷🌊作者新句", baseHash: "current" };
  assert.equal(
    bindWritingTarget(unsaved, unsaved.body, "𠮷🌊", chapter).body,
    unsaved.body,
  );
});

test("acceptance receipts require exact durable text and retain author-adjusted candidate separately", () => {
  const task = {
    record: { status: "awaiting-review", candidate: "模型原候选" },
    snapshot: {
      target: { chapterId: "chapter", body: "甲旧乙", start: 1, end: 2 },
    },
  };
  const chapter = {
    id: "chapter",
    body: "甲作者改稿乙",
    diskHash: "durable-hash",
  };
  const receipt = validateAcceptance(task, "作者改稿", chapter);
  assert.equal(receipt.appliedHash, "durable-hash");
  assert.equal(receipt.acceptedText, "作者改稿");
  assert.equal(task.record.candidate, "模型原候选");
  assert.throws(
    () => validateAcceptance(task, "作者改稿", { ...chapter, body: "甲旧乙" }),
    /尚未保存/,
  );
  assert.throws(
    () => validateAcceptance(task, "作者改稿", { ...chapter, id: "other" }),
    /尚未保存/,
  );
  assert.throws(
    () =>
      validateAcceptance(
        { ...task, record: { status: "interrupted" } },
        "作者改稿",
        chapter,
      ),
    /状态/,
  );
});
