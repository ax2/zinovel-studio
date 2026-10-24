import test from "node:test";
import assert from "node:assert/strict";
import { Diagnostics } from "../packages/novel-storage/diagnostics.mjs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fixture = () =>
  new Diagnostics({
    appVersion: "0.1.0-alpha.28",
    electronVersion: "44.7.0",
    nodeVersion: "24.21.0",
    platform: "win32",
    arch: "x64",
  });

test("explicit diagnostic export creates only a new whitelist JSON and refuses to overwrite existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-diagnostics-")),
    data = join(root, "data"),
    target = join(root, "report.json");
  await mkdir(data);
  const d = fixture();
  d.record("chapter.save");
  const saved = await d.exportNewFile(data, target),
    bytes = await readFile(target);
  assert.equal(saved.bytes, bytes.length);
  assert.equal(saved.events, 1);
  assert.deepEqual(JSON.parse(bytes), d.snapshot());
  await assert.rejects(d.exportNewFile(data, target), { code: "EEXIST" });
  assert.deepEqual(await readFile(target), bytes);
  assert.deepEqual(await readdir(data), []);
});
test("diagnostic export rejects entire data root, aliases and prospective alias children before file creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-diagnostics-boundary-")),
    data = join(root, "data"),
    alias = join(root, "alias");
  await mkdir(join(data, "library"), { recursive: true });
  const original = join(data, "library", "original.md");
  await writeFile(original, "合成正文不改");
  await symlink(data, alias, process.platform === "win32" ? "junction" : "dir");
  const d = fixture();
  for (const target of [
    join(data, "new.json"),
    join(alias, "new.json"),
    join(alias, "not-created", "new.json"),
    original,
  ])
    await assert.rejects(d.exportNewFile(data, target), /数据目录/);
  await assert.rejects(d.exportNewFile(data, "relative.json"), /选择/);
  assert.equal(await readFile(original, "utf8"), "合成正文不改");
  assert.deepEqual((await readdir(data)).sort(), ["library"]);
});

test("diagnostic metadata whitelist never retains payload, raw error, identity, paths or credentials", () => {
  const d = fixture(),
    secret = "合成正文-secret-token-C:\\private\\book";
  d.record("chapter.save", {
    success: false,
    durationMs: 121,
    error: Object.assign(new Error(secret), { code: "ENOSPC", bookId: secret }),
    body: secret,
    prompt: secret,
    apiKey: secret,
  });
  d.record(secret, { success: false, error: new Error(secret) });
  d.record("chapter.read", { success: true, error: new Error(secret) });
  const report = d.snapshot();
  assert.equal(report.events.length, 2);
  assert.deepEqual(Object.keys(report.events[0]).sort(), [
    "at",
    "code",
    "durationBucketMs",
    "operation",
    "outcome",
    "sequence",
  ]);
  assert.equal(report.events[0].code, "storage-full");
  assert.equal(report.events[0].durationBucketMs, 200);
  assert.equal(report.events[1].operation, "other");
  assert.ok(!JSON.stringify(report).includes(secret));
});
test("bounded session records retain latest 200 and explicit clear drops activity without touching caller data", () => {
  const d = fixture();
  for (let i = 0; i < 250; i++) d.record("chapter.save", { durationMs: i });
  const report = d.snapshot();
  assert.equal(report.events.length, 200);
  assert.equal(report.discarded, 50);
  assert.equal(report.events[0].sequence, 51);
  report.runtime.app = "caller-change";
  report.events[0].code = "caller-change";
  assert.notEqual(d.snapshot().events[0].code, "caller-change");
  assert.notEqual(d.snapshot().runtime.app, "caller-change");
  d.clear();
  assert.equal(d.snapshot().events.length, 0);
  assert.equal(d.snapshot().discarded, 0);
  assert.equal(fixture().snapshot().events.length, 0);
});
test("hostile error getters and runtime metadata cannot inject secrets into diagnostics or interrupt writing", () => {
  const d = new Diagnostics({
    appVersion: "secret/正文",
    electronVersion: {
      toString() {
        throw Error("never called");
      },
    },
    nodeVersion: "24.21.0",
    platform: "sensitive-host",
    arch: "sensitive-arch",
  });
  const error = {
    get code() {
      throw Error("never called");
    },
    get message() {
      throw Error("never called");
    },
    toJSON() {
      throw Error("never called");
    },
  };
  d.record("chapter.save", { success: false, error, durationMs: Infinity });
  const report = d.snapshot();
  assert.equal(report.runtime.app, "unknown");
  assert.equal(report.runtime.electron, "unknown");
  assert.equal(report.runtime.platform, "unknown");
  assert.equal(report.events[0].code, "unexpected");
  assert.equal(report.events[0].durationBucketMs, 0);
  assert.match(report.events[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
  assert.equal(JSON.stringify(report).includes("never called"), false);
});
