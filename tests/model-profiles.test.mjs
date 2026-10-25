import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelProfiles } from "../packages/novel-storage/model-profiles.mjs";

const seal = (key) => "sealed:" + Buffer.from(key).toString("base64"),
  unseal = (value) => Buffer.from(value.slice(7), "base64").toString("utf8");
const codec = { available: () => true, encode: seal, decode: unseal };
const expected = (view) => ({
  revision: view.revision,
  diskHash: view.diskHash,
});
const text = (
  name = "文字B",
  url = "https://b.example/anthropic",
  key = "synthetic-key-B",
) => ({
  label: name,
  protocol: "anthropic-text",
  baseURL: url,
  model: "fixture-text",
  apiKey: key,
});
async function fixture(custom = codec) {
  const root = await mkdtemp(join(tmpdir(), "zinovel-model-profiles-")),
    store = new ModelProfiles(root, custom),
    legacy = {
      baseURL: "https://a.example/anthropic",
      model: "fixture-A",
      encryptedKey: seal("synthetic-key-A"),
    };
  return {
    root,
    store,
    legacy,
    view: await store.initializeFromLegacy(legacy),
  };
}

test("explicit migration preserves independent legacy ciphertext; active text routes freeze the exact profile and never expose keys", async () => {
  const f = await fixture();
  assert.equal(f.view.initialized, true);
  assert.equal(f.view.profiles.length, 1);
  const raw = JSON.parse(await readFile(f.store.path, "utf8"));
  assert.equal(raw.profiles[0].encryptedKey, f.legacy.encryptedKey);
  let view = await f.store.add(text(), expected(f.view));
  assert.equal(view.routes.text, f.view.routes.text);
  const first = await f.store.resolve("text", expected(view), { secret: true });
  assert.equal(first.apiKey, "synthetic-key-A");
  const secondId = view.profiles.find((p) => p.label === "文字B").id;
  view = await f.store.select("text", secondId, expected(view));
  assert.equal(
    (await f.store.resolve("text", expected(view), { secret: true })).apiKey,
    "synthetic-key-B",
  );
  view = await f.store.add(
    {
      ...text("未填写Key的独立配置", "https://c.example/anthropic"),
      apiKey: "",
    },
    expected(view),
  );
  const empty = view.profiles.find(
    (profile) => profile.label === "未填写Key的独立配置",
  );
  assert.equal(empty.hasKey, false);
  view = await f.store.select("text", empty.id, expected(view));
  await assert.rejects(
    f.store.resolve("text", expected(view), { secret: true }),
    /Key/,
  );
  await assert.rejects(
    f.store.resolve("text", expected(f.view), { secret: true }),
    /已变化/,
  );
  const exposed = JSON.stringify(await f.store.inspect());
  for (const marker of [
    "synthetic-key-A",
    "synthetic-key-B",
    "encryptedKey",
    "credentialScope",
    "sealed:",
  ])
    assert.ok(!exposed.includes(marker));
  assert.equal(f.legacy.encryptedKey, seal("synthetic-key-A"));
});
test("image configuration has its own route, key and budget; unavailable adapter refuses before decrypting or borrowing text capability", async () => {
  let decodes = 0;
  const f = await fixture({
    ...codec,
    decode: (value) => {
      decodes++;
      return unseal(value);
    },
  });
  let view = await f.store.add(
    {
      label: "图像服务",
      protocol: "openai-images",
      baseURL: "https://images.example/v1",
      model: "fixture-image",
      apiKey: "synthetic-image-key",
      imageBudget: { maxImages: 2, maxCost: 0, pricing: null },
    },
    expected(f.view),
  );
  const image = view.profiles.find((p) => p.protocol === "openai-images");
  assert.equal(image.runnable, false);
  assert.equal(image.imageBudget.pricing, null);
  view = await f.store.select("image", image.id, expected(view));
  assert.equal(view.routes.text, f.view.routes.text);
  await assert.rejects(
    f.store.select("text", image.id, expected(view)),
    /不匹配/,
  );
  await assert.rejects(
    f.store.resolve("image", expected(view), { secret: true }),
    /尚未确认/,
  );
  assert.equal(decodes, 0);
  assert.equal(
    (await f.store.resolve("text", expected(view), { secret: true })).apiKey,
    "synthetic-key-A",
  );
  assert.equal(decodes, 1);
});
test("explicit image response options persist independently, preserve their own key and authorize only their own confirmed image route", async () => {
  const f = await fixture();
  const image = {
    label: "有明确模式的图像",
    protocol: "openai-images",
    baseURL: "https://images.example/v1",
    model: "fixture-image",
    apiKey: "synthetic-image-options-key",
    imageOptions: { responseMode: "request-base64" },
  };
  let view = await f.store.add(image, expected(f.view));
  const item = view.profiles.find(
    (entry) => entry.protocol === "openai-images",
  );
  assert.deepEqual(item.imageOptions, { responseMode: "request-base64" });
  assert.equal(item.runnable, true);
  const before = await readFile(f.store.path);
  for (const bad of [
    { responseMode: "url" },
    { responseMode: "default-base64", baseURL: "https://other.example" },
    true,
  ])
    await assert.rejects(
      f.store.update(item.id, { ...image, imageOptions: bad }, expected(view)),
      /响应模式/,
    );
  await assert.rejects(
    f.store.add(
      { ...text(), imageOptions: { responseMode: "default-base64" } },
      expected(view),
    ),
    /混用/,
  );
  assert.deepEqual(await readFile(f.store.path), before);
  view = await f.store.update(
    item.id,
    { ...image, apiKey: "", imageOptions: { responseMode: "default-base64" } },
    expected(view),
  );
  assert.equal(
    view.profiles.find((entry) => entry.id === item.id).hasKey,
    true,
  );
  assert.deepEqual(
    view.profiles.find((entry) => entry.id === item.id).imageOptions,
    { responseMode: "default-base64" },
  );
  const reopened = new ModelProfiles(f.root, codec),
    inspected = await reopened.inspect();
  assert.deepEqual(
    inspected.profiles.find((entry) => entry.id === item.id).imageOptions,
    { responseMode: "default-base64" },
  );
  const selected = await reopened.select("image", item.id, expected(inspected));
  assert.equal(
    (await reopened.resolve("image", expected(selected), { secret: true }))
      .apiKey,
    image.apiKey,
  );
  view = await reopened.update(
    item.id,
    { ...image, imageOptions: null },
    expected(selected),
  );
  assert.equal(
    view.profiles.find((entry) => entry.id === item.id).imageOptions,
    null,
  );
  assert.equal(
    view.profiles.find((entry) => entry.id === item.id).runnable,
    false,
  );
  await assert.rejects(
    reopened.resolve("image", expected(view), { secret: true }),
    /尚未确认/,
  );
});

