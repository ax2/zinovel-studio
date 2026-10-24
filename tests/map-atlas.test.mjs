import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mapAtlasInput,
  validateMapAtlasRecord,
  atlasLimits,
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
  assert.throws(
    () => validateMapAtlasRecord(record, [randomUUID()]),
    /所属/,
  );
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
