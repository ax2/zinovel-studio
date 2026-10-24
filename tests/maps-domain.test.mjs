import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mapInput,
  mapDraftInput,
  mapPoint,
  mapPolygon,
  mapRouteGeometry,
  mapRouteGeometries,
  validateMapRecord,
} from "../packages/novel-domain/maps.mjs";

const xy = (x, y) => ({ x, y });
const place = (x, y, title = "同名港口") => ({
  id: randomUUID(),
  kind: "place",
  title,
  notes: "作者绘制",
  locationId: null,
  point: xy(x, y),
});
const region = (points) => ({
  id: randomUUID(),
  kind: "region",
  title: "湾区",
  notes: "合成边界",
  locationId: null,
  points,
});
const base = () => ({
  title: "河历三年 · 雾港𠮷🌊",
  notes: "虚构平面，无自动地理推断",
  era: "河历三年",
  canvas: { width: 1000, height: 500 },
  scale: null,
  elements: [],
});
const route = (from, to, via = []) => ({
  id: randomUUID(),
  kind: "route",
  title: "合成路线",
  notes: "手工路线",
  fromId: from.id,
  toId: to.id,
  via,
  travelNotes: "行程由作者另行说明",
});

test("simple concave polygons accept either winding and straight continuations; invalid crossings, touching, repeated or zero-area borders refuse", () => {
  const concave = [xy(0, 0), xy(1, 0), xy(1, 1), xy(0.5, 0.5), xy(0, 1)];
  assert.deepEqual(mapPolygon(concave), concave);
  assert.deepEqual(mapPolygon([...concave].reverse()), [...concave].reverse());
  const straight = [xy(0, 0), xy(0.5, 0), xy(1, 0), xy(1, 1), xy(0, 1)];
  assert.deepEqual(mapPolygon(straight), straight);
  for (const invalid of [
    [xy(0, 0), xy(1, 1), xy(0, 1), xy(1, 0)],
    [xy(0, 0), xy(1, 0), xy(0.5, 0), xy(1, 1), xy(0, 1)],
    [xy(0, 0), xy(1, 0), xy(1, 1), xy(0, 0)],
    [xy(0, 0), xy(0.5, 0.5), xy(1, 1)],
    [xy(0, 0), xy(1, 0), xy(1, 1), xy(0.5, 0), xy(0, 1)],
  ])
    assert.throws(() => mapPolygon(invalid), /自交|接触|重复|重叠|面积/);
});

test("route distances use actual canvas aspect and only explicit author calibration; no automatic travel time or default units", () => {
  const data = base(),
    a = place(0, 0),
    b = place(1, 1),
    path = route(a, b, [xy(1, 0)]);
  data.elements = [a, b, path];
  assert.deepEqual(mapRouteGeometry(data, path.id), {
    points: [a.point, xy(1, 0), b.point],
    distance: null,
    unit: null,
    state: "unscaled",
  });
  data.scale = { from: xy(0, 0), to: xy(1, 0), distance: 100, unit: "里" };
  const result = mapRouteGeometry(data, path.id);
  assert.equal(result.distance, 150);
  assert.equal(result.unit, "里");
  assert.equal(result.state, "author-scaled");
  assert.equal(Object.hasOwn(result, "travelTime"), false);
  const loop = route(a, a, [xy(1, 0)]);
  data.elements.push(loop);
  assert.equal(mapRouteGeometry(data, loop.id).distance, 200);
  assert.equal(mapRouteGeometries(data).length, 2);
  assert.equal(mapRouteGeometries(data)[0].id, path.id);
});

test("route endpoints retain identity through same-name, retired and missing points without guessed replacement", () => {
  const data = base(),
    a = place(0, 0),
    b = place(1, 1),
    sameName = place(0.2, 0.3),
    path = route(a, b);
  data.elements = [a, b, sameName, path];
  assert.equal(mapRouteGeometry(data, path.id).state, "unscaled");
  b.deletedAt = "2026-10-24T00:00:00.000Z";
  assert.equal(mapRouteGeometry(data, path.id).state, "missing-endpoint");
  data.elements = data.elements.filter((e) => e.id !== b.id);
  const missing = mapRouteGeometry(data, path.id);
  assert.equal(missing.state, "missing-endpoint");
  assert.equal(missing.distance, null);
  assert.deepEqual(missing.points, []);
  assert.equal(
    mapInput(data).elements.find((e) => e.kind === "route").toId,
    b.id,
  );
  path.deletedAt = "2026-10-24T00:00:00.000Z";
  assert.equal(mapRouteGeometry(data, path.id).state, "retired");
});

