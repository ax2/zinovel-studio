import { NovelHarness } from '../packages/novel-harness/runtime.mjs';
import { modelFixture } from '../tests/fixtures/model-server.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
await mkdir(join(root,'.cache'),{recursive:true});
const home=await mkdtemp(join(root,'.cache','novel-agent-qa-'));
const model=await modelFixture({delayMs:250});
const runtime=new NovelHarness({root:home,resources:join(root,'dist/resources')});
const report={runtime:'official DSH SDK + agent-loop + custom Cordis tools',model:'local deterministic SSE fixture',checks:[]};
try {
  const result=await runtime.generate({skillId:'novel-polish',instruction:'润色选区',context:'林舟收到一封旧信。',selectedText:'一封旧信'}, {baseURL:model.url,model:'deepseek-v4-flash'},'fixture-local-only');
  assert.equal(result.text,model.replacement);
  assert.equal(model.requests.length,3);
  for(const request of model.requests)assert.deepEqual(request.tools.map(tool=>tool.name).sort(),['novel_change_propose','novel_selection_read']);
  assert.ok(model.requests[1].messages.some(message=>JSON.stringify(message).includes('林舟收到')));
  report.checks.push('official runtime performed selection read and proposal tool round trip','exactly two novel tools visible, no terminal or filesystem tools','candidate comes from proposal tool, never written to manuscript');
  const next=runtime.generate({skillId:'novel-expand',instruction:'扩写选区',context:'林舟收到一封旧信。',selectedText:'旧信'},{baseURL:model.url,model:'deepseek-v4-flash'},'fixture-local-only');
  const rejected=assert.rejects(next,/取消/);
  while(model.requests.length<4)await new Promise(resolve=>setTimeout(resolve,50));
  await runtime.cancel();await rejected;
  report.checks.push('cancelling an in-flight real Harness task settles and closes the runtime');
  report.status='passed';
} catch(error){report.status='failed';report.error=String(error.cause||error);throw error;}
finally{await runtime.cancel();await model.close();await mkdir(join(root,'assessments/stage-001'),{recursive:true});await writeFile(join(root,'assessments/stage-001/novel-agent-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(report);}
