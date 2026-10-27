import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import {
  captureProjectDocuments,
  projectScaffold,
} from "../packages/novel-domain/book-project.mjs";
import {
  scanNovelProject,
  ProjectImportSessions,
} from "../packages/novel-storage/project-import.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-project-")),
    store = new NovelStore(join(root, "library"));
  await store.initialize();
  const book = await store.createBook("合成雾港𠮷");
  return { root, store, book, bookRoot: join(store.root, book.id) };
}
test("desktop new-book option creates all thirteen explicitly labeled templates in its initial transaction", async () => {
  const { store } = await fixture();
  const book = await store.createBook("新建工程", true);
  const docs = (await store.project.list(book.id)).documents;
  assert.equal(docs.length, 13);
  assert.ok(docs.every((d) => d.origin === "scaffold"));
  for (const d of docs)
    assert.match(
      (await store.project.read(book.id, d.id)).text,
      /待填写的创作模板/,
    );
  assert.equal(book.chapters.length, 0);
});
test("project docs preserve raw Unicode/CRLF and external edit preimages, share backup provenance and restore as editable new versions", async () => {
  const { root, store, book, bookRoot } = await fixture();
  assert.equal((await store.project.list(book.id)).initialized, false);
  await store.project.initialize(book.id);
  let d = (await store.project.list(book.id)).documents.find(
    (d) => d.path === "outline/master-plan.md",
  );
  const original = await store.project.read(book.id, d.id);
  const external = "\uFEFF# 外部总纲\r\n𠮷🌊\r\n";
  await writeFile(join(bookRoot, d.path), external);
  await assert.rejects(
    store.project.save(book.id, { ...original, text: "过期覆盖" }),
    /已改变/,
  );
  d = await store.project.read(book.id, d.id);
  assert.equal(d.externalChange, true);
  assert.equal(d.text, external);
  const saved = await store.project.save(book.id, {
    ...d,
    text: external + "作者新增\r\n",
  });
  assert.equal(saved.revision, 2);
  assert.equal(
    (await store.project.history(book.id, d.id, 1)).text,
    original.text,
  );
  assert.equal(
    (await store.project.history(book.id, d.id, 2)).before.text,
    external,
  );
  const backupRoot = join(root, "backup");
  await mkdir(backupRoot);
  const backup = await store.createBackup(book.id, backupRoot),
    restored = await store.restoreBackup(backup.path);
  assert.equal((await store.project.read(restored.id, d.id)).text, saved.text);
  const updated = await store.project.save(restored.id, {
    ...saved,
    text: saved.text + "恢复作品续写",
  });
  assert.equal(
    (await store.project.history(restored.id, d.id, 3)).writtenInBookId,
    restored.id,
  );
  assert.equal((await store.project.read(book.id, d.id)).text, saved.text);
  assert.notEqual(updated.hash, saved.hash);
});
test("project initialization refuses occupied author files and unknown manifests, never overwrites originals", async () => {
  const { store, book, bookRoot } = await fixture();
  await writeFile(join(bookRoot, "README.md"), "已有用户说明");
  await assert.rejects(store.project.initialize(book.id), /前像/);
  assert.equal(
    await readFile(join(bookRoot, "README.md"), "utf8"),
    "已有用户说明",
  );
  await assert.rejects(
    readFile(join(bookRoot, ".zinovel/project-assets.json")),
    { code: "ENOENT" },
  );
  await writeFile(
    join(bookRoot, ".zinovel/project-assets.json"),
    '{"schemaVersion":999}',
  );
  await assert.rejects(store.project.list(book.id), /版本或来源/);
});
test("new asset creation checks collision/capacity/path rules and queued saves capture original input", async () => {
  const { store, book, bookRoot } = await fixture();
  await store.project.initialize(book.id);
  const a = await store.project.create(book.id, {
    path: "worldbuilding/characters/安宁.md",
    text: "# 安宁\n",
  });
  const input = { ...a, text: "原请求𠮷" },
    save = store.project.save(book.id, input);
  input.text = "队列后篡改";
  assert.equal((await save).text, "原请求𠮷");
  await assert.rejects(
    store.project.create(book.id, { path: a.path, text: "重复" }),
    /已存在/,
  );
  await mkdir(join(bookRoot, "outline/extra"));
  await writeFile(join(bookRoot, "outline/extra/external.md"), "外部独立资产");
  await assert.rejects(
    store.project.create(book.id, {
      path: "outline/extra/external.md",
      text: "覆盖",
    }),
    /前像/,
  );
  for (const path of [
    "../book.json",
    "outline/../book.json",
    "outline/NUL.md",
    "outline/x. /a.md",
    "manuscript/chapter-001.md",
    "outline/a\\b.md",
    "outline/a.md:secret",
    "outline/a\u0001.md",
    "outline/e\u0301.md",
  ])
    assert.throws(() => captureProjectDocuments([{ path, text: "x" }]));
  assert.throws(
    () =>
      captureProjectDocuments([
        { path: "outline/A.md", text: "x" },
        { path: "outline/a.md", text: "y" },
      ]),
    /重复/,
  );
  assert.throws(
    () => captureProjectDocuments([{ path: "outline/a.md", text: "\ud800" }]),
    /UTF-8/,
  );
});
async function sourceFixture(root) {
  const source = join(root, "harbor");
  const values = new Map([
    ["README.md", "# 合成雾港\r\n工程说明\r\n"],
    ["outline/master-plan.md", "\uFEFF# 总纲\r\n主线𠮷🌊\r\n"],
    ["outline/volume-01-chapters-detail.md", "# 细纲\n局面变化\n"],
    ["worldbuilding/characters/anning.md", "# 安宁\n人物的独立愿望"],
    ["production/state/current-state.md", "# 当前状态\n未回收的旧信"],
    ["manuscript/volume-01/chapter-001.md", "# 第001章 渡口\r\n合成正文𠮷\r\n"],
    [
      "production/publish/chapter-001.frontmatter.yml",
      'novelSlug: harbor\nvolume: 1\nchapterInVolume: 1\nglobalIndex: 1\ntitle: "第001章 渡口"\n',
    ],
    ["assets/images/chapter-001/README.md", "# 配图登记\n待画的渡口"],
    [
      "assets/images/chapter-001/image.png",
      "NOT_AN_IMAGE_DO_NOT_IMPORT_AS_TEXT",
    ],
  ]);
  for (const [path, text] of values) {
    const absolute = join(source, ...path.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, text);
  }
  return { source, values };
}
test("writing skill project imports outlines, detail, state, characters and YAML into one new book without confusing them with chapters", async () => {
  const { root, store } = await fixture(),
    { source, values } = await sourceFixture(root),
    sessions = new ProjectImportSessions(store);
  const preview = await sessions.preview(source);
  assert.equal(preview.chapterCount, 1);
  assert.equal(preview.documents.length, 7);
  assert.ok(preview.ignored.includes("assets/images/chapter-001/image.png"));
  const book = await sessions.confirm(preview.token, preview.fingerprint);
  assert.equal(book.chapters.length, 1);
  assert.equal(book.volumes.length, 1);
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    values.get("manuscript/volume-01/chapter-001.md"),
  );
  const d = (await store.project.list(book.id)).documents.find(
    (d) => d.path === "outline/master-plan.md",
  );
  assert.equal(
    (await store.project.read(book.id, d.id)).text,
    values.get(d.path),
  );
  for (const [path, text] of values)
    assert.equal(
      await readFile(join(source, ...path.split("/")), "utf8"),
      text,
    );
  await assert.rejects(
    sessions.confirm(preview.token, preview.fingerprint),
    /失效/,
  );
});
test("changed source and invalid chapter sidecars block confirmation before creating a book", async () => {
  const { root, store } = await fixture(),
    { source } = await sourceFixture(root),
    sessions = new ProjectImportSessions(store);
  const preview = await sessions.preview(source),
    before = (await store.listBooks()).books.length;
  await writeFile(join(source, "outline/master-plan.md"), "# 外部更新");
  await assert.rejects(
    sessions.confirm(preview.token, preview.fingerprint),
    /源工程已改变/,
  );
  assert.equal((await store.listBooks()).books.length, before);
  await writeFile(
    join(source, "production/publish/chapter-001.frontmatter.yml"),
    "novelSlug: harbor\nvolume: 1\nchapterInVolume: 1\nglobalIndex: 2\ntitle: 第001章 渡口\n",
  );
  await assert.rejects(scanNovelProject(source), /旁车/);
});
test("Astro novel index imports exact chapter content and volume names while explicitly reporting absent private planning assets", async () => {
  const { root } = await fixture(),
    content = join(root, "src/content"),
    novels = join(content, "novels"),
    chapters = join(content, "novel-chapters/harbor");
  await mkdir(novels, { recursive: true });
  await mkdir(chapters, { recursive: true });
  const index = join(novels, "harbor.md");
  await writeFile(
    index,
    "---\ntitle: 合成站点小说\nslug: harbor\nvolumeTitles:\n  - volume: 1\n    title: 第一卷 雾港\n---\n\n## 简介\n合成公开简介\n",
  );
  await writeFile(
    join(chapters, "001.md"),
    "---\nnovelSlug: harbor\nvolume: 1\nchapterInVolume: 1\nglobalIndex: 1\ntitle: 第001章 渡口\n---\n\n正文𠮷\r\n",
  );
  const result = await scanNovelProject(index);
  assert.equal(result.chapters[0].volume, "第一卷 雾港");
  assert.equal(result.chapters[0].body, "\n正文𠮷\r\n");
  assert.ok(result.missing.includes("outline/master-plan.md"));
  await writeFile(index, "---\ntitle: a\ntitle: b\n---\n");
  await assert.rejects(scanNovelProject(index), /YAML/);
});
test("planning-only projects remain valid projects without fabricated trial prose and linked directories cannot escape the chosen source", async () => {
  const { root, store } = await fixture(),
    source = join(root, "planning-only");
  await mkdir(join(source, "outline"), { recursive: true });
  await writeFile(
    join(source, "outline/master-plan.md"),
    "# 仅有总纲\n真实计划",
  );
  const sessions = new ProjectImportSessions(store),
    preview = await sessions.preview(source),
    b = await sessions.confirm(preview.token, preview.fingerprint);
  assert.equal(b.chapters.length, 0);
  assert.equal((await store.project.list(b.id)).documents.length, 1);
  const target = join(root, "outside");
  await mkdir(target);
  await symlink(
    target,
    join(source, "worldbuilding"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(scanNovelProject(source), /链接/);
});
