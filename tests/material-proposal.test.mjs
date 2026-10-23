import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { TaskAcceptance } from "../packages/novel-harness/acceptance.mjs";
import { MaterialTaskAcceptance } from "../packages/novel-harness/material-acceptance.mjs";
import { materialProposal } from "../packages/novel-domain/material-proposal.mjs";
import { validateMaterialInput } from "../packages/novel-domain/materials.mjs";
import { apply } from "../packages/novel-harness/tools-plugin.mjs";

const proposal = {
  title: "林舟",
  fields: { desire: "找出旧信的主人", voice: "先问事实，再下判断" },
  notes: "候选设定，不自动成为正文事实",
};
test("research verification belongs to the author; AI proposal cannot promote provenance or rewrite verification history", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-research-")),
    store = new NovelStore(join(root, "library"));
  const book = await store.createBook("现实资料合成验证");
  const card = await store.materials.save(book.id, {
    kind: "research",
    title: "合成港口年表",
    status: "planned",
    chapterIds: [],
    notes: "测试材料，非现实史实",
    fields: {
      boundary: "待核实",
      claim: "测试年表称此时建港",
      citation: "合成测试年表，第 2 页",
      checkedAt: "尚未核对",
      scope: "虚构旧港",
      uncertainty: "没有现实证据",
      adaptation: "仅供虚构场景",
    },
  });
  const candidate = {
    title: card.title,
    fields: { ...card.fields, claim: "待核实的建港时间" },
    notes: card.notes,
  };
  assert.equal(materialProposal(candidate, card).fields.boundary, "待核实");
  assert.throws(
    () =>
      materialProposal(
        {
          ...candidate,
          fields: { ...candidate.fields, boundary: "事实（作者已核对）" },
        },
        card,
      ),
    /作者性质标记/,
  );
  assert.throws(
    () =>
      materialProposal(
        {
          ...candidate,
          fields: { ...candidate.fields, checkedAt: "模型声称今天已核实" },
        },
        card,
      ),
    /核对记录/,
  );
  const marked = await store.materials.save(
    book.id,
    {
      ...card,
      fields: {
        ...card.fields,
        boundary: "明确虚构",
        checkedAt: "作者检查合成测试夹具",
      },
    },
    card,
  );
  assert.equal(marked.fields.boundary, "明确虚构");
  assert.equal(
    (await store.materials.history(book.id, card.id))[0].fields.boundary,
    "待核实",
  );
  const context = await store.materials.contextPack(book.id, [marked.id]);
  assert.match(context.materials[0].content, /未自动访问或核实/);
  assert.match(context.materials[0].content, /明确虚构/);
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "novel-material-proposal-"));
  const store = new NovelStore(join(root, "library")),
    journal = new TaskJournal(join(root, "tasks"));
  const book = await store.importBook("资料提案合成验证", [
    { title: "旧港", body: "船靠岸了。" },
  ]);
  const card = await store.materials.save(book.id, {
    kind: "character",
    title: "林舟初稿",
    fields: { desire: "离开旧港" },
    status: "planned",
    notes: "初步想法",
    chapterIds: [book.chapters[0].id],
  });
  const id = randomUUID(),
    target = {
      bookId: book.id,
      id: card.id,
      revision: card.revision,
      diskHash: card.diskHash,
      input: validateMaterialInput(card),
    };
  await journal.create(
    {
      id,
      kind: "material",
      bookId: book.id,
      materialId: card.id,
      status: "preparing",
      startedAt: new Date().toISOString(),
    },
    { materialTarget: target },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: JSON.stringify(proposal),
  });
  return { root, store, journal, book, card, id, target };
}
test("typed proposals cannot change host-owned identity, chapter links, evidence or author authority", async () => {
  const { store, journal, book, card, id, target } = await setup();
  for (const extra of [
    { kind: "rule" },
    { status: "accepted" },
    { chapterIds: [] },
    { evidence: [] },
    { id: randomUUID() },
  ])
    assert.throws(
      () => materialProposal({ ...proposal, ...extra }, target.input),
      /只能包含/,
    );
  assert.throws(() =>
    materialProposal(
      { ...proposal, fields: { unknown: "value" } },
      target.input,
    ),
  );
  assert.equal((await store.materials.read(book.id, card.id)).revision, 1);
  const acceptance = new MaterialTaskAcceptance(journal, store.materials);
  const result = await acceptance.accept(id, {
    ...proposal,
    notes: "作者调整后的版本",
  });
  assert.equal(result.material.revision, 2);
  assert.equal(result.material.notes, "作者调整后的版本");
  assert.deepEqual(result.material.chapterIds, card.chapterIds);
  assert.equal(result.material.status, "planned");
  assert.equal((await journal.read(id)).record.status, "applied");
  assert.equal(
    (await store.readChapter(book.id, book.chapters[0].id)).body,
    "船靠岸了。",
  );
  await assert.rejects(acceptance.accept(id, proposal), /状态已改变/);
});
test("material proposals reject competing edits without changing task or current card", async () => {
  const { store, journal, book, card, id } = await setup();
  const updated = await store.materials.save(
    book.id,
    { ...card, notes: "作者先修改" },
    card,
  );
  await assert.rejects(
    new MaterialTaskAcceptance(journal, store.materials).accept(id, proposal),
    /生成后已改变/,
  );
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    updated.diskHash,
  );
  assert.equal((await journal.read(id)).record.status, "awaiting-review");
});
test("intent-only recovery retains original card; manuscript coordinator cannot misclassify material acceptance", async () => {
  const { store, journal, book, card, id } = await setup();
  const stopped = new MaterialTaskAcceptance(
    journal,
    store.materials,
    async () => {
      throw new Error("checkpoint interruption");
    },
  );
  await assert.rejects(stopped.accept(id, proposal), /checkpoint/);
  await new TaskAcceptance(journal, store).recoverAll();
  assert.equal((await journal.read(id)).record.status, "accepting");
  await new MaterialTaskAcceptance(journal, store.materials).recoverAll();
  assert.equal((await journal.read(id)).record.status, "awaiting-review");
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    card.diskHash,
  );
});
test("book receipt completes a material task after interruption without overwriting subsequent author edits", async () => {
  const { root, store, journal, book, card, id } = await setup();
  const stopped = new MaterialTaskAcceptance(
    journal,
    store.materials,
    async (stage) => {
      if (stage === "material-saved")
        throw new Error("checkpoint interruption");
    },
  );
  await assert.rejects(stopped.accept(id, proposal), /checkpoint/);
  const applied = await store.materials.read(book.id, card.id);
  assert.equal(applied.title, proposal.title);
  const updated = await store.materials.save(
    book.id,
    { ...applied, notes: "接受之后作者再次修改" },
    applied,
  );
  const file = join(root, "library", book.id, "materials", `${card.id}.json`),
    before = await readFile(file, "utf8");
  await new MaterialTaskAcceptance(journal, store.materials).recoverAll();
  const result = await journal.read(id);
  assert.equal(result.record.status, "applied");
  assert.equal(result.record.appliedHash, applied.diskHash);
  assert.equal(result.record.acceptanceRecovery, "receipt-confirmed");
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    updated.diskHash,
  );
});
test("material tool boundary rejects foreign scope and immutable fields, persists only a proposal, and honors cancellation", async () => {
  const { root, store, book, card, target } = await setup();
  const snapshotPath = join(root, "tool-snapshot.json"),
    proposalPath = join(root, "tool-proposal.json");
  await writeFile(
    snapshotPath,
    JSON.stringify({
      context: "冻结资料",
      selectedText: "",
      materialTarget: target,
    }),
  );
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
    { snapshotPath, proposalPath, materialTargetEnabled: true },
  );
  assert.deepEqual([...tools.keys()].sort(), [
    "novel_material_propose",
    "novel_material_read",
  ]);
  assert.equal(typeof guard({ name: "novel_change_propose" }), "string");
  assert.equal(typeof guard({ name: "filesystem.write" }), "string");
  const exec = { signal: new AbortController().signal };
  await assert.rejects(
    tools.get("novel_material_read").execute({ bookId: randomUUID() }, exec),
  );
  await assert.rejects(
    tools
      .get("novel_material_propose")
      .execute({ ...proposal, evidence: [] }, exec),
  );
  await tools.get("novel_material_propose").execute(proposal, exec);
  assert.deepEqual(
    JSON.parse(JSON.parse(await readFile(proposalPath, "utf8")).replacement),
    proposal,
  );
  assert.equal(
    (await store.materials.read(book.id, card.id)).diskHash,
    card.diskHash,
  );
  await assert.rejects(
    tools
      .get("novel_material_propose")
      .execute(proposal, { signal: AbortSignal.abort() }),
    /取消/,
  );
});
test("partially replayed material transaction restores its receipt before task reconciliation", async () => {
  const { root, store, journal, book, card, id } = await setup();
  await assert.rejects(
    new MaterialTaskAcceptance(journal, store.materials, async (stage) => {
      if (stage === "material-saved") throw new Error("interrupt");
    }).accept(id, proposal),
  );
  const { record } = await journal.read(id);
  const bookRoot = join(root, "library", book.id),
    directory = join(bookRoot, ".zinovel", "transactions");
  let pending;
  for (const filename of await readdir(directory)) {
    const raw = await readFile(join(directory, filename), "utf8");
    if (
      JSON.parse(raw).entries.some((entry) =>
        entry.path.includes(record.acceptance.id),
      )
    )
      pending = raw;
  }
  assert.ok(pending);
  const entry = JSON.parse(pending).entries.find(
    (entry) => entry.path === `materials/${card.id}.json`,
  );
  await writeFile(join(bookRoot, entry.path), entry.before);
  await writeFile(join(bookRoot, ".zinovel", "pending.json"), pending);
  await new MaterialTaskAcceptance(journal, store.materials).recoverAll();
  assert.equal((await journal.read(id)).record.status, "applied");
  assert.equal(
    (await store.materials.read(book.id, card.id)).title,
    proposal.title,
  );
  assert.equal(
    await readFile(join(bookRoot, ".zinovel", "pending.json"), "utf8"),
    "",
  );
});
