import { build } from "esbuild";
import electronPath from "electron";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";
import {
  captureOwnedProcesses,
  confirmOwnedProcessesExited,
  terminateOwnedProcesses,
} from "./windows-owned-processes.mjs";
import { waitForCondition } from "./windows-installer-observation.mjs";
const root = resolve(import.meta.dirname, ".."),
  stage = process.env.ZINOVEL_QA_STAGE || "stage-007",
  authorOnly = process.argv.includes("--author-only"),
  out = join(
    root,
    "screenshots",
    stage,
    authorOnly ? "illustrated-pdf-author-only" : "illustrated-pdf",
  ),
  work = await mkdtemp(join(root, ".cache", "illustrated-pdf-"));
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
assert.equal(ui.checks.length, 6);
assert.ok(ui.pdfDirectory && ui.docxSnapshot);
const actualManifest = await read(
  join(ui.pdfDirectory, "publication-manifest.json"),
);
assert.equal(actualManifest.templateVersion, 2);
assert.equal(actualManifest.snapshotHash, ui.docxSnapshot.hash);
const cases = [];
let boundary;
if (!authorOnly) {
  const docx = await read(
    join(
      root,
      "screenshots",
      stage,
      "illustrated-docx/illustrated-docx-smoke.json",
    ),
  );
  assert.equal(docx.status, "passed");
  const source = docx.cases.find((c) => c.name === "letter-default");
  assert.ok(source);
  const snapshot = await read(
    join(
      root,
      "screenshots",
      stage,
      "illustrated-docx/letter-default/snapshot.json",
    ),
  );
  const imageDirectory = join(
    dirname(source.input),
    "library",
    snapshot.content.bookId,
    "assets/blobs",
  );
  for (const [name, options] of [
    ["a5-default", {}],
    [
      "a4-flow",
      {
        paper: "A4",
        font: "sans",
        size: 12,
        leading: 1.5,
        keepParagraphs: "flow",
      },
    ],
    ["a5-large-wide", { paper: "A5", margin: "wide", size: 18, leading: 2.4 }],
  ])
    cases.push({ name, options, snapshot, imageDirectory });
  boundary = {
    snapshot: ui.docxSnapshot,
    imageDirectory: join(ui.htmlDirectory, "images"),
  };
}
let rendered = { cases: [], boundaries: [], engine: null };
if (!authorOnly) {
  const input = join(work, "input.json"),
    runner = join(work, "runner.cjs");
  await writeFile(input, JSON.stringify({ work, cases, boundary }));
  await build({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: String.raw`
import{app,session}from'electron';import{readFile,writeFile,readdir,mkdir,access}from'node:fs/promises';import{readdirSync,unlinkSync,realpathSync}from'node:fs';import{join,dirname,sep}from'node:path';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';import{createServer}from'node:http';import assert from'node:assert/strict';
import{publicationPdfDocument}from'./packages/novel-domain/publication-pdf.mjs';import{renderPublicationPdf}from'./apps/desktop/publication-pdf.ts';
const work=process.env.ZINOVEL_ILLUSTRATED_PDF_ROOT;
app.setPath('userData',join(work,'profile'));app.on('window-all-closed',()=>{});
const exists=async p=>{try{await access(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}};
async function wait(name){while(!await exists(join(work,name)))await new Promise(r=>setTimeout(r,50))}
async function images(input){const result=new Map();for(const r of input.snapshot.content.resources)if(!result.has(r.image.sha256))result.set(r.image.sha256,await readFile(join(input.imageDirectory,r.image.sha256+'.png')));return result}
app.whenReady().then(async()=>{
 await writeFile(join(work,'ready'),'ready');await wait('go');
 try{
  const input=JSON.parse(await readFile(join(work,'input.json'),'utf8')),renderRoot=join(work,'render'),reports=[],boundaries=[];
  await mkdir(renderRoot);
  const plan=publicationPdfDocument(input.boundary.snapshot),originalImages=await images(input.boundary);
  for(const map of [new Map(),new Map([...originalImages,['f'.repeat(64),Buffer.from('extra')]]),new Map([...originalImages].map(([h,b])=>[h,Buffer.alloc(b.length)]))])await assert.rejects(renderPublicationPdf(plan,renderRoot,map),/PDF发行图/);
  assert.deepEqual(await readdir(renderRoot),[]);boundaries.push('Missing, extra and corrupted inputs refuse before creating a rendering window or files');
  app.once('browser-window-created',()=>{const folder=readdirSync(renderRoot)[0],file=join(renderRoot,folder,'images',input.boundary.snapshot.content.resources[0].image.sha256+'.png');assert.ok(realpathSync(dirname(file)).startsWith(realpathSync(renderRoot)+sep));unlinkSync(file)});
  await assert.rejects(renderPublicationPdf(plan,renderRoot,originalImages),/发行图读取失败/);assert.deepEqual(await readdir(renderRoot),[]);boundaries.push('Actual staged PNG removal rejects with a read error and cleans the HTML plus every remaining PNG');
  app.once('browser-window-created',(_event,window)=>{window.webContents.printToPDF=()=>{window.webContents.forcefullyCrashRenderer();return new Promise(()=>{})}});
  await assert.rejects(renderPublicationPdf(plan,renderRoot,originalImages),/排版进程已退出/);assert.deepEqual(await readdir(renderRoot),[]);boundaries.push('Actual renderer crash after image loading cleans all temporary inputs and releases the single-renderer slot');
  let hits=0;const server=createServer((_req,res)=>{hits++;res.end('unexpected')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const networkUrl='http://127.0.0.1:'+server.address().port+'/blocked.png',secret=join(work,'unapproved.png');await writeFile(secret,originalImages.values().next().value);const secretUrl=pathToFileURL(secret).href;
  const wr=session.fromPartition('zinovel-publication-pdf',{cache:false}).webRequest,originalHook=wr.onBeforeRequest.bind(wr),refused=[];
  wr.onBeforeRequest=listener=>{if(!listener)return originalHook(null);return originalHook((details,callback)=>listener(details,decision=>{if([networkUrl,secretUrl].includes(details.url))refused.push({kind:details.url===networkUrl?'network':'unapproved-file',cancel:decision.cancel});callback(decision)}))};
  try{const html=plan.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace('</body>','<img src="'+networkUrl+'"><img src="'+secretUrl+'"></body>');await renderPublicationPdf({...plan,html,htmlHash:createHash('sha256').update(html).digest('hex')},renderRoot,originalImages);assert.equal(hits,0);assert.equal(refused.length,2);assert.ok(refused.every(r=>r.cancel===true));assert.deepEqual(await readdir(renderRoot),[]);boundaries.push('With CSP deliberately removed in a synthetic plan, the host policy rejects both real loopback HTTP and an unapproved local PNG request; server observes zero requests')}
  finally{wr.onBeforeRequest=originalHook;server.closeAllConnections();await new Promise(r=>server.close(r))}
  for(const item of input.cases){const map=await images(item),document=publicationPdfDocument(item.snapshot,item.options),active=renderPublicationPdf(document,renderRoot,map);await assert.rejects(renderPublicationPdf(document,renderRoot,map),/已有PDF/);const bytes=await active,file=join(work,item.name+'.pdf');await writeFile(file,bytes);assert.deepEqual(await readdir(renderRoot),[]);reports.push({...item,file,bytes:bytes.length})}
  await writeFile(join(work,'result.json'),JSON.stringify({status:'passed',cases:reports,boundaries,engine:{electron:process.versions.electron,chromium:process.versions.chrome}}));
 }catch(e){await writeFile(join(work,'failure.json'),JSON.stringify({status:'failed',error:String(e.stack||e)}))}
 await wait('exit');app.exit((await exists(join(work,'failure.json')))?1:0)
}).catch(e=>{console.error(e);app.exit(1)});
`,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [
      {
        name: "source-sharp",
        setup(b) {
          b.onResolve({ filter: /^sharp$/ }, () => ({
            path: createRequire(import.meta.url).resolve("sharp"),
            external: true,
          }));
        },
      },
    ],
    outfile: runner,
  });
  const env = { ...process.env, ZINOVEL_ILLUSTRATED_PDF_ROOT: work };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [runner], {
    env,
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    owned;
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exists = async (p) => {
    try {
      await access(p);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  };
  const merge = async () => {
    const current = await captureOwnedProcesses(child.pid);
    if (!owned) owned = current;
    else for (const entry of current) owned.set(...entry);
  };
  try {
    await merge();
    await waitForCondition(async () => {
      if (child.exitCode !== null) throw Error(stderr);
      return exists(join(work, "ready"));
    }, "PDF source runner did not become ready");
    await writeFile(join(work, "go"), "go");
    await waitForCondition(
      async () => {
        if (child.exitCode !== null) throw Error(stderr);
        return (
          (await exists(join(work, "result.json"))) ||
          (await exists(join(work, "failure.json")))
        );
      },
      "PDF source runner did not finish",
      180000,
    );
    if (await exists(join(work, "failure.json")))
      throw Error((await read(join(work, "failure.json"))).error);
    rendered = await read(join(work, "result.json"));
    assert.equal(rendered.status, "passed");
  } finally {
    if (child.exitCode === null) {
      await merge();
      await writeFile(join(work, "exit"), "exit");
      try {
        await waitForCondition(
          () => child.exitCode !== null,
          "PDF source runner did not exit",
          15000,
        );
      } catch (e) {
        await terminateOwnedProcesses(owned);
        throw e;
      }
    }
    if (owned) await confirmOwnedProcessesExited(owned);
    await writeFile(join(out, "renderer-output.txt"), stdout + stderr);
  }
  assert.equal(child.exitCode, 0, stderr);
}
function inspect(script, args) {
  const r = spawnSync(
    process.env.ZINOVEL_QA_PYTHON || "python",
    [join(root, "scripts", script), ...args],
    {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw Error(script + ": " + r.stdout + "\n" + r.stderr);
}
const all = [
    ...rendered.cases,
    {
      name: "actual-author-export",
      snapshot: ui.docxSnapshot,
      imageDirectory: join(ui.htmlDirectory, "images"),
      file: join(ui.pdfDirectory, "book.pdf"),
      options: actualManifest.layout,
    },
  ],
  reports = [];
for (const item of all) {
  const directory = join(out, item.name);
  await mkdir(directory, { recursive: true });
  const snapshotFile = join(directory, "snapshot.json"),
    expected = join(directory, "expected.json");
  await writeFile(snapshotFile, JSON.stringify(item.snapshot, null, 2) + "\n");
  await writeFile(
    expected,
    JSON.stringify(
      {
        paper: item.options.paper || "A5",
        required: [
          ...Object.values(item.snapshot.content.metadata).filter(Boolean),
          ...item.snapshot.content.chapters.flatMap((c) => [c.title, c.body]),
          ...item.snapshot.content.resources
            .flatMap((r) => [r.caption, r.credit])
            .filter(Boolean),
        ],
        forbidden: [
          "PRIVATE_IMAGE_",
          "PRIVATE_SOURCE_",
          "UNSELECTED_CHAPTER_SENTINEL",
        ],
        ordered: item.snapshot.content.chapters.map((c) => c.title),
      },
      null,
      2,
    ) + "\n",
  );
  inspect("inspect-publication-pdf.py", [item.file, expected, directory]);
  inspect("inspect-publication-pdf-images.py", [
    item.file,
    snapshotFile,
    item.imageDirectory,
    directory,
    "--margin",
    String(item.options.margin === "wide" ? 22 : 16),
  ]);
  reports.push({
    name: item.name,
    file: item.file,
    options: item.options,
    inspection: await read(join(directory, "inspection.json")),
    images: await read(join(directory, "pdf-image-inspection.json")),
  });
}
const report = {
  status: "passed",
  version: ui.version,
  packaged: ui.packaged,
  ...(ui.appAsarSha256 ? { appAsarSha256: ui.appAsarSha256 } : {}),
  checks: [
    "Actual author PDF retains all frozen public text, fonts, paper, ordered headings and page labels; independent inspection verifies source snapshot and final PDF hash",
    "Actual author PDF has exact image placements and public alternative text; five flat-patch raster samples per image match the frozen PNG and fit print margins",
    ...(!authorOnly
      ? [
          "Three source A4/A5 layouts render frozen portrait/landscape/translucent images and long captions with complete text, all page images and bounded geometry",
          "Actual source renderer refuses bad image inputs, recovers after missing staged PNG and forced renderer crash, denies loopback and unapproved local files independently of CSP, and retains the single-renderer lock",
        ]
      : []),
  ],
  scope: authorOnly
    ? "Actual author executable PDF only; independent source-image sample, structure and rendered page checks; no full photo fidelity, screen-reader or store qualification"
    : "Three source generator layouts, source renderer fault/security cases and actual author PDF are distinguished; synthetic fixtures only; no installed-app claim for source cases",
  sourceEngine: rendered.engine,
  actualAuthorEngine: actualManifest.engine,
  boundaries: rendered.boundaries,
  reports,
};
await writeFile(
  join(out, "illustrated-pdf-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  reports.map((r) => ({
    name: r.name,
    pages: r.images.pages,
    placements: r.images.imageSamples.length,
  })),
);
