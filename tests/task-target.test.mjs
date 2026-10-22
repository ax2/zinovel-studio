import test from "node:test";
import assert from "node:assert/strict";
import { bindWritingTarget } from "../packages/novel-harness/target.mjs";

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
