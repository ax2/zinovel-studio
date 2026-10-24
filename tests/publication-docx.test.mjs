import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  publicationDocx,
  publicationDocxLimits,
} from "../packages/novel-domain/publication-docx.mjs";
import { publicationDocxOptions } from "../packages/novel-domain/publication-docx-options.mjs";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";
const JSZip = createRequire(import.meta.resolve("docx"))("jszip");
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fixture(
  body = '\ufeff第一段𠮷 🌊\r\n第二行\t定位。\r\n\r\n<script>leak()</script> & "书"',
) {
  return makePublicationSnapshot({
    id: randomUUID(),
    createdAt: "2026-10-24T00:00:00.000Z",
    bookId: randomUUID(),
    bookRevision: 1,
    metadata: {
      title: '雾港 <旧信> "一"',
      author: "合成作者",
      synopsis: "公开简介",
      rights: "合成验收",
      aiDisclosure: "合成",
    },
    chapters: [body, "最后一段。"].map((body, index) => ({
      id: randomUUID(),
      title: `第${index + 1}章`,
      volumeTitle: "合成卷",
      revision: 1,
      bodyHash: digest(body),
      savedHash: digest(body),
      body,
    })),
  });
}

test("DOCX accepts controlled Letter/A4/A5 options and rejects implicit unsafe values", () => {
  assert.equal(publicationDocxOptions().paper, "Letter");
  assert.ok(Object.isFrozen(publicationDocxOptions()));
  assert.equal(
    publicationDocxOptions({ paper: "A5", size: 18, leading: 2.4 }).size,
    18,
  );
  for (const input of [
    null,
    [],
    { paper: undefined },
    { paper: "B4" },
    { font: "url(secret)" },
    { size: 8 },
    { leading: Infinity },
    { css: "body{}" },
    { path: "private" },
  ])
    assert.throws(() => publicationDocxOptions(input), /DOCX/);
});

test("DOCX creates editable Unicode text, native headings, fields, public metadata and exact provenance", async () => {
  const snapshot = fixture(),
    before = JSON.stringify(snapshot),
    result = await publicationDocx(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(result.snapshotHash, snapshot.hash);
  assert.equal(result.snapshotId, snapshot.id);
  assert.equal(result.paragraphCount, 12);
  assert.equal(result.engine, "docx@9.14.0");
  const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true });
  const xml = await zip.file("word/document.xml").async("string"),
    styles = await zip.file("word/styles.xml").async("string");
  assert.match(xml, /第一段𠮷 🌊/);
  assert.match(xml, /&lt;script&gt;leak\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(xml, /<script>|altChunk|w:object|w:drawing/);
  assert.match(xml, /<w:br\/>/);
  assert.match(xml, /<w:tab\/>/);
  assert.ok(xml.indexOf("第1章") < xml.indexOf("第2章"));
  assert.match(xml, /w:pStyle w:val="Title"/);
  assert.equal((xml.match(/w:pStyle w:val="Heading1"/g) || []).length, 2);
  assert.match(xml, /w:pgSz w:w="12240" w:h="15840"/);
  assert.match(styles, /w:eastAsia="SimSun"/);
  const footer = await zip.file("word/footer1.xml").async("string");
  assert.match(footer, /PAGE/);
  assert.match(footer, /NUMPAGES/);
  const core = await zip.file("docProps/core.xml").async("string");
  assert.match(core, /合成作者/);
  assert.match(core, /公开简介/);
  const custom = await zip.file("docProps/custom.xml").async("string");
  assert.ok(custom.includes(snapshot.hash));
  assert.ok(custom.includes(snapshot.id));
  for (const file of Object.values(zip.files)) {
    assert.ok(
      !file.name.includes("\\") && !file.name.split("/").includes(".."),
    );
    assert.doesNotMatch(file.name, /vba|macro|embeddings/i);
    if (file.name.endsWith(".rels"))
      assert.doesNotMatch(await file.async("string"), /TargetMode="External"/);
  }
  assert.notEqual(
    result.recipeHash,
    (await publicationDocx(snapshot, { paper: "A4" })).recipeHash,
  );
});

test("DOCX refuses changed snapshots, invalid XML and resource excess before packaging", async () => {
  const damaged = structuredClone(fixture());
  damaged.content.chapters[0].body += "偷换";
  await assert.rejects(publicationDocx(damaged), /hash/);
  const base = fixture();
  const excessiveTitle = makePublicationSnapshot({
    id: randomUUID(),
    createdAt: base.createdAt,
    ...base.content,
    metadata: {
      ...base.content.metadata,
      title: "名\n".repeat(publicationDocxLimits.breaks + 1),
    },
  });
  await assert.rejects(publicationDocx(excessiveTitle), /段落或换行/);
  for (const text of ["坏\u0000字", "坏\u000b字", "坏\uffff字"])
    await assert.rejects(publicationDocx(fixture(text)), /XML控制字符/);
  await assert.rejects(
    publicationDocx(fixture("a".repeat(publicationDocxLimits.bytes))),
    /8 MiB/,
  );
  await assert.rejects(
    publicationDocx(
      fixture("短段。\n\n".repeat(publicationDocxLimits.paragraphs)),
    ),
    /段落或换行/,
  );
});
