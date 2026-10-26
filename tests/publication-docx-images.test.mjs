import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import sharp from "sharp";
import { publicationDocx } from "../packages/novel-domain/publication-docx.mjs";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";
const JSZip = createRequire(import.meta.resolve("docx"))("jszip");
const digest = (x) => createHash("sha256").update(x).digest("hex");
async function fixture(extra = {}) {
  const bytes =
    extra.bytes ||
    (await sharp({
      create: { width: 1200, height: 1800, channels: 3, background: "#286a82" },
    })
      .png()
      .toBuffer());
  const chapterId = randomUUID(),
    hash = digest(bytes),
    image = {
      sha256: hash,
      bytes: bytes.length,
      width: 1200,
      height: 1800,
      ...extra.image,
    };
  const reference = {
    source: {
      assetId: randomUUID(),
      revision: 1,
      recordHash: "a".repeat(64),
      blobHash: "b".repeat(64),
    },
    image,
    renderVersion: 1,
    placement: "cover",
    chapterId: null,
    alt: "封面替代 <文字>𠮷",
    caption: "封面图注 & <script>不执行</script>",
    credit: "公开署名",
  };
  const body = "正文第一段𠮷🌊。\r\n\r\n正文终点。";
  const snapshot = makePublicationSnapshot({
    id: randomUUID(),
    createdAt: "2026-10-26T12:00:00.000Z",
    bookId: randomUUID(),
    bookRevision: 1,
    metadata: {
      title: "带图合成书",
      author: "合成作者",
      synopsis: "公开简介",
      rights: "合成图像",
      aiDisclosure: "合成",
    },
    chapters: [
      {
        id: chapterId,
        title: "第一章",
        volumeTitle: "合成卷",
        revision: 1,
        bodyHash: digest(body),
        savedHash: digest(body),
        body,
      },
    ],
    resources: [
      reference,
      {
        ...reference,
        placement: "chapter-start",
        chapterId,
        alt: "章首替代",
        caption: "章首图注",
        credit: "",
      },
      {
        ...reference,
        placement: "chapter-end",
        chapterId,
        alt: "章尾替代",
        caption: "章尾图注",
        credit: "",
      },
    ],
  });
  return { bytes, hash, image, snapshot, images: new Map([[hash, bytes]]) };
}
test("illustrated DOCX embeds exact one PNG for three ordered placements with editable text and public alt/captions", async () => {
  const f = await fixture(),
    before = JSON.stringify(f.snapshot),
    r = await publicationDocx(
      f.snapshot,
      { paper: "A5", margin: "wide" },
      f.images,
    );
  assert.equal(JSON.stringify(f.snapshot), before);
  assert.equal(r.templateVersion, 2);
  assert.equal(r.illustrationCount, 3);
  assert.deepEqual(r.embeddedImages, [f.image]);
  const zip = await JSZip.loadAsync(r.bytes, { checkCRC32: true }),
    media = Object.values(zip.files).filter(
      (x) => !x.dir && x.name.startsWith("word/media/"),
    );
  assert.equal(media.length, 1);
  assert.deepEqual(await media[0].async("nodebuffer"), f.bytes);
  const xml = await zip.file("word/document.xml").async("string");
  assert.equal((xml.match(/<w:drawing>/g) || []).length, 3);
  assert.match(xml, /descr="封面替代 &lt;文字&gt;𠮷"/);
  assert.match(xml, /&lt;script&gt;不执行&lt;\/script&gt;/);
  assert.match(xml, /正文第一段𠮷🌊/);
  for (const [a, b] of [
    ["封面图注", "第一章"],
    ["第一章", "章首图注"],
    ["章首图注", "正文第一段"],
    ["正文终点", "章尾图注"],
  ])
    assert.ok(xml.indexOf(a) < xml.indexOf(b), a + " precedes " + b);
  const sizes = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(
    (x) => x.slice(1).map(Number),
  );
  assert.equal(sizes.length, 3);
  for (const [w, h] of sizes) {
    assert.ok(w <= (8391 - Math.round((22 * 1440) / 25.4) * 2) * 635 + 1);
    assert.ok(Math.abs(w / h - 2 / 3) < 0.00001);
  }
  for (const file of Object.values(zip.files))
    if (file.name.endsWith(".rels"))
      assert.doesNotMatch(await file.async("string"), /TargetMode="External"/);
  assert.doesNotMatch(xml, /PRIVATE_|w:object|altChunk/);
});
test("illustrated DOCX rejects missing, extra, changed and wrong-sized input bytes before output", async () => {
  const f = await fixture();
  await assert.rejects(publicationDocx(f.snapshot), /发行图/);
  for (const images of [
    new Map(),
    new Map([...f.images, ["0".repeat(64), f.bytes]]),
    new Map([[f.hash, Buffer.alloc(f.bytes.length)]]),
    new Map([[f.hash, f.bytes.subarray(1)]]),
  ])
    await assert.rejects(
      publicationDocx(f.snapshot, undefined, images),
      /发行图/,
    );
});
test("illustrated DOCX rejects forged dimensions, truncated PNG and metadata inconsistent with frozen rendition", async () => {
  for (const extra of [
    { image: { width: 1201 } },
    { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    {
      bytes: await sharp({
        create: {
          width: 1200,
          height: 1800,
          channels: 3,
          background: "#286a82",
        },
      })
        .withMetadata({ exif: { IFD0: { Artist: "PRIVATE_SENTINEL" } } })
        .png()
        .toBuffer(),
    },
  ]) {
    const f = await fixture(extra);
    await assert.rejects(publicationDocx(f.snapshot, undefined, f.images));
  }
});
test("illustrated DOCX captures every caller buffer before async decoding", async () => {
  const f = await fixture(),
    original = Buffer.from(f.bytes),
    pending = publicationDocx(f.snapshot, undefined, f.images);
  f.bytes.fill(0);
  f.images.clear();
  const result = await pending,
    zip = await JSZip.loadAsync(result.bytes);
  const media = Object.values(zip.files).find(
    (x) => !x.dir && x.name.startsWith("word/media/"),
  );
  assert.deepEqual(await media.async("nodebuffer"), original);
});

test("illustrated DOCX enforces deduplicated 64 MiB input protection before decoding or packaging", async () => {
  const f = await fixture();
  const bytes = await Promise.all(
    ["#123456", "#654321"].map((background) =>
      sharp({ create: { width: 3600, height: 2400, channels: 4, background } })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    ),
  );
  assert.ok(bytes[0].length + bytes[1].length > 64 * 1024 * 1024);
  const resources = bytes.map((data, index) => ({
    ...f.snapshot.content.resources[index],
    source: {
      ...f.snapshot.content.resources[index].source,
      assetId: randomUUID(),
    },
    image: {
      sha256: digest(data),
      bytes: data.length,
      width: 3600,
      height: 2400,
    },
  }));
  const snapshot = makePublicationSnapshot({
    id: randomUUID(),
    createdAt: f.snapshot.createdAt,
    ...f.snapshot.content,
    resources,
  });
  await assert.rejects(
    publicationDocx(
      snapshot,
      undefined,
      new Map(bytes.map((data) => [digest(data), data])),
    ),
    /64 MiB/,
  );
});
