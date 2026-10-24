import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mapInput } from "../packages/novel-domain/maps.mjs";
import {
  parseMapLocalDraft,
  parseMapCreationIntent,
  parseMapCoordinates,
  applyMapCoordinates,
  applyMapScale,
  mapCoordinateText,
} from "../packages/novel-domain/map-drafts.mjs";

const input = () => ({
  title: "地图",
  notes: "",
  era: "",
  canvas: { width: 1000, height: 700 },
  scale: null,
  elements: [],
});
function draft() {
  const id = randomUUID(),
    bookId = randomUUID(),
    regionId = randomUUID();
  return {
    schemaVersion: 1,
    bookId,
    id,
    expected: { id, revision: 2, diskHash: "a".repeat(64) },
    input: {
      ...input(),
      title: "",
      notes: "未完成\ud800",
      elements: [
        {
          id: regionId,
          kind: "region",
          title: "区域",
          notes: "",
          locationId: null,
          points: [],
        },
      ],
    },
    selectedId: regionId,
    coordinates: { id: regionId, value: "10,未完成\ud800" },
    scale: { from: "0,0", to: "100,0", distance: "", unit: "" },
    drawingId: regionId,
  };
}
test("unfinished coordinates, region, text and calibration round-trip locally without becoming valid formal data", () => {
  const value = draft(),
    raw = JSON.stringify(value);
  assert.deepEqual(parseMapLocalDraft(raw, value.bookId, value.id), value);
  assert.throws(() => mapInput(value.input), /文字|顶点/);
  assert.throws(
    () => applyMapCoordinates(value.input, value.coordinates),
    /填写|数字|坐标/,
  );
  assert.throws(() => applyMapScale(value.input, value.scale), /单位/);
  assert.equal(raw, JSON.stringify(value));
});
test("future local schemas/fields, wrong book or map baseline and mismatched selected objects reject without modifying the raw draft", () => {
  const value = draft();
  for (const invalid of [
    { ...value, schemaVersion: 99 },
    { ...value, future: "unknown" },
    { ...value, bookId: randomUUID() },
    { ...value, expected: { ...value.expected, id: randomUUID() } },
    { ...value, coordinates: { ...value.coordinates, id: randomUUID() } },
    { ...value, selectedId: randomUUID() },
    { ...value, scale: { ...value.scale, future: true } },
    { ...value, drawingId: randomUUID() },
  ]) {
    const raw = JSON.stringify(invalid);
    assert.throws(() => parseMapLocalDraft(raw, value.bookId, value.id));
    assert.equal(JSON.stringify(invalid), raw);
  }
});
test("coordinate entry uses complete percent pairs, keeps empty route bend lists, and never coerces blank/invalid input to zero", () => {
  assert.deepEqual(parseMapCoordinates("10，20\r\n100,0", 2), [
    { x: 0.1, y: 0.2 },
    { x: 1, y: 0 },
  ]);
  assert.deepEqual(parseMapCoordinates("", 0), []);
  for (const invalid of [
    ",20",
    "10,",
    "NaN,20",
    "0x10,20",
    "101,20",
    "-1,20",
    "10,20,30",
    "10% ,20",
  ]) {
    assert.throws(() => parseMapCoordinates(invalid, 1));
  }
  assert.deepEqual(parseMapCoordinates("10,20\n", 1), [{ x: 0.1, y: 0.2 }]);
  assert.throws(() => parseMapCoordinates("10,20\n30,40", 1, 1), /1行|1至1/);
});
test("applying raw object coordinates changes only that geometry and preserves caller and unrelated stable IDs", () => {
  const value = input(),
    id = randomUUID(),
    other = randomUUID();
  value.elements = [
    {
      id,
      kind: "place",
      title: "雾港",
      notes: "原注",
      locationId: null,
      point: { x: 0, y: 0 },
    },
    {
      id: other,
      kind: "region",
      title: "湾区",
      notes: "",
      locationId: null,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    },
  ];
  const moved = applyMapCoordinates(value, { id, value: "25,50" });
  assert.deepEqual(moved.elements[0].point, { x: 0.25, y: 0.5 });
  assert.equal(moved.elements[0].notes, "原注");
  assert.deepEqual(moved.elements[1], value.elements[1]);
  assert.deepEqual(value.elements[0].point, { x: 0, y: 0 });
  assert.equal(mapCoordinateText(moved.elements[0]), "25,50");
  assert.throws(
    () =>
      applyMapCoordinates(value, {
        id: other,
        value: "0,0\n100,100\n0,100\n100,0",
      }),
    /自交|面积/,
  );
});
test("calibration requires complete positive distance, distinct points and explicit complete unit; pending local data remains unchanged", () => {
  const data = input(),
    valid = { from: "0,0", to: "100,0", distance: "25.5", unit: "里" };
  const applied = applyMapScale(data, valid);
  assert.equal(applied.scale.distance, 25.5);
  assert.equal(applied.scale.unit, "里");
  assert.equal(data.scale, null);
  for (const invalid of [
    { ...valid, distance: "" },
    { ...valid, distance: "0" },
    { ...valid, distance: "-2" },
    { ...valid, to: "0,0" },
    { ...valid, unit: "" },
    { ...valid, unit: "未完成\ud800" },
  ])
    assert.throws(() => applyMapScale(data, invalid));
});
test("creation intents retain exact canonical payload and identity; future records or incomplete initial maps cannot be silently recreated", () => {
  const value = {
    schemaVersion: 1,
    bookId: randomUUID(),
    id: randomUUID(),
    input: input(),
  };
  assert.deepEqual(
    parseMapCreationIntent(JSON.stringify(value), value.bookId),
    value,
  );
  assert.throws(() =>
    parseMapCreationIntent(
      JSON.stringify({ ...value, schemaVersion: 2 }),
      value.bookId,
    ),
  );
  assert.throws(() =>
    parseMapCreationIntent(
      JSON.stringify({ ...value, input: { ...input(), title: "" } }),
      value.bookId,
    ),
  );
});
