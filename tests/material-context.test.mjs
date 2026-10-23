import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { materialContextText } from "../packages/novel-domain/material-context.mjs";
import { apply } from "../packages/novel-harness/tools-plugin.mjs";
const input = (title) => ({
  kind: "character",
  title,
  status: "planned",
  notes: "作者计划尚未成为事实",
  fields: { voice: "说话很少使用形容词" },
  chapterIds: [],
});
test("context snapshots contain only explicit same-book records and change identity when records change; overflow is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-context-")),
    store = new NovelStore(root),
    book = await store.createBook("本书"),
    other = await store.createBook("他书");
  let a = await store.materials.save(book.id, input("林舟"));
  await store.materials.save(book.id, input("未选择的角色"));
  const foreign = await store.materials.save(other.id, input("隔离测试"));
  const pack = await store.materials.contextPack(book.id, [a.id]);
  assert.equal(pack.materials.length, 1);
  assert.match(materialContextText(pack), /作者计划/);
  assert.doesNotMatch(materialContextText(pack), /隔离测试|未选择的角色/);
  assert.equal(
    (await store.materials.contextPack(book.id, [a.id])).hash,
    pack.hash,
  );
  a = await store.materials.save(book.id, { ...a, notes: "新计划" }, a);
  assert.notEqual(
    (await store.materials.contextPack(book.id, [a.id])).hash,
    pack.hash,
  );
  assert.match(pack.materials[0].content, /尚未成为事实/);
  await assert.rejects(store.materials.contextPack(book.id, [foreign.id]));
  await assert.rejects(
    store.materials.contextPack(book.id, Array(9).fill(a.id)),
    /最多 8/,
  );
  a = await store.materials.save(
    book.id,
    { ...a, notes: "长".repeat(21000) },
    a,
  );
  await assert.rejects(
    store.materials.contextPack(book.id, [a.id]),
    /不会静默截断/,
  );
});
test("material read tool exposes only frozen host-generated context and rejects path or cross-book arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-context-tool-")),
    snapshotPath = join(root, "snapshot.json");
  const materialContext = {
    schemaVersion: 1,
    bookId: "synthetic",
    materials: [
      { id: "synthetic", title: "旧版人物", revision: 1, content: "冻结设定" },
    ],
  };
  await writeFile(snapshotPath, JSON.stringify({ materialContext }));
  const tools = new Map();
  let guard;
  apply(
    {
      tools: {
        register: (tool) => tools.set(tool.name, tool),
        guard: (fn) => {
          guard = fn;
        },
      },
    },
    {
      snapshotPath,
      proposalPath: join(root, "proposal.json"),
      materialContextEnabled: true,
    },
  );
  const exec = { signal: new AbortController().signal },
    tool = tools.get("novel_materials_read");
  assert.equal(guard({ name: "novel_materials_read" }), undefined);
  assert.equal(typeof guard({ name: "filesystem.read" }), "string");
  await assert.rejects(tool.execute({ bookId: "other" }, exec), /不接受/);
  await assert.rejects(tool.execute({ path: "private" }, exec), /不接受/);
  assert.deepEqual(
    JSON.parse((await tool.execute({}, exec)).context),
    materialContext,
  );
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, "utf8")), {
    materialContext,
  });
});
