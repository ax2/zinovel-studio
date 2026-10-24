import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  packed = join(root, "release/win-unpacked");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "packed-image-probe-"));
const runner = join(work, "probe.cjs");
await writeFile(
  runner,
  `const fs=require('node:fs'),originalFs=require('original-fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
(async()=>{
const asar=fs.realpathSync(process.argv[2]),request=createRequire(path.join(asar,'package.json')),pkg=request('./package.json');
const sharpPath=request.resolve('sharp');assert.ok(sharpPath.startsWith(asar+path.sep));
const sharp=request('sharp');assert.equal(sharp.versions.sharp,pkg.dependencies.sharp);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const noticeRoot=path.join(asar,'licenses/image-runtime'),provenance=JSON.parse(fs.readFileSync(path.join(noticeRoot,'provenance.json'),'utf8'));
const notices=[];for(const [name,digest]of Object.entries(provenance.files)){assert.equal(hash(fs.readFileSync(path.join(noticeRoot,name))),digest);notices.push(name);}
for(const name of ['GPL-3.0.txt','LGPL-3.0.txt'])assert.ok(notices.includes(name));
const directory=path.join(asar+'.unpacked','node_modules/@img/sharp-win32-x64/lib');
const nativeFiles=[];for(const name of fs.readdirSync(directory)){if(!/\\.(dll|node)$/i.test(name))continue;const file=path.join(directory,name);fs.accessSync(file,fs.constants.R_OK|fs.constants.W_OK);nativeFiles.push({name,sha256:hash(fs.readFileSync(file)),bytes:fs.statSync(file).size});}
assert.ok(nativeFiles.some(file=>file.name.endsWith('.node')));assert.ok(nativeFiles.some(file=>file.name.startsWith('libvips')&&file.name.endsWith('.dll')));
for(const format of ['png','jpeg','webp']){const bytes=await sharp({create:{width:32,height:48,channels:3,background:'#126b83'}})[format]().toBuffer();const meta=await sharp(bytes).metadata();assert.equal(meta.width,32);assert.equal(meta.height,48);}
console.log(JSON.stringify({status:'passed',version:pkg.version,node:process.versions.node,sharp:sharp.versions.sharp,vips:sharp.versions.vips,appAsarSha256:hash(originalFs.readFileSync(asar)),notices,nativeFiles,scope:'Packaged EXE embedded Node, app-local native modules, actual three-format decode, unpacked writable DLLs and exact retained licence bytes; not modified-DLL execution or complete distribution certification'}));
})().catch(error=>{console.error(error);process.exitCode=1;});`,
);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
for (const key of Object.keys(env))
  if (["node_path", "node_options", "path"].includes(key.toLowerCase()))
    delete env[key];
env.PATH = join(process.env.SystemRoot || "C:\\Windows", "System32");
const result = spawnSync(
  join(packed, "ZiNovel Studio.exe"),
  [runner, join(packed, "resources/app.asar")],
  {
    cwd: work,
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout.trim());
assert.equal(report.status, "passed");
assert.equal(report.version, pkg.version);
assert.equal(report.sharp, pkg.dependencies.sharp);
await writeFile(
  join(root, "release/image-runtime-verification.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
