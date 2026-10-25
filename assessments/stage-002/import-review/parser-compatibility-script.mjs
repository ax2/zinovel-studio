import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {splitManuscript as previous} from './importer-alpha36-frozen.mjs';
import {splitManuscript as current} from 'file:///D:/work/zinovel-studio/packages/novel-storage/importer.mjs';
const lines=['',' ','正文𠮷🙂','第一章 信','# 第二章 灯','第3章　雨','第一卷 海港','第二卷 远海','## 标题','尾声','　空白　'];
let seed=37;
for(let i=0;i<1000;i++){
 const parts=[];for(let j=0;j<(i%19)+1;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;parts.push(lines[seed%lines.length]);}
 const text=(i%3===0?'\uFEFF':'')+parts.join(i%2?'\r\n':'\n')+(i%5===0?'\n':'');
 assert.deepEqual(current(text,'默认章'),previous(text,'默认章'),`sample ${i}`);
}
const result={status:'passed',cases:1000,seed:37,baseline:'v0.1.0-alpha.36',importerSha256:createHash('sha256').update(readFileSync('packages/novel-storage/importer.mjs')).digest('hex'),scope:'Controlled deterministic source parser compatibility for whitespace/BOM/CRLF/heading/volume combinations; not independent literary semantics or all external files'};
writeFileSync('assessments/stage-002/import-review/parser-compatibility.json',JSON.stringify(result,null,2)+'\n');console.log(result);

