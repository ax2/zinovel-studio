import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateDiff,
  composeCandidate,
} from "../packages/novel-domain/candidate-diff.mjs";

test("review preserves exact text for all-accept/all-reject including line endings and Unicode", () => {
  const pairs = [
    ["", "插入𠮷🌊\r\n"],
    ["删除\n", ""],
    ["原文", "原文"],
    ["甲\r\n\r\n乙", "甲\r\n\r\n丙\n"],
    ["甲\n重复\n甲\n", "重复\n甲\n重复\n"],
    ["", ""],
  ];
  for (const [original, candidate] of pairs) {
    const diff = candidateDiff(original, candidate);
    assert.equal(composeCandidate(diff), candidate);
    assert.equal(
      composeCandidate(
        diff,
        new Set(
          diff.segments
            .filter((part) => part.kind === "change")
            .map((part) => part.id),
        ),
      ),
      original,
    );
  }
});

test("independent edits can be combined without changing surrounding content", () => {
  const original = "前文\n旧甲🌊\n桥接\n旧乙𠮷\n结尾\n";
  const candidate = "前文\n新甲🌊\n桥接\n新乙𠮷\n结尾\n";
  const diff = candidateDiff(original, candidate);
  assert.equal(
    diff.segments.filter((part) => part.kind === "change").length,
    2,
  );
  assert.equal(
    composeCandidate(diff, new Set([0])),
    "前文\n旧甲🌊\n桥接\n新乙𠮷\n结尾\n",
  );
  assert.equal(
    composeCandidate(diff, new Set([1])),
    "前文\n新甲🌊\n桥接\n旧乙𠮷\n结尾\n",
  );
});

test("large alignment and excessive changes fall back without losing text", () => {
  for (const [original, candidate] of [
    [
      "共同\n" + "原稿\n".repeat(1500) + "末尾",
      "共同\n" + "候选\n".repeat(1500) + "末尾",
    ],
    [
      Array.from({ length: 130 }, (_, i) => `旧${i}\n锚${i}\n`).join(""),
      Array.from({ length: 130 }, (_, i) => `新${i}\n锚${i}\n`).join(""),
    ],
  ]) {
    const diff = candidateDiff(original, candidate);
    assert.equal(diff.coarse, true);
    assert.equal(composeCandidate(diff), candidate);
    assert.equal(composeCandidate(diff, new Set([0])), original);
  }
});

test("deterministic generated cases retain both exact originals and candidates", () => {
  let seed = 17;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  for (let n = 0; n < 250; n++) {
    const create = () =>
      Array.from(
        { length: random() % 30 },
        () => ["甲\n", "乙\r\n", "𠮷🌊\n", "\n", "末"][random() % 5],
      ).join("");
    const original = create(),
      candidate = create(),
      diff = candidateDiff(original, candidate);
    assert.equal(composeCandidate(diff), candidate);
    assert.equal(
      composeCandidate(
        diff,
        new Set(
          diff.segments
            .filter((part) => part.kind === "change")
            .map((part) => part.id),
        ),
      ),
      original,
    );
  }
});
