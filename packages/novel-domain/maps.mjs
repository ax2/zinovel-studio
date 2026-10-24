import { validateAssetRecord, assetHash } from "./assets.mjs";

// Resource guards, not suggested counts or dimensions for a fictional world.
export const mapLimits = Object.freeze({
  elements: 1000,
  vertices: 128,
  bytes: 1024 * 1024,
});
const epsilon = 1e-12;
export function mapId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
  )
    throw new Error("地图对象身份无效");
  return value;
}
function keys(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("地图格式不支持，请保留原文件");
}
function text(value, max, required = false, draft = false) {
  if (
    typeof value !== "string" ||
    (!draft && !value.isWellFormed()) ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error("地图文字为空、过长或包含不完整Unicode");
  return value;
}
function finite(value, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("地图坐标或比例尺超出有效范围");
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("地图记录时间无效");
  return value;
}
export function mapPoint(value) {
  keys(value, ["x", "y"]);
  return { x: finite(value.x, 0, 1), y: finite(value.y, 0, 1) };
}
function canvas(value) {
  keys(value, ["width", "height"]);
  for (const axis of ["width", "height"])
    if (
      !Number.isSafeInteger(value[axis]) ||
      value[axis] < 1 ||
      value[axis] > 16384
    )
      throw new Error("地图画布尺寸应为1至16384的整数");
  return { width: value.width, height: value.height };
}
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const same = (a, b) =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
function onSegment(a, b, p) {
  return (
    Math.abs(cross(a, b, p)) <= epsilon &&
    p.x >= Math.min(a.x, b.x) - epsilon &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    p.y >= Math.min(a.y, b.y) - epsilon &&
    p.y <= Math.max(a.y, b.y) + epsilon
  );
}
function intersect(a, b, c, d) {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
      ((cdA > epsilon && cdB < -epsilon) ||
        (cdA < -epsilon && cdB > epsilon))) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
function points(value, min) {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > mapLimits.vertices
  )
    throw new Error(`地图顶点数量应为${min}至${mapLimits.vertices}`);
  return value.map(mapPoint);
}
export function mapPolygon(value) {
  const polygon = points(value, 3);
  for (let i = 0; i < polygon.length; i++) {
    for (let j = i + 1; j < polygon.length; j++) {
      if (same(polygon[i], polygon[j]))
        throw new Error("区域顶点重复，无需重复首点");
      if (j === i + 1 || (i === 0 && j === polygon.length - 1)) continue;
      if (
        intersect(
          polygon[i],
          polygon[(i + 1) % polygon.length],
          polygon[j],
          polygon[(j + 1) % polygon.length],
        )
      )
        throw new Error("区域边界自交或接触，请调整顶点");
    }
    // Adjacent collinear edges may continue straight, but may not fold back over each other.
    const previous = polygon[(i + polygon.length - 1) % polygon.length],
      current = polygon[i],
      next = polygon[(i + 1) % polygon.length];
    if (
      Math.abs(cross(previous, current, next)) <= epsilon &&
      (onSegment(previous, current, next) || onSegment(current, next, previous))
    )
      throw new Error("区域相邻边界重叠，请调整顶点");
  }
  const twiceArea = polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  if (Math.abs(twiceArea) <= epsilon) throw new Error("区域面积为零或过小");
  return polygon;
}
function scale(value, frame, draft) {
  if (value === null) return null;
  keys(value, ["from", "to", "distance", "unit"]);
  const from = mapPoint(value.from),
    to = mapPoint(value.to),
    distance = finite(value.distance, Number.MIN_VALUE, 1e12);
  if (same(from, to)) throw new Error("比例尺的两个参考点必须不同");
  // Guard underflow and scales that cannot be represented after conversion.
  const referencePixels = Math.hypot(
    (to.x - from.x) * frame.width,
    (to.y - from.y) * frame.height,
  );
  if (
    !Number.isFinite(distance / referencePixels) ||
    distance / referencePixels === 0
  )
    throw new Error("比例尺过小或过大");
  return { from, to, distance, unit: text(value.unit, 30, !draft, draft) };
}
function element(value, draft) {
  const common = ["id", "kind", "title", "notes", "deletedAt"];
  const kind = value?.kind;
  const extra =
    kind === "place"
      ? ["point", "locationId"]
      : kind === "region"
        ? ["points", "locationId"]
        : kind === "route"
          ? ["fromId", "toId", "via", "travelNotes"]
          : null;
  if (!extra) throw new Error("地图对象类型不支持，请保留原文件");
  keys(value, [...common, ...extra]);
  const result = {
    id: mapId(value.id),
    kind,
    title: text(value.title, 200, !draft, draft),
    notes: text(value.notes, 8000, false, draft),
  };
  if (value.deletedAt !== undefined)
    result.deletedAt = timestamp(value.deletedAt);
  if (kind === "route") {
    return {
      ...result,
      fromId: mapId(value.fromId),
      toId: mapId(value.toId),
      via: points(value.via, 0),
      travelNotes: text(value.travelNotes, 4000, false, draft),
    };
  }
  if (value.locationId !== null) result.locationId = mapId(value.locationId);
  else result.locationId = null;
  return kind === "place"
    ? { ...result, point: mapPoint(value.point) }
    : {
        ...result,
        points: draft ? points(value.points, 0) : mapPolygon(value.points),
      };
}
function input(value, draft) {
  keys(value, ["title", "notes", "era", "canvas", "scale", "elements"]);
  const frame = canvas(value.canvas);
  if (
    !Array.isArray(value.elements) ||
    value.elements.length > mapLimits.elements
  )
    throw new Error(`地图最多保存${mapLimits.elements}个对象，请分为多张地图`);
  const elements = value.elements.map((item) => element(item, draft));
  if (new Set(elements.map((item) => item.id)).size !== elements.length)
    throw new Error("地图对象身份重复");
  return {
    title: text(value.title, 200, !draft, draft),
    notes: text(value.notes, 16000, false, draft),
    era: text(value.era, 200, false, draft),
    canvas: frame,
    scale: scale(value.scale, frame, draft),
    elements,
  };
}
export const mapInput = (value) => input(value, false);
// Temporary empty titles and incomplete region drawings are local drafts only.
export const mapDraftInput = (value) => input(value, true);
export function mapBackground(value, origins) {
  if (value === null) return null;
  keys(value, ["record", "diskHash"]);
  validateAssetRecord(value.record, value.record?.id, origins);
  assetHash(value.diskHash);
  return { record: structuredClone(value.record), diskHash: value.diskHash };
}
export function validateMapRecord(record, id, origins) {
  keys(record, [
    "schemaVersion",
    "id",
    "bookId",
    "creationHash",
    "revision",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "title",
    "notes",
    "era",
    "canvas",
    "scale",
    "elements",
    "background",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.id !== mapId(id) ||
    !origins.includes(mapId(record.bookId)) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  )
    throw new Error("地图版本或所属作品不符，请保留原文件");
  timestamp(record.createdAt);
  timestamp(record.updatedAt);
  if (record.deletedAt !== undefined) timestamp(record.deletedAt);
  assetHash(record.creationHash);
  const data = mapInput(
    Object.fromEntries(
      ["title", "notes", "era", "canvas", "scale", "elements"].map((key) => [
        key,
        record[key],
      ]),
    ),
  );
  const background = mapBackground(record.background, origins);
  if (
    background &&
    (data.canvas.width !== background.record.blob.displayWidth ||
      data.canvas.height !== background.record.blob.displayHeight)
  )
    throw new Error("地图画布与冻结底图方向尺寸不符，请保留原文件");
  return record;
}
function routeGeometry(data, route, places) {
  const from = places.get(route.fromId),
    to = places.get(route.toId);
  const unavailable = [from, to].some((e) => !e || e.deletedAt);
  if (unavailable || route.deletedAt)
    return {
      points: [],
      distance: null,
      unit: null,
      state: route.deletedAt ? "retired" : "missing-endpoint",
    };
  const line = [from.point, ...route.via, to.point],
    length = line
      .slice(1)
      .reduce(
        (sum, p, i) =>
          sum +
          Math.hypot(
            (p.x - line[i].x) * data.canvas.width,
            (p.y - line[i].y) * data.canvas.height,
          ),
        0,
      );
  if (!data.scale)
    return { points: line, distance: null, unit: null, state: "unscaled" };
  const ref = Math.hypot(
    (data.scale.to.x - data.scale.from.x) * data.canvas.width,
    (data.scale.to.y - data.scale.from.y) * data.canvas.height,
  );
  const distance = (length / ref) * data.scale.distance;
  if (!Number.isFinite(distance)) throw new Error("路线距离超出可表示范围");
  return {
    points: line,
    distance,
    unit: data.scale.unit,
    state: "author-scaled",
  };
}
export function mapRouteGeometries(input) {
  const data = mapInput(input),
    places = new Map(
      data.elements.filter((e) => e.kind === "place").map((e) => [e.id, e]),
    );
  return data.elements
    .filter((e) => e.kind === "route")
    .map((route) => ({ id: route.id, ...routeGeometry(data, route, places) }));
}
export function mapRouteGeometry(input, routeId) {
  const id = mapId(routeId),
    result = mapRouteGeometries(input).find((route) => route.id === id);
  if (!result) throw new Error("路线不存在");
  const { id: _, ...geometry } = result;
  return geometry;
}