test("profile service changes clear old key unless explicitly replaced; protocol changes, active deletion and incompatible budgets refuse", async () => {
  const f = await fixture(),
    id = f.view.routes.text;
  let view = await f.store.update(
    id,
    {
      label: "主写作",
      protocol: "anthropic-text",
      baseURL: "https://new.example/tenant",
      model: "fixture-new",
    },
    expected(f.view),
  );
  assert.equal(view.profiles[0].hasKey, false);
  await assert.rejects(
    f.store.resolve("text", expected(view), { secret: true }),
    /Key/,
  );
  view = await f.store.update(
    id,
    { ...text("主写作", "https://new.example/tenant", "synthetic-new-key") },
    expected(view),
  );
  assert.equal(
    (await f.store.resolve("text", expected(view), { secret: true })).apiKey,
    "synthetic-new-key",
  );
  await assert.rejects(
    f.store.update(
      id,
      {
        label: "改成图像",
        protocol: "openai-images",
        baseURL: "https://images.example",
        model: "fixture",
      },
      expected(view),
    ),
    /独立配置/,
  );
  await assert.rejects(f.store.remove(id, expected(view)), /先切换/);
  await assert.rejects(
    f.store.add({ ...text(), imageBudget: {} }, expected(view)),
    /不能混用/,
  );
  view = await f.store.select("text", null, expected(view));
  await assert.rejects(
    f.store.resolve("text", expected(view), { secret: true }),
    /未选择/,
  );
  view = await f.store.remove(id, expected(view));
  assert.equal(view.profiles.length, 0);
});
test("stale revisions, same-revision external edits, future schema and bad UTF8 are preserved without resetting or rewriting", async () => {
  const f = await fixture();
  const valid = await readFile(f.store.path),
    raw = JSON.parse(valid);
  raw.profiles[0].label = "外部名字";
  const external = Buffer.from(JSON.stringify(raw));
  await writeFile(f.store.path, external);
  await assert.rejects(f.store.add(text(), expected(f.view)), /已变化/);
  assert.deepEqual(await readFile(f.store.path), external);
  for (const bad of [
    Buffer.from(JSON.stringify({ ...raw, schemaVersion: 99 })),
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  ]) {
    await writeFile(f.store.path, bad);
    await assert.rejects(f.store.inspect(), /无法读取/);
    await assert.rejects(f.store.add(text(), expected(f.view)), /无法读取/);
    assert.deepEqual(await readFile(f.store.path), bad);
  }
  await writeFile(f.store.path, valid);
  assert.equal((await f.store.inspect()).revision, f.view.revision);
});
test("encryption failure and an external edit during encryption cannot corrupt prior configuration or falsely save a key", async () => {
  let mutate;
  const f = await fixture({
      ...codec,
      encode: async (key) => {
        if (mutate) await mutate();
        return seal(key);
      },
    }),
    before = await readFile(f.store.path);
  mutate = async () => {
    const raw = JSON.parse(before);
    raw.profiles[0].label = "并发外部修改";
    await writeFile(f.store.path, JSON.stringify(raw));
  };
  await assert.rejects(f.store.add(text(), expected(f.view)), /外部修改/);
  assert.equal(
    JSON.parse(await readFile(f.store.path)).profiles[0].label,
    "并发外部修改",
  );
  const failed = new ModelProfiles(f.root, {
      available: () => false,
      encode: () => {
        throw Error("must not call");
      },
      decode: unseal,
    }),
    current = await failed.inspect(),
    bytes = await readFile(failed.path);
  await assert.rejects(failed.add(text(), expected(current)), /不可用/);
  assert.deepEqual(await readFile(failed.path), bytes);
});
test("two service instances cannot concurrently mutate one file; second migration and profile-path links refuse adoption", async () => {
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    hit = new Promise((resolve) => (entered = resolve));
  const f = await fixture({
      ...codec,
      encode: async (key) => {
        entered();
        await gate;
        return seal(key);
      },
    }),
    other = new ModelProfiles(f.root, codec);
  const pending = f.store.add(text(), expected(f.view));
  await hit;
  await assert.rejects(other.add(text("另一写入"), expected(f.view)), /占用/);
  release();
  await pending;
  const original = await readFile(f.store.path);
  await assert.rejects(f.store.initializeFromLegacy(f.legacy), /已经建立/);
  assert.deepEqual(await readFile(f.store.path), original);
  const linkedRoot = await mkdtemp(join(tmpdir(), "zinovel-model-link-")),
    linked = new ModelProfiles(linkedRoot, codec);
  await symlink(f.store.path, linked.path, "file");
  await assert.rejects(linked.inspect(), /无法读取/);
  assert.deepEqual(await readFile(f.store.path), original);
});
test("duplicate names, hidden cipher fields and unpriced image thresholds cannot enter the stored profile document", async () => {
  const f = await fixture(),
    before = await readFile(f.store.path);
  await assert.rejects(
    f.store.add(text("默认文字服务"), expected(f.view)),
    /重复/,
  );
  await assert.rejects(
    f.store.add({ ...text(), encryptedKey: seal("forged") }, expected(f.view)),
    /字段/,
  );
  await assert.rejects(
    f.store.add(
      {
        label: "图像",
        protocol: "openai-images",
        baseURL: "https://images.example/v1",
        model: "fixture-image",
        imageBudget: { maxCost: 1 },
      },
      expected(f.view),
    ),
    /单价/,
  );
  await assert.rejects(
    f.store.add(
      {
        label: "图像",
        protocol: "openai-images",
        baseURL: "https://images.example/v1",
      },
      expected(f.view),
    ),
    /明确填写/,
  );
  assert.deepEqual(await readFile(f.store.path), before);
});

