import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

// Real upstream SDK and agent process; only the remote model is a local fixture.
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.cache'), { recursive: true });
const home = await mkdtemp(join(root, '.cache', 'harness-qa-'));
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: request.url, tools: (body.tools || []).map(tool => tool.name) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'novel_qa', model: 'deepseek-v4-flash', usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '灯塔熄灭时，林舟终于拆开了旧信。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 18 } },
      { type: 'message_stop' },
    ];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch { response.writeHead(500).end('fixture failure'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-key-local-only', DEEPSEEK_BASE_URL: endpoint };
delete env.DSH_HOME; delete env.NODE_OPTIONS;
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', patches: [join(root, 'packages/novel-harness/novel.patch.yml')], dshHome: home, cwd: home, processCwd: root, env, initializeTimeoutMs: 30000, requestTimeoutMs: 30000, model: 'deepseek-v4-flash', reasoningEffort: 'off', maxTokens: 1000 });
const report = { runtime: '@deepseek-ai/dsh@0.2.1-rc.2', model: 'local deterministic SSE fixture, not live DeepSeek', requests };
try {
  await harness.start();
  const result = await harness.run('请给旧港收到一封信的场景写一句试写正文。');
  assert.ok(JSON.stringify(result.finalResponse).includes('林舟'));
  assert.ok(requests.length > 0);
  assert.deepEqual(requests.flatMap(request => request.tools), []);
  report.status = 'passed'; report.events = result.events.length;
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  await harness.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await mkdir(join(root, 'assessments/stage-001'), { recursive: true });
  await writeFile(join(root, 'assessments/stage-001/harness-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
