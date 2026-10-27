import test from "node:test";
import assert from "node:assert/strict";
import { previewModelImport } from "../packages/novel-domain/model-import.mjs";
const bytes = (s) => Buffer.from(typeof s === "string" ? s : JSON.stringify(s));

test("WorkBuddy previews isolate credentials and do not infer a custom transport", () => {
  const result = previewModelImport(
    "workbuddy",
    bytes([
      {
        id: "fixture",
        name: "合成配置",
        vendor: "openai",
        url: "https://example.com/v1",
        apiKey: "synthetic-key",
        supportsToolCall: true,
      },
      {
        id: "custom",
        vendor: "openai",
        useCustomProtocol: true,
        url: "http://remote.invalid/v1",
      },
    ]),
  );
  const [a, b] = result.preview.candidates;
  assert.equal(a.protocol, "openai-chat");
  assert.equal(a.supportsToolCall, true);
  assert.equal(result.credentialFor(a.id).value, "synthetic-key");
  assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
  assert.equal(b.protocol, null);
  assert.equal(b.baseURL, null);
  result.dispose();
  assert.throws(() => result.credentialFor(a.id), {
    code: "MODEL_IMPORT_CANDIDATE",
  });
});

test("Codex uses a real TOML parser, selected provider and explicit wire protocol without reading environment or OAuth", () => {
  const result = previewModelImport(
    "codex",
    bytes(`model = "fixture-model"
model_provider = "local"
[model_providers.local]
name = "合成服务"
base_url = "http://127.0.0.1:1234/v1"
wire_api = "responses"
env_key = "SYNTHETIC_API_KEY"
requires_openai_auth = true
`),
  );
  const [view] = result.preview.candidates;
  assert.equal(view.protocol, "openai-responses");
  assert.deepEqual(result.credentialFor(view.id), {
    kind: "environment",
    variable: "SYNTHETIC_API_KEY",
  });
  const oauth = previewModelImport("codex", bytes('model="fixture"')).preview
    .candidates[0];
  assert.equal(oauth.credential.kind, "login-session");
  assert.equal(oauth.baseURL, null);
  assert.equal(oauth.protocol, null);
});

test("DSH static patches recognize known adapters only and cannot evaluate YAML code or aliases", () => {
  const result = previewModelImport(
    "dsh",
    bytes(`- insert:
    - id: llm-deepseek
      config:
        baseURL: https://example.com/anthropic
        apiKeyEnv: SYNTHETIC_DSH_KEY
        models:
          - id: fixture
            name: 合成模型
    - name: './untrusted-plugin.mjs'
      config:
        models:
          - id: never-import
`),
  );
  assert.equal(result.preview.candidates.length, 1);
  assert.equal(result.preview.candidates[0].protocol, "anthropic-text");
  for (const input of [
    "- id: llm-deepseek\n  config: !!js process.env.SYNTHETIC_DSH_KEY",
    "- &x {id: llm-deepseek}\n- *x",
    "- {id: a, id: b}",
  ])
    assert.throws(() => previewModelImport("dsh", bytes(input)), {
      code: "MODEL_IMPORT_SYNTAX",
    });
});

test("invalid files and parser errors do not echo inline secrets; input fingerprints cover credential changes", () => {
  assert.throws(
    () => previewModelImport("codex", bytes('key = "synthetic-hidden-secret')),
    (error) =>
      error.code === "MODEL_IMPORT_SYNTAX" &&
      !String(error).includes("synthetic-hidden-secret") &&
      !error.cause,
  );
  assert.throws(() => previewModelImport("workbuddy", Buffer.from([0xff])), {
    code: "MODEL_IMPORT_SYNTAX",
  });
  assert.throws(
    () => previewModelImport("dsh", Buffer.alloc(1024 * 1024 + 1)),
    { code: "MODEL_IMPORT_SIZE" },
  );
  const input = [
    { id: "fixture", url: "https://example.com/v1", apiKey: "synthetic-one" },
  ];
  const before = previewModelImport("workbuddy", bytes(input));
  input[0].apiKey = "synthetic-two";
  const after = previewModelImport("workbuddy", bytes(input));
  assert.notEqual(before.preview.sourceSha256, after.preview.sourceSha256);
  assert.equal(before.preview.candidates[0].id, after.preview.candidates[0].id);
});

test("DSH foreign modules sharing an official-looking id and disabled inserts never become recognized profiles", () => {
  const result = previewModelImport(
    "dsh",
    bytes(`- id: llm-deepseek
  name: ./foreign-module.mjs
  config:
    baseURL: https://example.com
    models: [{id: foreign}]
- disabled: true
  insert:
    - id: llm-deepseek
      config:
        baseURL: https://example.com
        models: [{id: disabled}]
`),
  );
  assert.deepEqual(result.preview.candidates, []);
});
