import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const manifest=JSON.parse(await readFile('apps/desktop/upstream/provenance.json','utf8'));
for(const file of manifest.files){const bytes=await readFile(`apps/desktop/upstream/${file.name}`);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name);}
console.log(`Verified ${manifest.files.length} official desktop source/license files at ${manifest.commit}`);
