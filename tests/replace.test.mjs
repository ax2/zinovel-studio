import test from "node:test";
import assert from "node:assert/strict";
import { previewReplacement } from "../packages/novel-domain/replace.mjs";
test("literal preview keeps Unicode offsets, counts every match and changes no other text", () => {
  const result = previewReplacement("𠮷🙂旧信。旧信。", "旧信", "新信");
  assert.equal(result.matches[0].start, 4);
  assert.equal(result.count, 2);
  assert.equal(result.body, "𠮷🙂新信。新信。");
  assert.equal(previewReplacement("a.b * a.b", "a.b", "$1").body, "$1 * $1");
  assert.throws(() => previewReplacement("text", "", "x"));
});
test("individual matches survive pagination and only selected literal offsets change", () => {
  const body = "𠮷" + "甲乙。".repeat(120);
  const page = previewReplacement(body, "甲乙", "丙", {
    all: false,
    starts: [2, 155, 359],
    offset: 50,
  });
  assert.equal(page.count, 120);
  assert.equal(page.selectedCount, 3);
  assert.equal(page.matches.length, 50);
  assert.equal(page.matches[1].start, 155);
  assert.equal(page.matches[1].selected, true);
  assert.equal(
    page.body,
    "𠮷丙。" + "甲乙。".repeat(50) + "丙。" + "甲乙。".repeat(67) + "丙。",
  );
  assert.equal(
    previewReplacement("甲甲甲", "甲", "乙", { starts: [1] }).body,
    "乙甲乙",
  );
  assert.equal(
    previewReplacement(body, "甲乙", "丙", { all: false }).body,
    body,
  );
  assert.throws(() => previewReplacement(body, "甲乙", "丙", { offset: -1 }));
});
