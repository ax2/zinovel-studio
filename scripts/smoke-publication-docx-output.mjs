import { createConverter } from "@deepseek-ai/libreoffice-kit";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, ".."),
  stage = process.env.ZINOVEL_QA_STAGE || "stage-007";
const ui = JSON.parse(
  await readFile(
    join(
      root,
      "screenshots",
      stage,
      "publication-ui/publication-ui-smoke.json",
    ),
    "utf8",
  ),
);
assert.equal(ui.status, "passed");
const directory = ui.docxDirectory,
  file = join(directory, "book.docx");
const manifest = JSON.parse(
  await readFile(join(directory, "publication-manifest.json"), "utf8"),
);
assert.equal(manifest.format, "docx");
assert.equal(manifest.files.length, 1);
assert.equal(manifest.files[0].path, "book.docx");
const bytes = await readFile(file),
  hash = createHash("sha256").update(bytes).digest("hex");
assert.equal(hash, manifest.files[0].sha256);
const out = join(root, "screenshots", stage, "publication-docx");
await mkdir(out, { recursive: true });
const expected = join(out, "expected.json");
await writeFile(
  expected,
  JSON.stringify(
    {
      paper: "A4",
      size: 12,
      font: "serif",
      leading: 1.5,
      chapters: 2,
      required: [
        "雾港选章",
        "合成作者",
        "第一章原稿𠮷🌊",
        "第二章结尾。",
        "尚未自动保存就打开发布。",
      ],
      forbidden: [
        "EXCLUDED_FUTURE_SENTINEL",
        "AUTHOR_PRIVATE_SENTINEL",
        "作者捕获后明确外部改稿",
      ],
      ordered: ["第二章 渡口", "第一章 旧信"],
      counts: { "𠮷": 2, "🌊": 1 },
    },
    null,
    2,
  ) + "\n",
);
const converter = await createConverter({
  timeoutMs: 120_000,
  fontMetadataCacheDirectory: join(root, ".cache", "docx-qa-font-metadata"),
});
const job = await mkdtemp(join(root, ".cache", "docx-native-output-"));
const rendered = join(job, "native-reader.pdf");
let result;
try {
  result = await converter.render({ inputPath: file, outputPath: rendered });
} finally {
  await converter.dispose();
}
assert.equal(
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex"),
  hash,
);
const inspection = spawnSync(
  process.env.ZINOVEL_QA_PYTHON || "python",
  [
    "-I",
    "-X",
    "utf8",
    join(root, "scripts/inspect-publication-docx.py"),
    file,
    expected,
    out,
    "--pdf",
    rendered,
  ],
  {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  },
);
const report = {
  status: inspection.status === 0 ? "passed" : "failed",
  version: ui.version,
  snapshotHash: manifest.snapshotHash,
  sha256: hash,
  bytes: bytes.length,
  reader: {
    name: "DeepSeek LibreOffice Kit",
    version: "0.1.5",
    backend: result.backend,
    missingFonts: result.missingFonts,
  },
  scope:
    "Development-only independent reader; native engine is not shipped by the application",
  checks:
    inspection.status === 0
      ? [
          "installed or source host DOCX exports real editable paragraphs/native heading styles, public metadata, exact selected chapter order and rare-character counts; original bytes remain unchanged",
          "independent native LibreOffice reader converts the actual exported DOCX; spatial text extraction verifies complete public selection, excludes private/unselected text, checks all glyph bounds and rasterizes every page",
        ]
      : [],
  ...(inspection.status === 0
    ? {}
    : {
        failure:
          inspection.error?.message || inspection.stderr || inspection.stdout,
      }),
};
await writeFile(
  join(out, "publication-docx-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (inspection.status !== 0) throw new Error(report.failure);
console.log(report);
