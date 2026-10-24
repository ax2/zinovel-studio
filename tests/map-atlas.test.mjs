import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mapAtlasInput,
  validateMapAtlasRecord,
  atlasLimits,
  mapAtlasDraftInput,
  parseMapAtlasDraft,
} from "../packages/novel-domain/map-atlas.mjs";
const entry = (
  mapId = randomUUID(),
  parentId = null,
  anchorId = null,
  epochId = null,
) => ({ mapId, parentId, anchorId, epochId, notes: "" });
const input = () => ({
  notes: "作者目录，不推断年代顺序𠮷🌊",
  epochs: [],
  entries: [],
});
test("local atlas drafts retain empty epoch names, incomplete anchors, temporarily cyclic choices and unfinished Unicode without accepting them as formal data", () => {
  const bookId = randomUUID(),
    root = entry();
  const value = {
    schemaVersion: 1,
    bookId,
    expected: null,
    input: {
      ...input(),
      notes: "未完成\ud800",
      epochs: [{ id: randomUUID(), title: "", notes: "" }],
      entries: [{ ...root, parentId: root.mapId, anchorId: null }],
    },
    selectedMapId: root.mapId,
  };
  const raw = JSON.stringify(value);
  assert.deepEqual(parseMapAtlasDraft(raw, bookId), value);
  assert.deepEqual(mapAtlasDraftInput(value.input), value.input);
  assert.throws(() => mapAtlasInput(value.input));
  assert.equal(JSON.stringify(value), raw);
});
test("future, foreign or malformed local atlas draft envelopes preserve raw input and reject ambiguous identities", () => {
  const bookId = randomUUID(),
    value = {
      schemaVersion: 1,
      bookId,
      expected: { revision: 2, diskHash: "a".repeat(64) },
      input: input(),
      selectedMapId: null,
    };
  assert.deepEqual(parseMapAtlasDraft(JSON.stringify(value), bookId), value);
  for (const invalid of [
    { ...value, schemaVersion: 99 },
    { ...value, bookId: randomUUID() },
    { ...value, future: true },
    { ...value, expected: { revision: 2, diskHash: "bad" } },
    { ...value, selectedMapId: "bad" },
    { ...value, input: { ...input(), entries: [entry("bad")] } },
  ]) {
    const raw = JSON.stringify(invalid);
    assert.throws(() => parseMapAtlasDraft(raw, bookId));
    assert.equal(JSON.stringify(invalid), raw);
  }
});
test("manual epoch order and world/city/interior identities remain independent without guessing same names or coordinate transforms", () => {
  const world = entry(),
    city = entry(randomUUID(), world.mapId, randomUUID()),
    interior = entry(randomUUID(), city.mapId, randomUUID());
  const epochA = { id: randomUUID(), title: "河历三年", notes: "" },
    epochB = { id: randomUUID(), title: "河历三年", notes: "同名但身份不同" };
  const value = {
    ...input(),
    epochs: [epochB, epochA],
    entries: [interior, world, { ...city, epochId: epochA.id }],
  };
  assert.deepEqual(mapAtlasInput(value), value);
  const copy = mapAtlasInput(value);
  copy.entries[0].notes = "后来改目录";
  assert.equal(value.entries[0].notes, "");
});
test("duplicate map/epoch identity, missing groups, half anchors and indirect/self cycles reject rather than repair silently", () => {
  const root = entry(),
    child = entry(randomUUID(), root.mapId, randomUUID()),
    epoch = { id: randomUUID(), title: "旧城", notes: "" };
  for (const value of [
    { ...input(), entries: [root, root] },
    { ...input(), epochs: [epoch, epoch] },
    { ...input(), entries: [{ ...root, epochId: epoch.id }] },
    { ...input(), entries: [child] },
    { ...input(), entries: [{ ...root, anchorId: randomUUID() }] },
    { ...input(), entries: [root, { ...child, anchorId: null }] },
    {
      ...input(),
      entries: [{ ...root, parentId: root.mapId, anchorId: randomUUID() }],
    },
    {
      ...input(),
      entries: [
        { ...root, parentId: child.mapId, anchorId: randomUUID() },
        child,
      ],
    },
  ]) {
    const before = JSON.stringify(value);
    assert.throws(() => mapAtlasInput(value));
    assert.equal(JSON.stringify(value), before);
  }
});
test("unknown schemas/fields, malformed Unicode, foreign origins and excessive depth preserve input and refuse writes", () => {
  const bookId = randomUUID(),
    now = new Date().toISOString(),
    record = {
      ...input(),
      schemaVersion: 1,
      bookId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  assert.deepEqual(validateMapAtlasRecord(record, [bookId]), record);
  for (const value of [
    { ...record, schemaVersion: 2 },
    { ...record, future: true },
    { ...record, notes: "bad\ud800" },
    { ...record, revision: 1.5 },
  ])
    assert.throws(() => validateMapAtlasRecord(value, [bookId]));
  assert.throws(() => validateMapAtlasRecord(record, [randomUUID()]), /所属/);
  const nodes = [entry()];
  for (let i = 1; i < atlasLimits.depth; i++)
    nodes.push(entry(randomUUID(), nodes[i - 1].mapId, randomUUID()));
  assert.equal(
    mapAtlasInput({ ...input(), entries: nodes }).entries.length,
    atlasLimits.depth,
  );
  nodes.push(entry(randomUUID(), nodes.at(-1).mapId, randomUUID()));
  assert.throws(() => mapAtlasInput({ ...input(), entries: nodes }), /深度/);
});
