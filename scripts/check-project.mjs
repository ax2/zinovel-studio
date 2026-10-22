import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const data = p => JSON.parse(read(p));
const errors = [];
const assert = (ok, message) => { if (!ok) errors.push(message); };
const features = data('plan/features.json').features;
const skills = data('skills/catalog.json').skills;
const tools = data('contracts/tool-catalog.json').tools;
for (const [kind, items, key] of [['feature',features,'id'],['skill',skills,'id'],['tool',tools,'name']]) {
  assert(new Set(items.map(x => x[key])).size === items.length, `Duplicate ${kind} IDs`);
}
for (const f of features) {
  assert(['planned','in-progress','verified'].includes(f.status), `${f.id}: invalid implementation status`);
  if(f.status!=='planned')assert(Array.isArray(f.evidence)&&f.evidence.length>0&&f.evidence.every(p=>existsSync(resolve(root,p))),`${f.id}: implementation evidence missing`);
  if(f.status==='verified')assert(typeof f.validation==='string'&&existsSync(resolve(root,f.validation)),`${f.id}: acceptance report required`);
  assert(/^Stage-00[1-8]$/.test(f.stage), `${f.id}: invalid stage`);
  assert(['P0','P1','P2'].includes(f.priority) && f.acceptance.length > 0, `${f.id}: missing acceptance`);
}
for (const s of skills) {
  const body = read(s.path);
  assert(body.startsWith(`---\nname: ${s.id}\ndescription: `), `${s.id}: invalid skill header`);
  assert(body.includes('\n---\n') && body.length > 200, `${s.id}: missing instructions`);
  assert(features.some(f => f.id === s.featureId), `${s.id}: unknown feature`);
  assert(s.runtimeVerified === false, `${s.id}: no runtime evidence in Stage-000`);
}
for (const t of tools) assert(t.implemented === false, `${t.name}: no implementation in Stage-000`);
const lock = data('upstream.lock.json');
assert(lock.repository === 'https://github.com/deepseek-ai/deepseek-harness', 'Wrong upstream');
assert(/^[0-9a-f]{40}$/.test(lock.commit) && lock.desktopPath === 'apps/desktop', 'Invalid upstream pin');
let markdown = 0;
function walk(dir) {
  for (const e of readdirSync(dir, {withFileTypes:true})) {
    if (['.git','node_modules','vendor','work','.cache','dist','release'].includes(e.name)) continue;
    const p = resolve(dir,e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (e.name.endsWith('.json')) { try { JSON.parse(readFileSync(p,'utf8')); } catch { errors.push(`Invalid JSON: ${p}`); } }
    if (!e.name.endsWith('.md')) continue;
    markdown++;
    const text = readFileSync(p,'utf8');
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      assert(existsSync(resolve(dirname(p), target)), `Broken local link: ${p} -> ${target}`);
    }
  }
}
walk(root);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(JSON.stringify({status:'passed',features:features.length,skills:skills.length,toolContracts:tools.length,markdownFiles:markdown,scope:'Planning structure only; no desktop/runtime/model verification'},null,2));
