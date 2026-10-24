import { createConverter } from "@deepseek-ai/libreoffice-kit";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { publicationDocx } from "../packages/novel-domain/publication-docx.mjs";
import { publicationDocxOptions } from "../packages/novel-domain/publication-docx-options.mjs";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";

const root = resolve(import.meta.dirname, "..");
const cache = await mkdtemp(join(root, ".cache", "docx-layout-"));
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "publication-docx-layout",
);
await mkdir(out, { recursive: true });
const title = "雾港排版合成书——" + "长题名渡口旧信".repeat(18);
const markers = Array.from(
  { length: 8 },
  (_, index) => `段落编号${index + 1}终`,
);
const paragraphs = markers.map(
  (marker) =>
    `${marker}。𠮷 🌊。` +
    "旧信落在桌边，船夫听见潮声。他将路线画在纸上，等天亮再去渡口。".repeat(3),
);
const url = "https://invalid.test/" + "long-boundary-".repeat(120);
const bodies = [
  paragraphs.join("\n\n"),
  paragraphs.join("\n\n") + `\n\n${url}\n\n全文终点𠮷🌊。`,
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const snapshot = makePublicationSnapshot({
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  bookId: randomUUID(),
  bookRevision: 1,
  metadata: {
    title,
    author: "合成作者",
    synopsis: "长文、长题名、罕见字与长网址合成验证。",
    rights: "合成验收",
    aiDisclosure: "合成",
  },
  chapters: bodies.map((body, index) => ({
    id: randomUUID(),
    title: `章序${index + 1}终——` + "长章名".repeat(18),
    volumeTitle: "合成卷",
    revision: 1,
    bodyHash: digest(body),
    savedHash: digest(body),
    body,
  })),
});
const cases = [
  { name: "letter-serif", options: {} },
  {
    name: "a4-sans",
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
    options: { paper: "A5", size: 18, leading: 2.4, margin: "wide" },
  },
];
const converter = await createConverter({
  timeoutMs: 120_000,
  fontMetadataCacheDirectory: join(root, ".cache", "docx-qa-font-metadata"),
});
const reports = [];
try {
  for (const item of cases) {
    const directory = join(out, item.name);
    await mkdir(directory, { recursive: true });
    const input = join(cache, `${item.name}.docx`),
      pdf = join(cache, `${item.name}.pdf`);
    const result = await publicationDocx(snapshot, item.options);
    await writeFile(input, result.bytes);
    const expected = join(directory, "expected.json");
    await writeFile(
      expected,
      JSON.stringify(
        {
          ...publicationDocxOptions(item.options),
          chapters: 2,
          required: [title, ...markers, url, "全文终点𠮷🌊。"],
          forbidden: ["AUTHOR_PRIVATE_SENTINEL"],
          ordered: ["章序1终", "章序2终"],
          counts: { "𠮷": 17, "🌊": 17 },
        },
        null,
        2,
      ) + "\n",
    );
    const reader = await converter.render({
      inputPath: input,
      outputPath: pdf,
    });
    assert.equal(reader.backend, "native");
    assert.equal(digest(await readFile(input)), digest(result.bytes));
    const inspection = spawnSync(
      process.env.ZINOVEL_QA_PYTHON || "python",
      [
        "-I",
        "-X",
        "utf8",
        join(root, "scripts/inspect-publication-docx.py"),
        input,
        expected,
        directory,
        "--pdf",
        pdf,
      ],
      { encoding: "utf8", timeout: 120_000, windowsHide: true },
    );
    assert.equal(inspection.status, 0, inspection.stderr || inspection.stdout);
    reports.push({
      name: item.name,
      ...JSON.parse(
        await readFile(join(directory, "docx-inspection.json"), "utf8"),
      ),
      reader,
    });
  }
} finally {
  await converter.dispose();
}
await writeFile(
  join(out, "layout-smoke.json"),
  JSON.stringify(
    {
      status: "passed",
      scope:
        "Source DOCX generator and development-only independent native reader; not an installed-app claim",
      cases: reports,
    },
    null,
    2,
  ) + "\n",
);
console.log(reports.map(({ name, pdfPages }) => ({ name, pdfPages })));
