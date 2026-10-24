import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  publicationResourceSelections as selections,
  publicationResourceReferences as references,
  publicationResourceLimits as limits,
} from "../packages/novel-domain/publication-resources.mjs";
const chapterId = randomUUID(),
  outsideChapter = randomUUID(),
  id = randomUUID(),
  hash = "a".repeat(64);
const choice = (extra = {}) => ({
  asset: { id, revision: 1, diskHash: hash },
  placement: "cover",
  chapterId: null,
  alt: "封面𠮷🌊",
  caption: "作者的图注",
  credit: "公开署名",
  ...extra,
});
const reference = (extra = {}) => ({
  source: {
    assetId: id,
    revision: 1,
    recordHash: hash,
    blobHash: "b".repeat(64),
  },
  image: { sha256: "c".repeat(64), bytes: 1024, width: 80, height: 120 },
  renderVersion: 1,
  placement: "cover",
  chapterId: null,
  alt: "封面𠮷🌊",
  caption: "图注",
  credit: "署名",
  ...extra,
});

test("publication image author choices preserve exact public text, detach inputs and limit positions to selected chapters", () => {
  const input = [
    choice(),
    choice({ placement: "chapter-start", chapterId }),
    choice({ placement: "chapter-end", chapterId }),
  ];
  const output = selections(input, [chapterId]);
  assert.equal(output[0].alt, "封面𠮷🌊");
  assert.ok(
    Object.isFrozen(output) &&
      Object.isFrozen(output[0]) &&
      Object.isFrozen(output[0].asset),
  );
  input[0].asset.revision = 9;
  input[0].alt = "changed";
  assert.equal(output[0].asset.revision, 1);
  assert.equal(output[0].alt, "封面𠮷🌊");
  assert.deepEqual(selections([], [chapterId]), []);
  for (const input of [
    [choice({ placement: "chapter-start", chapterId: outsideChapter })],
    [choice({ chapterId })],
    [choice({ placement: "inline" })],
    [choice(), choice()],
    [
      choice(),
      choice({ asset: { id: randomUUID(), revision: 1, diskHash: hash } }),
    ],
    [choice({ privateNotes: "never public" })],
    [choice({ alt: " " })],
    [choice({ alt: "\ud800" })],
    [choice({ credit: "hidden\0value" })],
    [choice({ caption: "x".repeat(4001) })],
    [choice({ asset: { id, revision: 0, diskHash: hash } })],
    [choice({ asset: { id, revision: 1, diskHash: "changed" } })],
    Array.from({ length: 33 }, () => choice()),
  ])
    assert.throws(() => selections(input, [chapterId]));
  assert.throws(() => selections([], []));
  assert.throws(() => selections([], [chapterId, chapterId]));
});

test("frozen publication image references require host provenance, consistent image identity and a deduplicated byte budget", () => {
  const input = reference();
  const output = references([input], [chapterId]);
  assert.ok(
    Object.isFrozen(output[0].source) && Object.isFrozen(output[0].image),
  );
  input.image.width = 200;
  assert.equal(output[0].image.width, 80);
  for (const item of [
    reference({ renderVersion: 2 }),
    reference({ asset: choice().asset }),
    reference({ source: { ...reference().source, notes: "private" } }),
    reference({ image: { ...reference().image, path: "C:/private.png" } }),
    reference({
      image: { ...reference().image, bytes: limits.imageBytes + 1 },
    }),
    reference({ image: { ...reference().image, width: 16385 } }),
    reference({ image: { ...reference().image, width: 10000, height: 10000 } }),
  ])
    assert.throws(() => references([item], [chapterId]));
  const large = reference({
    image: { ...reference().image, bytes: limits.imageBytes },
  });
  // Reuse of the same image is counted once, while every distinct placement remains explicit.
  assert.equal(
    references(
      [large, { ...large, placement: "chapter-end", chapterId }],
      [chapterId],
    ).length,
    2,
  );
  assert.throws(
    () =>
      references(
        [
          large,
          reference({
            placement: "chapter-start",
            chapterId,
            image: { ...large.image, width: 81 },
          }),
        ],
        [chapterId],
      ),
    /不同/,
  );
  assert.throws(
    () =>
      references(
        [
          large,
          reference({
            placement: "chapter-start",
            chapterId,
            image: { ...large.image, sha256: "d".repeat(64) },
          }),
          reference({
            placement: "chapter-end",
            chapterId,
            image: { ...large.image, sha256: "e".repeat(64) },
          }),
        ],
        [chapterId],
      ),
    /128 MiB/,
  );
});