test("route preview remains available during unfinished region/title edits without making that draft a formal map", () => {
  const data = base(),
    a = place(0, 0),
    b = place(1, 1),
    path = route(a, b);
  data.title = "";
  data.elements = [a, b, path, region([])];
  assert.equal(mapRouteGeometry(data, path.id).state, "unscaled");
  assert.deepEqual(mapRouteGeometry(data, path.id).points, [a.point, b.point]);
  assert.throws(() => mapInput(data), /地图文字|顶点/);
  data.scale = { from: xy(0, 0), to: xy(1, 0), distance: 100, unit: "" };
  assert.equal(mapRouteGeometry(data, path.id).distance, null);
});

test("local map draft preserves temporarily blank titles and unfinished drawing but formal records reject them; captured inputs are independent", () => {
  const data = base();
  data.title = "";
  data.notes = "未完成\ud800";
  data.elements = [region([])];
  const draft = mapDraftInput(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(draft, data);
  assert.throws(() => mapInput(draft), /地图文字|顶点/);
  const formal = base(),
    a = place(0.2, 0.3);
  formal.elements = [a];
  const captured = mapInput(formal);
  a.point.x = 0.8;
  formal.canvas.width = 400;
  assert.equal(captured.elements[0].point.x, 0.2);
  assert.equal(captured.canvas.width, 1000);
});

test("map coordinate, identity, geometry and scale resource boundaries reject invalid or future values without truncation", () => {
  for (const x of [NaN, Infinity, -Infinity, -0.001, 1.001, "0.5", null])
    assert.throws(() => mapPoint(xy(x, 0)), /范围/);
  assert.deepEqual(mapPoint(xy(0, 1)), xy(0, 1));
  const data = base(),
    a = place(0, 0);
  data.elements = [
    a,
    { ...a, kind: "region", points: [xy(0, 0), xy(1, 0), xy(0, 1)] },
  ];
  delete data.elements[1].point;
  assert.throws(() => mapInput(data), /身份重复/);
  assert.throws(() => mapInput({ ...base(), future: true }), /不支持/);
  assert.throws(
    () => mapInput({ ...base(), canvas: { width: 0, height: 500 } }),
    /尺寸/,
  );
  assert.throws(
    () =>
      mapInput({
        ...base(),
        elements: Array.from({ length: 1001 }, () => place(0, 0)),
      }),
    /最多/,
  );
  assert.throws(
    () =>
      mapInput({
        ...base(),
        elements: [
          region(Array.from({ length: 129 }, (_, i) => xy(i / 129, 0))),
        ],
      }),
    /顶点/,
  );
  for (const scale of [
    { from: xy(0, 0), to: xy(0, 0), distance: 1, unit: "里" },
    { from: xy(0, 0), to: xy(1, 0), distance: -1, unit: "里" },
    { from: xy(0, 0), to: xy(1, 0), distance: Infinity, unit: "里" },
    { from: xy(0, 0), to: xy(1, 0), distance: 1, unit: "" },
  ])
    assert.throws(() => mapInput({ ...base(), scale }), /比例尺|范围|地图文字/);
});

test("frozen background requires same-book origin, strict asset identity and display-oriented canvas; unknown schema remains unsupported", () => {
  const bookId = randomUUID(),
    id = randomUUID(),
    now = "2026-10-24T00:00:00.000Z";
  const asset = {
    schemaVersion: 1,
    id: randomUUID(),
    bookId,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    creationHash: "a".repeat(64),
    title: "合成方向底图",
    purpose: "map",
    source: "程序合成",
    rights: "本地验收",
    notes: "",
    linkedIds: [],
    blob: {
      sha256: "b".repeat(64),
      bytes: 100,
      format: "jpeg",
      mime: "image/jpeg",
      width: 100,
      height: 50,
      orientation: 6,
      displayWidth: 50,
      displayHeight: 100,
    },
  };
  const record = {
    ...base(),
    schemaVersion: 1,
    id,
    bookId,
    revision: 1,
    creationHash: "c".repeat(64),
    createdAt: now,
    updatedAt: now,
    canvas: { width: 50, height: 100 },
    background: { record: asset, diskHash: "d".repeat(64) },
  };
  assert.equal(validateMapRecord(record, id, [bookId]), record);
  assert.throws(
    () =>
      validateMapRecord({ ...record, canvas: { width: 100, height: 50 } }, id, [
        bookId,
      ]),
    /方向尺寸/,
  );
  assert.throws(
    () => validateMapRecord(record, id, [randomUUID()]),
    /所属作品/,
  );
  const foreign = structuredClone(record);
  foreign.background.record.bookId = randomUUID();
  assert.throws(() => validateMapRecord(foreign, id, [bookId]), /所属作品/);
  assert.throws(
    () => validateMapRecord({ ...record, schemaVersion: 99 }, id, [bookId]),
    /版本/,
  );
  assert.throws(
    () => validateMapRecord({ ...record, future: {} }, id, [bookId]),
    /不支持/,
  );
});
