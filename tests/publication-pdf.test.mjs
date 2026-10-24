import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";
import {
  publicationPdfDocument,
  publicationPdfInputLimit,
} from "../packages/novel-domain/publication-pdf.mjs";
import { publicationPdfOptions } from "../packages/novel-domain/publication-pdf-options.mjs";

function snapshot(
  body = '旧信。𠮷 🌊\r\n\r\n<script>leak()</script>\n<img src="https://invalid.test/secret">',
) {
  const hash = createHash("sha256").update(body).digest("hex");
  return makePublicationSnapshot({
    id: randomUUID(),
    createdAt: "2026-10-24T00:00:00.000Z",
    bookId: randomUUID(),
    bookRevision: 1,
    metadata: {
      title: '雾港 <书> "一"',
      author: "合成作者",
      synopsis: "试读",
      rights: "保留权利",
      aiDisclosure: "合成测试",
    },
    chapters: [
      {
        id: randomUUID(),
        title: "第一章",
        volumeTitle: "卷一",
        revision: 1,
        savedHash: hash,
        bodyHash: hash,
        body,
      },
    ],
  });
}

test("PDF layout accepts controlled options only and captures them immutably", () => {
  assert.equal(publicationPdfOptions().paper, "A5");
  const input = {
    paper: "A4",
    size: 18,
    leading: 2.4,
    font: "sans",
    margin: "wide",
    keepParagraphs: "flow",
  };
  const result = publicationPdfOptions(input);
  input.size = 1;
  assert.equal(result.size, 18);
  assert.ok(Object.isFrozen(result));
  for (const invalid of [
    null,
    [],
    { size: 8 },
    { size: 11.1 },
    { leading: NaN },
    { leading: 2.5 },
    { paper: "Letter" },
    { font: "url(secret)" },
    { css: "body{}" },
    { margin: undefined },
    { keepParagraphs: "arbitrary" },
  ])
    assert.throws(() => publicationPdfOptions(invalid), /PDF/);
});

test("PDF document escapes all author markup and preserves frozen Unicode and provenance", () => {
  const source = snapshot(),
    before = JSON.stringify(source);
  const result = publicationPdfDocument(source);
  assert.equal(result.snapshotHash, source.hash);
  assert.equal(result.snapshotId, source.id);
  assert.match(result.html, /&lt;script&gt;leak\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(result.html, /<script|<img|<[a-z][^>]*\s(?:href|src)=/);
  assert.match(result.html, /旧信。𠮷 🌊/);
  assert.match(result.html, /default-src 'none'/);
  assert.match(result.html, /雾港 &lt;书&gt; &quot;一&quot;/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(
    result.htmlHash,
    createHash("sha256").update(result.html).digest("hex"),
  );
  assert.equal(result.htmlHash, publicationPdfDocument(source).htmlHash);
  assert.notEqual(
    result.htmlHash,
    publicationPdfDocument(source, { paper: "A4" }).htmlHash,
  );
  assert.ok(Object.isFrozen(result));
  const damaged = structuredClone(source);
  damaged.content.chapters[0].body += "外部修改";
  assert.throws(() => publicationPdfDocument(damaged), /hash/);
});

test("PDF refuses unrenderable controls and oversized input without mutating source", () => {
  for (const value of ["坏\u0000字", "坏\u000b字", "坏\u007f字"])
    assert.throws(() => publicationPdfDocument(snapshot(value)), /控制字符/);
  const source = snapshot("a".repeat(publicationPdfInputLimit));
  assert.throws(() => publicationPdfDocument(source), /8 MiB/);
  assert.equal(
    source.content.chapters[0].body.length,
    publicationPdfInputLimit,
  );
});

test("PDF keeps short paragraphs together but allows long text to flow at both paper sizes", () => {
  const source = snapshot("短段落。\n\n" + "跨页长文。".repeat(400));
  for (const paper of ["A4", "A5"]) {
    const html = publicationPdfDocument(source, { paper }).html;
    assert.match(html, /class="keep">短段落。/);
    assert.match(html, /class="flow">跨页长文。/);
    assert.match(html, new RegExp(`size:${paper}`));
  }
  assert.doesNotMatch(
    publicationPdfDocument(source, { keepParagraphs: "flow" }).html,
    /class="keep"/,
  );
});
