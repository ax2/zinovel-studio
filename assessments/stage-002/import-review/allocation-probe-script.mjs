import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root='D:/work/zinovel-studio';
const old=root+'/.cache/importer-alpha36-frozen.mjs',source=root+'/.cache/import-allocation-synthetic.txt';
fs.writeFileSync(old,execFileSync('git',['show','v0.1.0-alpha.36:packages/novel-storage/importer.mjs'],{cwd:root,windowsHide:true}));
fs.writeFileSync(source,'𠮷🙂x\n'.repeat(1677721));
const worker=`const {previewImport}=await import(process.argv[1]);global.gc();const rss=process.memoryUsage().rss,start=performance.now();const p=await previewImport([process.argv[2]]);process.stdout.write(JSON.stringify({elapsedMs:Math.round(performance.now()-start),rssBefore:rss,rssAfter:process.memoryUsage().rss,maxRssKiB:process.resourceUsage().maxRSS,characters:p.totalCharacters,sources:p.sources.length,chapters:p.chapters.length,sourceSha256:p.sources[0].sha256}));`;
const runs=[];
for (let i=0;i<3;i++) for(const [label,module] of [['alpha36',old],['alpha37',root+'/packages/novel-storage/importer.mjs']]){
const output=execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',worker,pathToFileURL(module).href,source],{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});runs.push({label,iteration:i+1,...JSON.parse(output)});
}
for(const r of runs){assert.equal(r.characters,6710884);assert.equal(r.sources,1);assert.equal(r.chapters,1);assert.equal(r.sourceSha256,runs[0].sourceSha256);}
const result={status:'passed',scope:'Six isolated Node26 processes, one synthetic 16777210-byte Unicode/newline file; actual filesystem preview, not Electron/IPC, UI latency or large-book p95 qualification',runs};
fs.writeFileSync(root+'/assessments/stage-002/import-boundary/allocation-probe-manual.json',JSON.stringify(result,null,2)+'\n');console.log(result);
