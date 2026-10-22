import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  StreamCapture,
  readStreamPartial,
} from "../packages/novel-harness/stream-capture.mjs";
import { TaskJournal } from "../packages/novel-harness/task-journal.mjs";

function frame(capture, value, session = "root") {
  capture.accept({ agent: { session: { id: session } }, frame: value });
}
test("stream recovery retains only visible text, rejects duplicate and foreign frames and never becomes an applicable proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-stream-"));
  const journal = new TaskJournal(root),
    id = randomUUID();
  await journal.create({ id, status: "preparing" }, { context: "原稿" });
  await journal.transition(id, "running");
  const capture = new StreamCapture(join(root, id, "stream.json"));
  frame(capture, { type: "start", attemptId: "a" });
  frame(capture, {
    type: "chunk",
    attemptId: "a",
    index: 0,
    chunk: { type: "reasoning-delta", text: "不可展示推理" },
  });
  frame(capture, {
    type: "chunk",
    attemptId: "a",
    index: 1,
    chunk: { type: "text-delta", text: "旧信𠀀\n" },
  });
  frame(capture, {
    type: "chunk",
    attemptId: "a",
    index: 1,
    chunk: { type: "text-delta", text: "重复" },
  });
  frame(capture, {
    type: "chunk",
    attemptId: "a",
    index: 2,
    chunk: { type: "tool-call-delta", argumentsDelta: "不应展示工具参数" },
  });
  frame(
    capture,
    {
      type: "chunk",
      attemptId: "a",
      index: 3,
      chunk: { type: "text-delta", text: "其他会话" },
    },
    "child",
  );
  await capture.close();
  await journal.recoverInterrupted();
  const recovered = await journal.read(id);
  assert.equal(recovered.record.candidate, "旧信𠀀\n");
  assert.equal(recovered.record.partialSource, "stream");
  assert.equal(recovered.record.status, "interrupted");
  await assert.rejects(journal.transition(id, "applied"));
  const serialized = await readFile(join(root, id, "stream.json"), "utf8");
  assert.ok(
    !serialized.includes("不可展示") && !serialized.includes("工具参数"),
  );
});

test("stream snapshots serialize writes, bound text without broken Unicode and surface persistence failure", async () => {
  const snapshots = [];
  const capture = new StreamCapture("unused", {
    write: async (_path, value) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshots.push(JSON.parse(value));
    },
  });
  frame(capture, { type: "start", attemptId: "a" });
  frame(capture, {
    type: "chunk",
    attemptId: "a",
    index: 0,
    chunk: { type: "text-delta", text: "甲".repeat(119999) + "𠀀" },
  });
  const first = capture.flush();
  frame(capture, { type: "end", attemptId: "a" });
  await capture.close();
  await first;
  const partial = readStreamPartial(snapshots.at(-1));
  assert.equal(partial.candidate.length, 119999);
  assert.equal(partial.streamTruncated, true);
  assert.equal(snapshots.at(-1).attempts[0].ended, true);
  assert.deepEqual(readStreamPartial({ schemaVersion: 2, attempts: [] }), {});
  const broken = new StreamCapture("unused", {
    write: async () => {
      throw new Error("disk unavailable");
    },
  });
  frame(broken, { type: "start", attemptId: "b" });
  frame(broken, {
    type: "chunk",
    attemptId: "b",
    index: 0,
    chunk: { type: "text-delta", text: "片段" },
  });
  await assert.rejects(broken.close(), /保存失败/);
});
