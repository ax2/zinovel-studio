import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";
import { publicationPdfDocument } from "../packages/novel-domain/publication-pdf.mjs";
import { publicationRasterImages } from "../packages/novel-domain/publication-raster-images.mjs";
const digest = (x) => createHash("sha256").update(x).digest("hex");
function fixture(
  image = { sha256: "c".repeat(64), bytes: 128, width: 120, height: 200 },
) {
  const chapterId = randomUUID(),
    body = '正文𠮷🌊。<img src="https://invalid.test/private">';
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
    alt: "替代 <文字>𠮷",
    caption: "封面图注 <script>不执行</script>",
    credit: "公开署名",
  };
  return makePublicationSnapshot({
    id: randomUUID(),
    createdAt: "2026-10-26T12:00:00.000Z",
    bookId: randomUUID(),
    bookRevision: 1,
    metadata: {
      title: "带图PDF合成书",
      author: "合成作者",
      synopsis: "公开简介",
      rights: "合成",
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
}
test("illustrated PDF plan has fixed local PNG references, escaped public labels and no active author markup", () => {
  const snapshot = fixture(),
    before = JSON.stringify(snapshot),
    plan = publicationPdfDocument(snapshot);
  assert.equal(plan.templateVersion, 2);
  assert.equal(plan.resources.length, 3);
  assert.equal(plan.snapshotHash, snapshot.hash);
  assert.equal(plan.htmlHash, digest(plan.html));
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal((plan.html.match(/<img /g) || []).length, 3);
  assert.equal(
    (plan.html.match(/src="images\/[a-f0-9]{64}\.png"/g) || []).length,
    3,
  );
  assert.match(plan.html, /alt="替代 &lt;文字&gt;𠮷"/);
  assert.match(plan.html, /&lt;script&gt;不执行&lt;\/script&gt;/);
  assert.doesNotMatch(plan.html, /<script|data:image|src="https?:|PRIVATE_/);
  assert.match(plan.html, /script-src 'none'/);
  assert.match(plan.html, /img-src 'self'/);
  assert.ok(
    Object.isFrozen(plan.resources) && Object.isFrozen(plan.resources[0].image),
  );
  for (const [a, b] of [
    ["封面图注", "第一章"],
    ["第一章", "章首图注"],
    ["章首图注", "正文𠮷"],
    ["正文𠮷", "章尾图注"],
  ])
    assert.ok(plan.html.indexOf(a) < plan.html.indexOf(b));
});
test("illustrated PDF plan binds labels and image fingerprints and enforces controlled paper geometry", () => {
  const snapshot = fixture(),
    a = publicationPdfDocument(snapshot),
    b = publicationPdfDocument(snapshot, { paper: "A4" });
  assert.notEqual(a.htmlHash, b.htmlHash);
  assert.match(a.html, /max-height:126mm/);
  assert.match(b.html, /max-height:213mm/);
  const changed = makePublicationSnapshot({
    id: randomUUID(),
    createdAt: snapshot.createdAt,
    ...snapshot.content,
    resources: snapshot.content.resources.map((r, i) =>
      i ? r : { ...r, alt: "作者明确改图注" },
    ),
  });
  assert.notEqual(publicationPdfDocument(changed).htmlHash, a.htmlHash);
  const altered = structuredClone(snapshot);
  altered.content.resources[0].image.sha256 = "d".repeat(64);
  assert.throws(() => publicationPdfDocument(altered), /hash/);
});
test("PDF raster validation captures caller bytes and refuses missing, changed or mismatched frozen PNGs", async () => {
  const bytes = await sharp({
      create: { width: 32, height: 48, channels: 3, background: "#326c82" },
    })
      .png()
      .toBuffer(),
    original = Buffer.from(bytes),
    image = {
      sha256: digest(bytes),
      bytes: bytes.length,
      width: 32,
      height: 48,
    },
    snapshot = fixture(image),
    images = new Map([[image.sha256, bytes]]);
  const pending = publicationRasterImages(
    snapshot.content.resources,
    images,
    "PDF",
  );
  bytes.fill(0);
  images.clear();
  assert.deepEqual((await pending).get(image.sha256), original);
  for (const input of [
    new Map(),
    new Map([[image.sha256, Buffer.alloc(image.bytes)]]),
  ])
    await assert.rejects(
      publicationRasterImages(snapshot.content.resources, input, "PDF"),
      /PDF发行图/,
    );
  await assert.rejects(
    publicationRasterImages(
      fixture({ ...image, width: 33 }).content.resources,
      new Map([[image.sha256, original]]),
      "PDF",
    ),
    /尺寸/,
  );
  await assert.rejects(
    publicationRasterImages(
      snapshot.content.resources,
      new Map([[image.sha256, original]]),
      "other",
    ),
    /格式/,
  );
});
