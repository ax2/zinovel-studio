import test from "node:test";
import assert from "node:assert/strict";
import { moveReadonlyCaret } from "../packages/novel-domain/readonly-caret.mjs";
const move = (text, start, key, rest = {}) =>
  moveReadonlyCaret(text, {
    start,
    end: start,
    direction: "none",
    key,
    ...rest,
  });
test("preview arrows preserve supplementary characters and collapse or extend native selection anchors", () => {
  const text = "甲𠮷🙂乙";
  assert.equal(move(text, 1, "ArrowRight").focus, 3);
  assert.equal(move(text, 3, "ArrowRight").focus, 5);
  assert.equal(move(text, 5, "ArrowLeft").focus, 3);
  assert.equal(move(text, 3, "ArrowLeft").focus, 1);
  assert.deepEqual(move(text, 3, "ArrowLeft", { shift: true }), {
    start: 1,
    end: 3,
    direction: "backward",
    focus: 1,
  });
  assert.equal(
    move(text, 1, "ArrowRight", { end: 5, direction: "backward", shift: true })
      .focus,
    3,
  );
  assert.equal(move(text, 1, "ArrowRight", { end: 5 }).focus, 5);
  assert.equal(move(text, 1, "ArrowLeft", { end: 5 }).focus, 1);
});
test("preview line/document navigation handles empty lines, short lines and Unicode columns", () => {
  assert.equal(move("\n甲", 0, "Home").focus, 0);
  assert.equal(move("甲\n𠮷\n乙丙", 1, "ArrowDown").focus, 2);
  assert.equal(move("甲\n𠮷\n乙丙", 4, "Home").focus, 2);
  assert.equal(move("甲\n𠮷\n乙丙", 2, "End").focus, 4);
  assert.equal(move("甲\n𠮷\n乙丙", 7, "Home", { control: true }).focus, 0);
  assert.equal(move("甲\n𠮷\n乙丙", 0, "End", { control: true }).focus, 7);
  assert.equal(move("甲\n\n乙", 3, "ArrowUp").focus, 2);
  assert.equal(move("", 0, "ArrowDown").focus, 0);
  assert.equal(move("甲", 0, "ArrowLeft").focus, 0);
  assert.equal(move("甲", 1, "ArrowRight").focus, 1);
  assert.equal(move("甲", 0, "a"), null);
});
