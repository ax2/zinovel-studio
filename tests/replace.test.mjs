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
