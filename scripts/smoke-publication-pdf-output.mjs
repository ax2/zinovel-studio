import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const directory = ui.pdfDirectory;
const manifest = JSON.parse(
  await readFile(join(directory, "publication-manifest.json"), "utf8"),
);
assert.equal(manifest.format, "pdf");
assert.equal(manifest.files.length, 1);
assert.equal(manifest.files[0].path, "book.pdf");
const file = join(directory, "book.pdf"),
  bytes = await readFile(file);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  manifest.files[0].sha256,
);
const out = join(root, "screenshots", stage, "publication-pdf");
await mkdir(out, { recursive: true });
const expected = join(out, "expected.json");
await writeFile(
  expected,
  JSON.stringify(
    {
      paper: "A4",
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
const result = spawnSync(
  process.env.ZINOVEL_QA_PYTHON || "python",
  [
    "-I",
    "-X",
    "utf8",
    join(root, "scripts/inspect-publication-pdf.py"),
    file,
    expected,
    out,
  ],
  {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  },
);
const report = {
  status: result.status === 0 ? "passed" : "failed",
  version: ui.version,
  checks:
    result.status === 0
      ? [
          "actual exported PDF independently verifies required frozen text, excluded private content, explicit chapter order and exact rare-character counts",
          "independent parser verifies A4 page bounds, embedded fonts, Unicode maps, fixed page labels and absence of active actions; PDFium rasterizes all pages",
        ]
      : [],
  snapshotHash: manifest.snapshotHash,
  sha256: manifest.files[0].sha256,
  bytes: bytes.length,
  inspection: "inspection.json",
  renderer: "independent PDFium; actual page review separate",
  ...(result.status === 0
    ? {}
    : { failure: result.error?.message || result.stderr || result.stdout }),
};
await writeFile(
  join(out, "publication-pdf-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (result.status !== 0)
  throw new Error(`Independent PDF inspection failed: ${report.failure}`);
console.log(report);
