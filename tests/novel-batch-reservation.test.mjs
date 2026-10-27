import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NovelHarness } from "../packages/novel-harness/runtime.mjs";
import { NovelBatch } from "../packages/novel-harness/novel-batch.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";
import { inspiration, batchSettings } from "./fixtures/novel-batch.mjs";
test("a reserved Harness blocks unrelated generation between paid requests and another owner cannot release it", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-reservation-")),
    runtime = new NovelHarness({ root, resources: root }),
    owner = randomUUID();
  runtime.reserve(owner);
  assert.throws(() => runtime.reserve(randomUUID()), /已有写作任务/);
  assert.throws(() => runtime.release(randomUUID()), /不能释放/);
  await assert.rejects(
    runtime.generate(
      {
        skillId: "novel-pilot",
        instruction: "写作",
        context: "合成资料",
        selectedText: "",
      },
      batchSettings,
      "synthetic-key-never-sent",
    ),
    /批量创作占用/,
  );
  runtime.release(owner);
  runtime.reserve(owner);
  runtime.release(owner);
});
test("cancel at startup waits for the worker's durable paused state and never enters the paid callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-early-cancel-"));
  let requests = 0,
    locks = 0;
  const batch = new NovelBatch({
    root,
    acquire: () => {
      locks++;
    },
    release: () => {
      locks--;
    },
    generate: async () => {
      requests++;
      throw Error("must not run");
    },
    readTask: async () => {
      throw Error("no task");
    },
    cancel: async () => {},
    commit: async () => {
      throw Error("must not commit");
    },
  });
  const job = await batch.create(
    { ...inspiration, novelCount: 1 },
    batchSettings,
  );
  const running = batch.run(job.id),
    cancelled = Promise.resolve().then(() => batch.cancel(job.id));
  await running;
  const stopped = await cancelled;
  assert.equal(stopped.status, "paused");
  assert.equal(requests, 0);
  assert.equal(locks, 0);
  assert.equal(batch.status(), null);
});
test("a fixed request identity cannot overwrite its earlier completed candidate or open another provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-fixed-request-")),
    resources = join(root, "resources"),
    id = randomUUID();
  await mkdir(join(resources, "skills/novel-polish"), { recursive: true });
  await writeFile(
    join(resources, "skills/catalog.json"),
    JSON.stringify({
      skills: [{ id: "novel-polish", name: "合成测试方法", version: "0.1.0" }],
    }),
  );
  await writeFile(
    join(resources, "skills/novel-polish/SKILL.md"),
    "保留原意，候选需作者复核。",
  );
  const journal = new TaskJournal(join(root, "tasks"));
  await journal.create(
    {
      id,
      status: "preparing",
      kind: "writing",
      startedAt: new Date().toISOString(),
    },
    { context: "原有冻结输入", selectedText: "" },
  );
  await journal.transition(id, "running");
  await journal.transition(id, "awaiting-review", {
    candidate: "不可覆盖的原候选",
  });
  const before = await readFile(join(root, "tasks", id, "task.json"), "utf8"),
    runtime = new NovelHarness({ root, resources, journal });
  await assert.rejects(
    runtime.generate(
      {
        requestId: id,
        skillId: "novel-polish",
        instruction: "不应重新发送",
        context: "新输入",
        selectedText: "",
      },
      batchSettings,
      "synthetic-key-never-sent",
    ),
    { code: "EEXIST" },
  );
  assert.equal(
    await readFile(join(root, "tasks", id, "task.json"), "utf8"),
    before,
  );
  assert.equal((await journal.read(id)).snapshot.context, "原有冻结输入");
});
