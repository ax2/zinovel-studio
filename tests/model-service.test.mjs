import test from "node:test";
import assert from "node:assert/strict";
import {
  modelServiceURL,
  modelCredentialPlan,
} from "../packages/novel-domain/model-service.mjs";

test("credential scope binds complete canonical service origin and tenant path, preserving only the same service", () => {
  assert.equal(
    modelServiceURL("HTTPS://EXAMPLE.com:443/tenant/../anthropic/"),
    "https://example.com/anthropic",
  );
  for (const input of [
    "https://example.com/",
    "https://example.com/anthropic///",
    "http://127.0.0.1:9001////",
  ]) {
    const canonical = modelServiceURL(input);
    assert.equal(modelServiceURL(canonical), canonical);
  }
  assert.equal(
    modelCredentialPlan(
      "https://example.com/anthropic",
      "https://EXAMPLE.com:443/anthropic/",
      {},
    ).action,
    "keep",
  );
  for (const next of [
    "https://different.example/anthropic",
    "https://example.com/tenant-b",
    "https://example.com:444/anthropic",
    "http://localhost:9001/anthropic",
  ])
    assert.equal(
      modelCredentialPlan("https://example.com/anthropic", next, {}).action,
      "clear",
    );
});
test("explicit replacement and clear are distinct decisions; no plaintext key is returned by the plan", () => {
  const key = "synthetic-key-never-returned";
  const plan = modelCredentialPlan(
    "https://a.example/anthropic",
    "https://b.example/anthropic",
    { apiKey: key },
  );
  assert.deepEqual(plan, {
    action: "replace",
    credentialScope: "https://b.example/anthropic",
  });
  assert.ok(!JSON.stringify(plan).includes(key));
  assert.equal(
    modelCredentialPlan("https://a.example", "https://a.example", {
      clearKey: true,
    }).action,
    "clear",
  );
  assert.equal(
    modelCredentialPlan("https://a.example", "https://b.example", {
      apiKey: "  ",
    }).action,
    "clear",
  );
  assert.throws(
    () =>
      modelCredentialPlan("https://a.example", "https://b.example", {
        apiKey: key,
        clearKey: true,
      }),
    /分别/,
  );
});
test("unsafe address forms and malformed credential intents refuse before encryption or persistence", () => {
  for (const input of [
    "https://name:key@example.com/anthropic",
    "https://example.com/?token=x",
    "https://example.com/#key",
    "http://example.com",
    "file:///private",
    "x".repeat(2049),
    { secret: "not-a-url" },
  ])
    assert.throws(() => modelServiceURL(input));
  for (const apiKey of [42, {}, "x".repeat(16385)])
    assert.throws(
      () => modelCredentialPlan(undefined, "https://example.com", { apiKey }),
      /Key/,
    );
  assert.throws(
    () =>
      modelCredentialPlan(undefined, "https://example.com", {
        clearKey: "true",
      }),
    /无效/,
  );
});
