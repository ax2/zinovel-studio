import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NovelStore } from "../packages/novel-storage/store.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { PilotTaskAcceptance } from "../packages/novel-harness/pilot-acceptance.mjs";
import { TaskAcceptance } from "../packages/novel-harness/acceptance.mjs";
import { MaterialTaskAcceptance } from "../packages/novel-harness/material-acceptance.mjs";
import { bindPilotInput } from "../packages/novel-harness/pilot-target.mjs";
import { reviewContent } from "../packages/novel-domain/review-content.mjs";
import { apply } from "../packages/novel-harness/tools-plugin.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zinovel-pilot-ai-")),
    store = new NovelStore(join(root, "library")),
    journal = new TaskJournal(join(root, "tasks")),
    book = await store.importBook("试写任务合成验证", [
      { title: "正式首章", body: "正式首章不改。\r\n🌧️" },
    ]),
    material = await store.materials.save(book.id, {
      kind: "idea",
      title: "追信",
      status: "planned",
      notes: "原始想法",
      fields: {},
      chapterIds: [],
    }),
    group = await store.pilots.createGroup(book.id, {
      title: "取信实验",
      scene: "信使即将离港",
      sourceIds: [material.id],
    }),
    pilot = await store.pilots.save(book.id, group.id, {
      title: "第一人称",
      body: "我走向渡船。",
      voice: "克制",
    }),
    pack = await store.pilots.taskSnapshot(book.id, pilot),
    id = randomUUID();
  await journal.create(
    {
      id,
      kind: "pilot",
      bookId: book.id,
      pilotId: pilot.id,
      pilotTitle: pilot.title,
      status: "preparing",
      startedAt: new Date().toISOString(),
    },
    { context: pack.context, selectedText: "", pilotTarget: pack.target },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: "我沿河追赶渡船。",
  });
  return { root, store, journal, book, material, group, pilot, pack, id };
}
test("pilot snapshot and proposal tools freeze only selected experiment; changed source and huge text cannot silently replace preview", async () => {
  const { root, store, book, pilot, material, pack } = await fixture();
  const payload = {
    bookId: book.id,
    expected: pilot,
    snapshotHash: pack.hash,
    instruction: "试写",
  };
  const input = await bindPilotInput(store.pilots, payload);
  assert.equal(input.target, undefined);
  assert.equal(input.pilotTarget.id, pilot.id);
  assert.equal(input.context.includes("正式首章不改"), false);
  await store.materials.save(
    book.id,
    { ...material, notes: "修改后的想法" },
    material,
  );
  await assert.rejects(bindPilotInput(store.pilots, payload), /刷新/);
  assert.equal(pack.context.includes("修改后的想法"), false);
  const newer = await store.pilots.taskSnapshot(book.id, pilot);
  assert.match(newer.context, /stale/);
  const snapshotPath = join(root, "snapshot.json"),
    proposalPath = join(root, "proposal.json"),
    tools = new Map();
  await writeFile(snapshotPath, JSON.stringify({ ...input }));
  let guard;
  apply(
    {
      tools: {
        register: (tool) => tools.set(tool.name, tool),
        guard: (value) => {
          guard = value;
        },
      },
    },
    { snapshotPath, proposalPath, pilotTargetEnabled: true },
  );
  assert.deepEqual(
    [...tools.keys()],
    ["novel_pilot_read", "novel_pilot_propose"],
  );
  for (const name of [
    "novel_change_propose",
    "novel_material_propose",
    "filesystem.write",
    "novel_materials_read",
  ])
    assert.equal(typeof guard({ name }), "string");
  const exec = { signal: new AbortController().signal };
  await assert.rejects(
    tools.get("novel_pilot_read").execute({ path: "book.json" }, exec),
  );
  assert.equal(
    (await tools.get("novel_pilot_read").execute({}, exec)).context,
    pack.context,
  );
  for (const args of [
    { replacement: "合成", pilotId: randomUUID() },
    { replacement: "\ud800" },
    { replacement: "x".repeat(120001) },
  ])
    await assert.rejects(tools.get("novel_pilot_propose").execute(args, exec));
  await tools
    .get("novel_pilot_propose")
    .execute({ replacement: "新的试写 🌊" }, exec);
  assert.equal(
    JSON.parse(await readFile(proposalPath, "utf8")).replacement,
    "新的试写 🌊",
  );
  await assert.rejects(
    tools
      .get("novel_pilot_propose")
      .execute({ replacement: "不可写" }, { signal: AbortSignal.abort() }),
    /取消/,
  );
  assert.equal((await store.pilots.read(book.id, pilot.id)).body, pilot.body);
  const large = await store.pilots.save(
    book.id,
    pilot.groupId,
    { ...pilot, body: "长".repeat(120001) },
    pilot,
  );
  await assert.rejects(
    store.pilots.taskSnapshot(book.id, large),
    /未截断或发送/,
  );
});
test("explicit acceptance writes only body, keeps author metadata and chapter bytes; tasks retain pilot identity and review drafts", async () => {
  const { store, journal, book, pilot, id, group } = await fixture();
  const original = await store.readChapter(book.id, book.chapters[0].id);
  await journal.saveReviewDraft(id, "作者审阅后的试写。", 0);
  assert.equal(
    (await journal.list(book.id, 40, { pilotId: pilot.id }))[0].id,
    id,
  );
  assert.deepEqual(await journal.list(undefined, 40, { unbound: true }), []);
  await assert.rejects(
    journal.transition(id, "discarded", { pilotId: randomUUID() }),
    /身份/,
  );
  await assert.rejects(
    new TaskAcceptance(journal, store).accept(id, "不能应用到正文"),
    /不是正文/,
  );
  // An author's choice changes the group record but not the fixed scene brief.
  await store.pilots.choose(book.id, group, pilot, "先选此稿");
  const result = await new PilotTaskAcceptance(journal, store.pilots).accept(
    id,
    "作者审阅后的试写。",
  );
  assert.equal(result.pilot.body, "作者审阅后的试写。");
  assert.equal(result.pilot.title, pilot.title);
  assert.equal(result.pilot.voice, pilot.voice);
  assert.equal(result.pilot.groupId, group.id);
  assert.deepEqual(
    await store.readChapter(book.id, book.chapters[0].id),
    original,
  );
  assert.equal((await journal.read(id)).record.status, "applied");
  await assert.rejects(
    new PilotTaskAcceptance(journal, store.pilots).accept(id, "重复"),
    /状态已改变/,
  );
});
test("actual process exit before/after pilot save reconciles receipt without replaying over later author edits", async () => {
  for (const stage of ["intent-written", "pilot-saved"]) {
    const { root, store, journal, book, pilot, id } = await fixture();
    let code;
    try {
      await promisify(execFile)(
        process.execPath,
        [resolve("tests/fixtures/pilot-acceptance-crash.mjs"), root, id, stage],
        { windowsHide: true, timeout: 20000 },
      );
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, 91);
    let current = await store.pilots.read(book.id, pilot.id);
    if (stage === "pilot-saved")
      current = await store.pilots.save(
        book.id,
        pilot.groupId,
        { ...current, body: "作者后续手改，不能被恢复覆盖。" },
        current,
      );
    await new TaskAcceptance(journal, store).recoverAll();
    await new MaterialTaskAcceptance(journal, store.materials).recoverAll();
    assert.equal((await journal.read(id)).record.status, "accepting");
    const fresh = new NovelStore(join(root, "library"));
    await new PilotTaskAcceptance(journal, fresh.pilots).recoverAll();
    assert.equal(
      (await journal.read(id)).record.status,
      stage === "intent-written" ? "awaiting-review" : "applied",
    );
    assert.deepEqual(await fresh.pilots.read(book.id, pilot.id), current);
    if (stage === "intent-written") {
      const draft = await journal.saveReviewDraft(
        id,
        "意图恢复之后的新审阅草稿",
        0,
      );
      assert.equal(
        draft.afterAcceptanceId,
        (await journal.read(id)).record.acceptance.id,
      );
      assert.equal(reviewContent(await journal.read(id)).text, draft.text);
    }
  }
});
test("stale pilot and changed external scene reject before intent; partial transaction rolls forward once with receipt", async () => {
  const first = await fixture();
  await writeFile(
    join(
      first.root,
      "library",
      first.book.id,
      "pilots",
      `${first.pilot.id}.md`,
    ),
    "外部先改",
  );
  await assert.rejects(
    new PilotTaskAcceptance(first.journal, first.store.pilots).accept(
      first.id,
      "模型稿",
    ),
    /外部编辑/,
  );
  assert.equal(
    (await first.journal.read(first.id)).record.status,
    "awaiting-review",
  );
  const second = await fixture();
  const path = join(
      second.root,
      "library",
      second.book.id,
      "pilots",
      "groups",
      `${second.group.id}.json`,
    ),
    data = JSON.parse(await readFile(path, "utf8"));
  data.scene = "外部换了场景";
  await writeFile(path, JSON.stringify(data));
  await assert.rejects(
    new PilotTaskAcceptance(second.journal, second.store.pilots).accept(
      second.id,
      "旧场景稿",
    ),
    /场景或来源/,
  );
  const { root, store, journal, book, pilot, id } = await fixture();
  await assert.rejects(
    new PilotTaskAcceptance(journal, store.pilots, async (stage) => {
      if (stage === "pilot-saved") throw new Error("interrupt");
    }).accept(id, "已接受的样稿"),
    /interrupt/,
  );
  const record = (await journal.read(id)).record,
    bookRoot = join(root, "library", book.id);
  let pending;
  for (const filename of await readdir(
    join(bookRoot, ".zinovel", "transactions"),
  )) {
    const raw = await readFile(
      join(bookRoot, ".zinovel", "transactions", filename),
      "utf8",
    );
    if (
      JSON.parse(raw).entries.some((entry) =>
        entry.path.includes(record.acceptance.id),
      )
    )
      pending = raw;
  }
  assert.ok(pending);
  const entry = JSON.parse(pending).entries.find(
    (item) => item.path === `pilots/${pilot.id}.md`,
  );
  await writeFile(join(bookRoot, entry.path), entry.before);
  await writeFile(join(bookRoot, ".zinovel", "pending.json"), pending);
  await new PilotTaskAcceptance(journal, store.pilots).recoverAll();
  assert.equal((await journal.read(id)).record.status, "applied");
  assert.equal(
    (await store.pilots.read(book.id, pilot.id)).body,
    "已接受的样稿",
  );
});