test("profile count and oversized-file limits refuse additional writes without erasing existing metadata", async () => {
  const f = await fixture();
  let view = f.view;
  for (let index = 1; index < 20; index++)
    view = await f.store.add(
      {
        ...text(
          `合成配置${index}`,
          `https://service${index}.example/anthropic`,
        ),
        apiKey: "",
      },
      expected(view),
    );
  const before = await readFile(f.store.path);
  assert.equal(view.profiles.length, 20);
  await assert.rejects(f.store.add(text("第21项"), expected(view)), /20个/);
  assert.deepEqual(await readFile(f.store.path), before);
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
  await writeFile(f.store.path, tooLarge);
  await assert.rejects(f.store.inspect(), /无法读取/);
  await assert.rejects(f.store.add(text(), expected(view)), /无法读取/);
  assert.deepEqual(await readFile(f.store.path), tooLarge);
});

test("migration activation failure publishes no profiles; an activation interrupted after its pointer can be explicitly retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinovel-model-activation-")),
    store = new ModelProfiles(root, codec),
    legacy = {
      baseURL: "https://a.example/anthropic",
      model: "synthetic-A",
      encryptedKey: seal("synthetic-A"),
    };
  let activation;
  await assert.rejects(
    store.initializeFromLegacy(legacy, {
      beforeCommit: async (view) => {
        activation = view.storeId;
        assert.equal((await store.inspect()).initialized, false);
        throw new Error("synthetic activation interruption");
      },
    }),
    /synthetic activation interruption/,
  );
  assert.match(activation, /^[a-f0-9-]{36}$/);
  assert.equal((await store.inspect()).initialized, false);
  const saved = await store.initializeFromLegacy(legacy, {
    beforeCommit: async (view) => {
      activation = view.storeId;
    },
  });
  assert.equal(saved.storeId, activation);
  assert.equal(
    (await store.resolve("text", expected(saved), { secret: true })).apiKey,
    "synthetic-A",
  );
});
