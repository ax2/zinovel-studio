import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  realpath,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { exportPublication } from "../packages/novel-storage/publication-export.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "novel-export-"));
  const store = new NovelStore(join(root, "library"));
  const book = await store.importBook("内部书目不可自动外发", [
    {
      title: "旧信",
      body: "\ufeff第一段𠮷🌊\r\n<script>globalThis.LEAK=true</script>",
    },
    { title: "渡口", body: "最后一段。" },
    { title: "未选章节", body: "EXCLUDED_SECRET" },
  ]);
  const catalog = await store.publication.catalog(book.id);
  const snapshot = await store.publication.capture(book.id, {
    catalogHash: catalog.hash,
    chapterIds: book.chapters.slice(0, 2).map((ch) => ch.id),
    metadata: {
      title: "公开书名",
      author: "合成作者",
      synopsis: "公开简介",
      rights: "测试数据",
      aiDisclosure: "合成",
    },
  });
  const parent = join(root, "中文 空格 导出目录");
  await mkdir(parent);
  const source = join(
    root,
    "library",
    book.id,
    "manuscript",
    book.chapters[0].id + ".md",
  );
  return {
    root,
    store,
    book,
    snapshot,
    parent,
    source,
    before: await readFile(source),
  };
}
async function verify(result) {
  const raw = await readFile(
      join(result.path, "publication-manifest.json"),
      "utf8",
    ),
    manifest = JSON.parse(raw);
  assert.equal(manifest.state, "exported");
  assert.equal(manifest.snapshotHash, result.snapshotHash);
  assert.equal(manifest.hash, digest(JSON.stringify(manifest.files)));
  for (const file of manifest.files) {
    const bytes = await readFile(join(result.path, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256);
    assert.doesNotMatch(
      bytes.toString("utf8"),
      /EXCLUDED_SECRET|内部书目不可自动外发/,
    );
  }
  assert.doesNotMatch(raw, /中文 空格 导出目录|AppData/);
  return manifest;
}
test("TXT, Markdown and HTML write verified standalone directories from the exact frozen snapshot", async () => {
  const f = await fixture();
  await writeFile(f.source, "作者明确外部改稿，不应替换冻结产物。");
  for (const format of ["txt", "md", "html"]) {
    const result = await exportPublication(f.snapshot, f.parent, format);
    assert.equal(dirname(result.path), await realpath(f.parent));
    const manifest = await verify(result);
    assert.equal(manifest.format, format);
    if (format === "html") {
      const first = await readFile(
        join(result.path, "chapters", f.book.chapters[0].id + ".html"),
        "utf8",
      );
      assert.match(first, /&lt;script&gt;globalThis.LEAK=true&lt;\/script&gt;/);
      assert.doesNotMatch(first, /<script>globalThis.LEAK/);
    } else {
      const text = await readFile(join(result.path, `book.${format}`), "utf8");
      assert.ok(text.includes(f.before.toString("utf8")));
      assert.ok(text.indexOf("第一段") < text.indexOf("最后一段"));
      assert.doesNotMatch(text, /未分卷|作者明确外部改稿/);
    }
  }
  assert.equal(
    await readFile(f.source, "utf8"),
    "作者明确外部改稿，不应替换冻结产物。",
  );
  assert.equal((await readdir(f.parent)).length, 3);
});
test("an existing export and unrelated files are never overwritten on repeated export identity", async () => {
  const f = await fixture(),
    id = randomUUID();
  const result = await exportPublication(f.snapshot, f.parent, "html", id);
  const before = await readFile(join(result.path, "publication-manifest.json"));
  await writeFile(join(f.parent, "unrelated.txt"), "原目录自己的文件");
  await assert.rejects(
    exportPublication(f.snapshot, f.parent, "html", id),
    /已存在/,
  );
  assert.deepEqual(
    await readFile(join(result.path, "publication-manifest.json")),
    before,
  );
  assert.equal(
    await readFile(join(f.parent, "unrelated.txt"), "utf8"),
    "原目录自己的文件",
  );
  await verify(result);
  assert.deepEqual(await readFile(f.source), f.before);
});
test("bad snapshot, unsupported format, invalid identity and non-directory targets fail without modifying targets", async () => {
  const f = await fixture(),
    bad = structuredClone(f.snapshot);
  bad.content.chapters[0].body = "不能偷换的正文";
  await assert.rejects(exportPublication(bad, f.parent, "txt"), /hash/);
  await assert.rejects(exportPublication(f.snapshot, f.parent, "pdf"), /格式/);
  await assert.rejects(
    exportPublication(f.snapshot, f.parent, "txt", "../outside"),
    /身份/,
  );
  const file = join(f.parent, "existing.txt");
  await writeFile(file, "原文件");
  await assert.rejects(exportPublication(f.snapshot, file, "txt"), /目录/);
  assert.deepEqual(await readdir(f.parent), ["existing.txt"]);
  assert.equal(await readFile(file, "utf8"), "原文件");
  assert.deepEqual(await readFile(f.source), f.before);
});
