import { createConverter } from "@deepseek-ai/libreoffice-kit";
import sharp from "sharp";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { publicationDocx } from "../packages/novel-domain/publication-docx.mjs";
import { publicationDocxOptions } from "../packages/novel-domain/publication-docx-options.mjs";
const root = resolve(import.meta.dirname, ".."),
  stage = process.env.ZINOVEL_QA_STAGE || "stage-007",
  out = join(
    root,
    "screenshots",
    stage,
    process.argv.includes("--author-only")
      ? "illustrated-docx-author-only"
      : "illustrated-docx",
  ),
  work = await mkdtemp(join(root, ".cache", "illustrated-docx-"));
await mkdir(out, { recursive: true });
const read = async (p) => JSON.parse(await readFile(p, "utf8"));
const ui = await read(
  join(
    root,
    "screenshots",
    stage,
    "publication-resources/publication-resources-smoke.json",
  ),
);
assert.equal(ui.status, "passed");
assert.ok(ui.docxSnapshot?.content?.resources?.length);
assert.equal(ui.checks.length, 5);
const store = new NovelStore(join(work, "library"));
const bodies = [
  "第一段𠮷🌊。" +
    "旧信落在桌边，船夫听见潮声。他将路线画在纸上，等天亮再去渡口。".repeat(12),
  "第二章原稿。\n\n全文终点𠮷🌊。",
];
const book = await store.importBook(
  "带图排版合成书",
  bodies.map((body, i) => ({ title: `章序${i + 1}终`, body })),
);
const sources = [
  await sharp({
    create: { width: 800, height: 1400, channels: 3, background: "#236383" },
  })
    .png()
    .toBuffer(),
  await sharp({
    create: { width: 900, height: 500, channels: 3, background: "#b56c48" },
  })
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Artist: "PRIVATE_IMAGE_SENTINEL" } },
    })
    .jpeg()
    .toBuffer(),
  await sharp({
    create: {
      width: 2400,
      height: 180,
      channels: 4,
      background: { r: 83, g: 137, b: 112, alpha: 0.55 },
    },
  })
    .png()
    .toBuffer(),
];
const selections = [];
for (let i = 0; i < sources.length; i++) {
  const asset = await store.assets.import(book.id, sources[i], {
    title: `合成图${i}`,
    purpose: i === 0 ? "cover" : "illustration",
    source: "PRIVATE_SOURCE_SENTINEL",
    rights: "PRIVATE_RIGHTS_SENTINEL",
    notes: "PRIVATE_NOTES_SENTINEL",
    linkedIds: [],
  });
  selections.push({
    asset: { id: asset.id, revision: asset.revision, diskHash: asset.diskHash },
    placement: ["cover", "chapter-start", "chapter-end"][i],
    chapterId: i === 0 ? null : book.chapters[i === 1 ? 0 : 1].id,
    alt: `图像替代${i}𠮷`,
    caption:
      i === 1
        ? "长图注。" + "潮水经过灯塔，船夫把旧信留在岸边。".repeat(70)
        : `公开图注${i}`,
    credit: `公开署名${i}`,
  });
}
const catalog = await store.publication.catalog(book.id),
  snapshot = await store.publication.capture(book.id, {
    catalogHash: catalog.hash,
    chapterIds: book.chapters.map((x) => x.id),
    metadata: {
      title: "带图排版合成书",
      author: "合成作者",
      synopsis: "封面与章首章尾图像排版检查",
      rights: "合成图像",
      aiDisclosure: "合成",
    },
    resources: selections,
  });
const images = await store.publicationResources.images(book.id, snapshot);
const cases = [
  { name: "letter-default", options: {} },
  {
    name: "a4-flow",
    options: {
      paper: "A4",
      font: "sans",
      size: 12,
      leading: 1.5,
      keepParagraphs: "flow",
    },
  },
  {
    name: "a5-large-wide",
    options: { paper: "A5", margin: "wide", size: 18, leading: 2.4 },
  },
];
const converter = await createConverter({
    timeoutMs: 120000,
    fontMetadataCacheDirectory: join(root, ".cache", "docx-qa-font-metadata"),
  }),
  reports = [];
