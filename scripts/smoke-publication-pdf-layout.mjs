import { createRequire } from "node:module";
import { build } from "esbuild";
import electronPath from "electron";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { makePublicationSnapshot } from "../packages/novel-domain/publication.mjs";

const root = resolve(import.meta.dirname, ".."),
  cache = await mkdtemp(join(root, ".cache", "pdf-layout-"));
const stage = process.env.ZINOVEL_QA_STAGE || "stage-007",
  out = join(root, "screenshots", stage, "publication-pdf-layout");
await mkdir(out, { recursive: true });
const title = "雾港排版合成书——" + "长题名渡口旧信".repeat(12);
const markers = [],
  paragraphs = Array.from({ length: 24 }, (_, index) => {
    const marker = `段落编号${String(index + 1).padStart(3, "0")}终`;
    markers.push(marker);
    return (
      `${marker}。𠮷 🌊。` +
      "旧信落在桌边，船夫听见潮声。他将路线画在纸上，等天亮再去渡口。".repeat(5)
    );
  });
const bodies = [
  paragraphs.join("\n\n"),
  paragraphs.join("\n\n") +
    '\n\n<script>leak()</script><img src="https://invalid.test/private">\n\nhttps://invalid.test/' +
    "long-boundary-".repeat(150) +
    "\n\n全文终点𠮷🌊。",
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
    synopsis: "跨页长文与罕见字仅用于程序验收。",
    rights: "合成验收",
    aiDisclosure: "合成",
  },
  chapters: bodies.map((body, index) => ({
    id: randomUUID(),
    title: `章序${index + 1}终——` + "长章名".repeat(18),
    volumeTitle: "合成卷",
    revision: 1,
    savedHash: digest(body),
    bodyHash: digest(body),
    body,
  })),
});
const cases = [
  { name: "a5-serif", options: {} },
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
    options: { size: 18, leading: 2.4, margin: "wide" },
  },
];
const input = join(cache, "input.json"),
  runner = join(cache, "runner.cjs");
await writeFile(input, JSON.stringify({ snapshot, cases, cache }));
await build({
  stdin: {
    contents: `
import {app} from "electron";
import {readFile,writeFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import assert from "node:assert/strict";
import {publicationPdfDocument} from "./packages/novel-domain/publication-pdf.mjs";
import {renderPublicationPdf} from "./apps/desktop/publication-pdf.ts";
app.setPath("userData", process.env.ZINOVEL_PDF_QA_PROFILE);
app.on("window-all-closed",()=>{});
app.whenReady().then(async()=>{
 const input=JSON.parse(await readFile(process.env.ZINOVEL_PDF_QA_INPUT,"utf8"));
 const reports=[];
 for(const item of input.cases){
  const document=publicationPdfDocument(input.snapshot,item.options),start=performance.now();
  const active=renderPublicationPdf(document,join(input.cache,"render"));
  await assert.rejects(renderPublicationPdf(document,join(input.cache,"render")),/已有PDF/);
  const bytes=await active,file=join(input.cache,item.name+".pdf");
  await writeFile(file,bytes);
  assert.deepEqual(await readdir(join(input.cache,"render")),[]);
  reports.push({...item,file,bytes:bytes.length,elapsedMs:performance.now()-start});
 }
 await writeFile(join(input.cache,"render-report.json"),JSON.stringify(reports));
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`,
    resolveDir: root,
    sourcefile: "pdf-layout-qa.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: runner,
  external: ["electron"],
  plugins: [
    {
      name: "source-sharp",
      setup(build) {
        build.onResolve({ filter: /^sharp$/ }, () => ({
          path: createRequire(import.meta.url).resolve("sharp"),
          external: true,
        }));
      },
    },
  ],
});
const env = {
  ...process.env,
  ZINOVEL_PDF_QA_PROFILE: join(cache, "profile"),
  ZINOVEL_PDF_QA_INPUT: input,
};
delete env.ELECTRON_RUN_AS_NODE;
const rendered = spawnSync(electronPath, [runner], {
  env,
  encoding: "utf8",
  windowsHide: true,
  timeout: 180_000,
});
assert.equal(rendered.status, 0, rendered.stderr || rendered.error?.message);
const reports = JSON.parse(
  await readFile(join(cache, "render-report.json"), "utf8"),
);
for (const item of reports) {
  const target = join(out, item.name);
  await mkdir(target, { recursive: true });
  const expected = join(target, "expected.json");
  await writeFile(
    expected,
    JSON.stringify({
      paper: item.options.paper || "A5",
      required: [
        ...markers,
        title,
        "章序1终",
        "章序2终",
        "全文终点𠮷🌊。",
        '<script>leak()</script><img src="https://invalid.test/private">',
      ],
      forbidden: ["EXCLUDED_PRIVATE_SENTINEL"],
      ordered: ["章序1终", "章序2终"],
      counts: { "𠮷": 49, "🌊": 49 },
    }),
  );
  const check = spawnSync(
    process.env.ZINOVEL_QA_PYTHON || "python",
    [
      "-I",
      "-X",
      "utf8",
      join(root, "scripts/inspect-publication-pdf.py"),
      item.file,
      expected,
      target,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
    },
  );
  assert.equal(check.status, 0, check.stderr || check.error?.message);
  item.sha256 = digest(await readFile(item.file));
  item.inspection = JSON.parse(
    await readFile(join(target, "inspection.json"), "utf8"),
  );
}
await writeFile(
  join(out, "pdf-layout-smoke.json"),
  JSON.stringify(
    {
      status: "passed",
      snapshotHash: snapshot.hash,
      scope:
        "Real development Electron renderer; no installed package claim; timings are single synthetic observations",
      reports,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  reports.map(({ name, bytes, elapsedMs, inspection }) => ({
    name,
    bytes,
    elapsedMs,
    pages: inspection.pages,
  })),
);
