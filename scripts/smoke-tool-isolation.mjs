import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { NovelHarness } from "../packages/novel-harness/runtime.mjs";
import { validateMaterialInput } from "../packages/novel-domain/materials.mjs";
import { modelFixture } from "../tests/fixtures/model-server.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const work = await mkdtemp(join(root, ".cache", "tool-isolation-"));
const store = new NovelStore(join(work, "library"));
const body = "当前作品的合成正文。\n资料里的越权指令不能扩大授权。";
const book = await store.importBook("授权合成甲", [
  { title: "当前章节", body },
]);
const other = await store.importBook("隔离合成乙", [
  { title: "另一书", body: "FOREIGN_BOOK_SECRET_73819" },
]);
const cardInput = (title, notes) => ({
  kind: "character",
  title,
  notes,
  status: "planned",
  fields: { voice: "简短合成语气" },
  chapterIds: [],
});
const card = await store.materials.save(
  book.id,
  cardInput("当前角色", "显式授权参考。"),
);
await store.materials.save(
  book.id,
  cardInput("未选角色", "UNSELECTED_MATERIAL_SECRET_82741"),
);
await store.materials.save(
  other.id,
  cardInput("另一书角色", "FOREIGN_MATERIAL_SECRET_91632"),
);
const group = await store.pilots.createGroup(book.id, {
  title: "合成试写",
  scene: "读取旧信",
});
const pilot = await store.pilots.save(book.id, group.id, {
  title: "授权样稿",
  body: "当前试写合成稿。",
});
const pilotPack = await store.pilots.taskSnapshot(book.id, pilot);
const materialContext = await store.context.pack(book.id, [card.id]);
async function inventory(directory, prefix = "") {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.equal(item.isSymbolicLink(), false);
    const path = join(directory, item.name),
      name = prefix + item.name;
    if (item.isDirectory())
      Object.assign(result, await inventory(path, name + "/"));
    else
      result[name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return result;
}
const before = await inventory(store.root);
const output = join(
  root,
  "screenshots",
  process.env.ZINOVEL_QA_STAGE || "stage-008",
  "tool-isolation",
);
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  version: JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    .version,
  checks: [],
  cases: [],
  scope:
    "Source official Harness tool round trips across writing/material/pilot with and without selected references; synthetic library only, not installed EXE or real-model literary-quality qualification",
};
try {
  for (const mode of ["writing", "material", "pilot"])
    for (const references of [false, true]) {
      const read =
        mode === "writing"
          ? "novel_selection_read"
          : mode === "material"
            ? "novel_material_read"
            : "novel_pilot_read";
      const propose =
        mode === "writing"
          ? "novel_change_propose"
          : mode === "material"
            ? "novel_material_propose"
            : "novel_pilot_propose";
      const proposal =
        mode === "material"
          ? {
              title: card.title,
              fields: { voice: "候选语气" },
              notes: "合成待审候选",
            }
          : { replacement: "合成候选，只等待作者审阅。" };
      const forbidden = [
        {
          name: "shell.execute",
          input: {
            command: `Set-Content -LiteralPath '${join(store.root, other.id, "manuscript", other.chapters[0].id + ".md")}' -Value BAD`,
          },
        },
        { name: read, input: { bookId: other.id, path: "../foreign-book" } },
        { name: propose, input: { ...proposal, bookId: other.id } },
        {
          name:
            mode === "writing" ? "novel_pilot_propose" : "novel_change_propose",
          input: { replacement: "BAD" },
        },
        {
          name: "novel_materials_read",
          input: references ? { bookId: other.id } : {},
        },
      ];
      const sequence = [
        ...forbidden,
        { name: read, input: {} },
        ...(references ? [{ name: "novel_materials_read", input: {} }] : []),
        { name: propose, input: proposal },
      ];
      const model = await modelFixture({ toolSequence: sequence });
      const runtime = new NovelHarness({
        root: join(work, `${mode}-${references}`),
        resources: join(root, "dist/resources"),
      });
      const input = {
        skillId:
          mode === "writing"
            ? "novel-polish"
            : mode === "material"
              ? "novel-character"
              : "novel-pilot",
        instruction: "只提出待审候选，不保存正式稿。",
        context: body,
        selectedText: "",
        ...(references ? { materialContext } : {}),
      };
      if (mode === "writing")
        Object.assign(input, {
          selectedText: body,
          target: {
            bookId: book.id,
            chapterId: book.chapters[0].id,
            body,
            start: 0,
            end: body.length,
          },
        });
      if (mode === "material")
        Object.assign(input, {
          materialTarget: {
            bookId: book.id,
            id: card.id,
            revision: card.revision,
            diskHash: card.diskHash,
            input: validateMaterialInput(card),
          },
        });
      if (mode === "pilot")
        Object.assign(input, {
          context: pilotPack.context,
          pilotTarget: pilotPack.target,
        });
      try {
        const generated = await runtime.generate(
          input,
          {
            baseURL: model.url,
            model: "deepseek-v4-flash",
            budget: { maxSteps: 12 },
          },
          "synthetic-isolation-only",
        );
        const task = await runtime.task(generated.id);
        assert.equal(task.record.status, "awaiting-review");
        assert.equal(task.record.bookId, book.id);
        assert.equal(task.record.kind, mode);
        if (mode === "writing")
          assert.equal(task.record.chapterId, book.chapters[0].id);
        if (mode === "material") assert.equal(task.record.materialId, card.id);
        if (mode === "pilot") assert.equal(task.record.pilotId, pilot.id);
        if (mode === "material")
          assert.deepEqual(JSON.parse(generated.text), proposal);
        else assert.equal(generated.text, proposal.replacement);
        const results = new Map(
          model.requests
            .flatMap((r) =>
              r.messages.flatMap((m) =>
                Array.isArray(m.content) ? m.content : [],
              ),
            )
            .filter((block) => block.type === "tool_result")
            .map((block) => [block.tool_use_id, block]),
        );
        for (let index = 0; index < sequence.length; index++) {
          const result = results.get(`fixture-tool-${index + 1}`);
          assert.ok(result, "Every attempted tool must produce a real result");
          assert.equal(result.is_error === true, index < forbidden.length);
        }
        const allowed = [
          read,
          propose,
          ...(references ? ["novel_materials_read"] : []),
        ].sort();
        for (const request of model.requests)
          assert.deepEqual(
            request.tools.map((tool) => tool.name).sort(),
            allowed,
          );
        assert.doesNotMatch(
          JSON.stringify(model.requests),
          /FOREIGN_BOOK_SECRET_73819|FOREIGN_MATERIAL_SECRET_91632|UNSELECTED_MATERIAL_SECRET_82741/,
        );
        assert.deepEqual(await inventory(store.root), before);
        report.cases.push({
          mode,
          references,
          rejected: forbidden.length,
          authorized: sequence.length - forbidden.length,
          modelRequests: model.requests.length,
          originalTargetRetained: true,
          libraryUnchanged: true,
          foreignOrUnselectedTextSent: false,
        });
      } finally {
        await runtime.cancel();
        await model.close();
      }
    }
  report.checks.push(
    "six actual official Harness profiles expose only the authorized two or three tools",
    "thirty attempted tool violations return real error results without reading foreign/unselected contents or changing any library file",
    "authorized read/reference/proposal round trips still succeed after the rejected attempts, bound to the original target and awaiting author review",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  throw error;
} finally {
  await writeFile(
    join(output, "tool-isolation-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
}