const hash = (x) => createHash("sha256").update(x).digest("hex");
function inspect(script, args) {
  const result = spawnSync(
    process.env.ZINOVEL_QA_PYTHON || "python",
    [join(root, "scripts", script), ...args],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw Error(`${script}: ${result.stdout}\n${result.stderr}`);
}
async function verify(name, input, frozen, options) {
  const directory = join(out, name);
  await mkdir(directory, { recursive: true });
  const pdf = join(work, `${name}.pdf`),
    expected = join(directory, "expected.json"),
    snapshotFile = join(directory, "snapshot.json");
  const settings = publicationDocxOptions(options);
  const required = [
    ...Object.values(frozen.content.metadata).filter(Boolean),
    ...frozen.content.chapters.flatMap((c) => [c.title, c.body]),
    ...frozen.content.resources
      .flatMap((r) => [r.caption, r.credit])
      .filter(Boolean),
  ];
  await writeFile(
    expected,
    JSON.stringify(
      {
        ...settings,
        chapters: frozen.content.chapters.length,
        required,
        forbidden: [
          "PRIVATE_IMAGE_",
          "PRIVATE_SOURCE_",
          "PRIVATE_NOTES_",
          "UNSELECTED_CHAPTER_SENTINEL",
        ],
        ordered: frozen.content.chapters.map((c) => c.title),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(snapshotFile, JSON.stringify(frozen, null, 2) + "\n");
  const before = hash(await readFile(input)),
    rendered = await converter.render({ inputPath: input, outputPath: pdf });
  assert.equal(rendered.backend, "native");
  assert.equal(hash(await readFile(input)), before);
  inspect("inspect-publication-docx.py", [
    input,
    expected,
    directory,
    "--pdf",
    pdf,
  ]);
  inspect("inspect-publication-docx-images.py", [
    input,
    snapshotFile,
    join(directory, "image-inspection.json"),
    "--pdf",
    pdf,
  ]);
  const report = await read(join(directory, "docx-inspection.json"));
  reports.push({ name, input, pdf, options: settings, ...report });
}
try {
  for (const c of process.argv.includes("--author-only") ? [] : cases) {
    const input = join(work, `${c.name}.docx`),
      result = await publicationDocx(snapshot, c.options, images);
    await writeFile(input, result.bytes);
    await verify(c.name, input, snapshot, c.options);
  }
  await verify(
    "actual-author-export",
    join(ui.docxDirectory, "book.docx"),
    ui.docxSnapshot,
    {},
  );
} finally {
  await converter.dispose();
}
const report = {
  status: "passed",
  version: ui.version,
  packaged: ui.packaged,
  ...(ui.appAsarSha256 ? { appAsarSha256: ui.appAsarSha256 } : {}),
  checks: [
    "Actual author DOCX contains the exact two frozen PNGs and placements, public alternative text and editable Unicode manuscript; independent OOXML/Pillow and source snapshot fingerprints agree",
    "Actual author DOCX renders through the native independent reader with complete text, headings, footers and bounded images; the source file stays unchanged",
    ...(!process.argv.includes("--author-only")
      ? [
          "Three source-generator Letter/A4/A5 layouts preserve all source text and long captions, aspect ratios, image bounds and every page footer; source cases are distinguished from the author executable export",
        ]
      : []),
  ],
  scope: process.argv.includes("--author-only")
    ? "Actual author executable DOCX only; independent OOXML/Pillow/native reader PDF and page raster checks; no source-generator layout, Microsoft Word or store qualification claim"
    : "Three source-generator layouts plus actual author UI DOCX, independent OOXML/Pillow/native reader PDF and page raster checks; no Microsoft Word, professional publishing or store qualification claim",
  cases: reports,
};
await writeFile(
  join(out, "illustrated-docx-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(reports.map((x) => ({ name: x.name, pages: x.pdfPages })));
