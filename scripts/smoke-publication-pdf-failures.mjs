import { createRequire } from "node:module";
import { build } from "esbuild";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(root, ".cache", "pdf-failures-"));
const out = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-007",
  "publication-pdf-failures",
);
await mkdir(out, { recursive: true });
const runner = join(work, "runner.cjs");
await build({
  stdin: {
    resolveDir: root,
    sourcefile: "pdf-failures-qa.ts",
    loader: "ts",
    contents: `
import {app} from "electron";
import {join} from "node:path";
import {readFile,writeFile,readdir} from "node:fs/promises";
import {randomUUID,createHash} from "node:crypto";
import assert from "node:assert/strict";
import {makePublicationSnapshot} from "./packages/novel-domain/publication.mjs";
import {publicationPdfDocument} from "./packages/novel-domain/publication-pdf.mjs";
import {renderPublicationPdf} from "./apps/desktop/publication-pdf.ts";
app.setPath("userData",process.env.ZINOVEL_PDF_FAULT_ROOT+"/profile");
app.on("window-all-closed",()=>{});
app.whenReady().then(async()=>{
 const body="故障验证合成稿。𠮷🌊",hash=createHash("sha256").update(body).digest("hex");
 const snapshot=makePublicationSnapshot({id:randomUUID(),createdAt:new Date().toISOString(),bookId:randomUUID(),bookRevision:1,
 metadata:{title:"排版故障合成",author:"合成",synopsis:"",rights:"",aiDisclosure:""},
 chapters:[{id:randomUUID(),title:"合成章",volumeTitle:"",revision:1,savedHash:hash,bodyHash:hash,body}]});
 const document=publicationPdfDocument(snapshot),root=join(process.env.ZINOVEL_PDF_FAULT_ROOT,"render");
 const results=[];
 for(const mode of ["crash","timeout"]){
  app.once("browser-window-created",(_event,window)=>{
   window.webContents.printToPDF=()=>{
    if(mode==="crash")window.webContents.forcefullyCrashRenderer();
    return new Promise(()=>{});
   };
  });
  const started=performance.now();
  await assert.rejects(renderPublicationPdf(document,root),mode==="crash"?/排版进程已退出/:/超过90秒/);
  const elapsedMs=performance.now()-started;
  if(mode==="timeout")assert.ok(elapsedMs>=89_500&&elapsedMs<110_000);
  assert.deepEqual(await readdir(root),[]);
  const recovered=await renderPublicationPdf(document,root);
  assert.equal(recovered.subarray(0,5).toString(),"%PDF-");
  assert.deepEqual(await readdir(root),[]);
  results.push({mode,elapsedMs,temporaryHtmlRemoved:true,nextRenderPassed:true});
 }
 await writeFile(join(process.env.ZINOVEL_PDF_FAULT_ROOT,"report.json"),JSON.stringify({status:"passed",checks:results,
 scope:"Actual development Electron host renderer; forced renderer crash and real 90-second timeout, no installer claim"}));
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
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
  outfile: runner,
});
const env = { ...process.env, ZINOVEL_PDF_FAULT_ROOT: work };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [runner], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (bytes) => {
  errors += bytes.toString();
});
const timer = setTimeout(() => child.kill(), 130_000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
clearTimeout(timer);
assert.equal(code, 0, errors);
const report = JSON.parse(await readFile(join(work, "report.json"), "utf8"));
await writeFile(
  join(out, "pdf-failures-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
