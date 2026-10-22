import test from "node:test";
import assert from "node:assert/strict";
import {
  isolatedEnvironment,
  validateSettings,
} from "../packages/novel-harness/runtime.mjs";
import { apply } from "../packages/novel-harness/tools-plugin.mjs";
test("child environment does not inherit unrelated secrets or plugin overrides", () => {
  assert.deepEqual(
    isolatedEnvironment({
      PATH: "bin",
      SystemRoot: "Windows",
      DSH_HOME: "other",
      DEEPSEEK_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      NODE_OPTIONS: "--import evil",
      DSH_SYSTEM_PROMPT: "evil",
    }),
    { PATH: "bin", SystemRoot: "Windows" },
  );
});
test("provider endpoints reject credential-bearing URLs and non-local plaintext transport", () => {
  for (const baseURL of [
    "http://example.com",
    "https://key@example.com",
    "https://example.com?key=abc",
    "file:///C:/data",
  ])
    assert.throws(() => validateSettings({ baseURL }));
  assert.equal(
    validateSettings({ baseURL: "http://127.0.0.1:1234" }).baseURL,
    "http://127.0.0.1:1234",
  );
  assert.equal(
    validateSettings({}).baseURL,
    "https://api.deepseek.com/anthropic",
  );
});
test("novel tools reject arbitrary path arguments and an unexpected tool is denied", async () => {
  const tools = new Map();
  let guard;
  apply(
    {
      tools: {
        register: (tool) => tools.set(tool.name, tool),
        guard: (callback) => {
          guard = callback;
        },
      },
    },
    { snapshotPath: "unused", proposalPath: "unused" },
  );
  assert.equal(guard({ name: "novel_selection_read" }), undefined);
  assert.equal(typeof guard({ name: "shell.execute" }), "string");
  const exec = { signal: new AbortController().signal };
  await assert.rejects(
    tools.get("novel_selection_read").execute({ path: "C:/private" }, exec),
    /不接受路径/,
  );
  await assert.rejects(
    tools
      .get("novel_change_propose")
      .execute({ replacement: "text", path: "C:/private" }, exec),
    /格式无效/,
  );
});
