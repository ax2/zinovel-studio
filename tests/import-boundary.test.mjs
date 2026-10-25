import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewImport,
  splitManuscript,
} from "../packages/novel-storage/importer.mjs";

async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), "zinovel-import-boundary-"));
  const source = join(dir, "原稿.txt"),
    trigger = join(dir, "扫描结束.md");
  await fs.writeFile(source, "原始合成正文");
  await fs.writeFile(trigger, "另一章");
  return { dir, source, trigger };
}

// Swap/grow a real file after its enumeration stat and before the reader opens it.
// No production hook: synchronise the built-in export only in this test process.
async function afterScan(t, source, trigger, mutate, check) {
  const original = fs.lstat;
  let changed = false;
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await original(...args);
    if (args[0] === trigger && !changed) {
      changed = true;
      await mutate();
    }
    return stat;
  });
  syncBuiltinESMExports();
  try {
    await check(() => previewImport([source, trigger]));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(changed, true);
}

test("overlapping selections count unique files rather than selection occurrences", async () => {
  const { source } = await fixture();
  const result = await previewImport(Array(2001).fill(source));
  assert.equal(result.sources.length, 1);
  assert.equal(result.chapters.length, 1);
  assert.equal(await fs.readFile(source, "utf8"), "原始合成正文");
});

test("file growth after enumeration still enforces the individual 32 MiB limit", async (t) => {
  const { source, trigger } = await fixture();
  await afterScan(
    t,
    source,
    trigger,
    () => fs.truncate(source, 32 * 1024 * 1024 + 1),
    (run) => assert.rejects(run(), /32 MiB/),
  );
  assert.equal((await fs.stat(source)).size, 32 * 1024 * 1024 + 1);
});

test("replacement after enumeration is rejected without reading the replacement as the selected file", async (t) => {
  const { source, trigger } = await fixture(),
    saved = `${source}.original`;
  await afterScan(
    t,
    source,
    trigger,
    async () => {
      await fs.rename(source, saved);
      await fs.writeFile(source, "替换后的另一个文件");
    },
    (run) => assert.rejects(run(), /改变|变化/),
  );
  assert.equal(await fs.readFile(saved, "utf8"), "原始合成正文");
  assert.equal(await fs.readFile(source, "utf8"), "替换后的另一个文件");
});

test("a source growing during the handle read cannot force an unbounded read", async (t) => {
  const { source } = await fixture(),
    original = fs.open;
  const size = (await fs.stat(source)).size;
  let requested = 0,
    mutated = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      requested += readArgs[2];
      if (!mutated) {
        mutated = true;
        await fs.truncate(source, 32 * 1024 * 1024 + 1);
      }
      return read(...readArgs);
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(previewImport([source]), /32 MiB/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(mutated, true);
  assert.equal(requested, size + 1);
});

test("chapter limit is enforced while splitting and across source files", async () => {
  const text = Array.from(
    { length: 2000 },
    (_, i) => `第${i + 1}章 合成\n内容`,
  ).join("\n");
  assert.equal(splitManuscript(text, "默认").length, 2000);
  assert.throws(
    () => splitManuscript(`${text}\n第2001章 过量`, "默认"),
    /2000 章/,
  );
  const { source, trigger } = await fixture();
  await fs.writeFile(source, text);
  await assert.rejects(previewImport([source, trigger]), /2000 章/);
  assert.equal(await fs.readFile(source, "utf8"), text);
});

test("incremental line parsing preserves BOM/CRLF/empty lines and code-point counts", async () => {
  const { source } = await fixture();
  await fs.writeFile(source, "\uFEFF第一章 雨\r\n𠮷🙂\r\n\r\n尾\r\n");
  const preview = await previewImport([source]);
  assert.equal(preview.chapters[0].body, "𠮷🙂\n\n尾\n");
  assert.equal(preview.totalCharacters, 6);
  assert.deepEqual(
    splitManuscript("第一章 空\n第二章 空\n", "默认").map((x) => x.body),
    ["", ""],
  );
});
