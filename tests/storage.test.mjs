import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovelStore, digest } from '../packages/novel-storage/store.mjs';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zinovel-test-'));
  const store = new NovelStore(root);
  const book = await store.createBook('雾港来信');
  const { chapter } = await store.createChapter(book.id, '第一章 旧信');
  return { root, store, book, chapter };
}
test('Chinese manuscript survives restart and keeps durable previous revisions', async () => {
  const {root,store,book,chapter} = await setup();
  const body = '林舟望着港口。\n\n“信在这里。”𠮷🙂';
  const saved = await store.saveChapter({bookId:book.id, chapterId:chapter.id, expectedRevision:1, expectedHash:digest(''),title:chapter.title,body});
  assert.equal(saved.status,'saved');
  const reopened = await new NovelStore(root).readChapter(book.id,chapter.id);
  assert.equal(reopened.body,body);
  assert.equal(reopened.revision,2);
  assert.equal((await store.history(book.id,chapter.id)).length,2);
});
test('external edit and competing application writes cannot be silently overwritten', async () => {
  const {root,store,book,chapter} = await setup();
  const input={bookId:book.id,chapterId:chapter.id,expectedRevision:1,expectedHash:digest(''),title:chapter.title,body:'本地'};
  const results=await Promise.all([store.saveChapter(input),store.saveChapter({...input,body:'另一个窗口'})]);
  assert.deepEqual(results.map(r=>r.status),['saved','conflict']);
  const path=join(root,book.id,'manuscript',`${chapter.id}.md`);
  await writeFile(path,'外部编辑','utf8');
  const result=await store.saveChapter({...input,expectedRevision:2,expectedHash:digest('本地')});
  assert.equal(result.status,'conflict');
  assert.equal(await readFile(path,'utf8'),'外部编辑');
});
test('interrupted multi-file transaction completes on reopen', async () => {
  const {root,store,book,chapter} = await setup();
  const base=join(root,book.id), before=await readFile(join(base,'book.json'),'utf8');
  const manifest=JSON.parse(before); manifest.title='恢复后的书名';
  const pending={id:'recovery-fixture',at:new Date().toISOString(),entries:[{path:'book.json',before,after:JSON.stringify(manifest)},{path:`manuscript/${chapter.id}.md`,before:'',after:'断电前的正文'}]};
  await writeFile(join(base,'.zinovel','pending.json'),JSON.stringify(pending));
  await writeFile(join(base,'book.json'),JSON.stringify(manifest));
  const reopened=await new NovelStore(root).readChapter(book.id,chapter.id);
  assert.equal(reopened.body,'断电前的正文');
  assert.equal((await store.listBooks()).books[0].title,'恢复后的书名');
});
test('invalid paths and unsupported schema fail without altering the source', async () => {
  const {root,store,book,chapter}=await setup();
  await assert.rejects(store.readChapter('../outside',chapter.id));
  const path=join(root,book.id,'book.json');
  const manifest=JSON.parse(await readFile(path,'utf8'));manifest.schemaVersion=99;
  await writeFile(path,JSON.stringify(manifest));
  const result=await store.listBooks();assert.equal(result.books.length,0);assert.equal(result.errors.length,1);
  assert.equal(JSON.parse(await readFile(path,'utf8')).schemaVersion,99);
});
