import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText } from "../packages/novel-storage/atomic.mjs";

test("failed atomic replacement preserves destination and removes only its own temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(target, "retained.txt"), "原件保留");
  await assert.rejects(atomicWriteText(target, "新内容"));
  assert.equal(
    await readFile(join(target, "retained.txt"), "utf8"),
    "原件保留",
  );
  assert.deepEqual(await readdir(root), ["target"]);
  await atomicWriteText(join(root, "settings.json"), "旧配置");
  await atomicWriteText(join(root, "settings.json"), "新配置🌊");
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "新配置🌊");
});
