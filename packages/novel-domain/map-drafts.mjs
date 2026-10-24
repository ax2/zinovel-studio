import {
  mapDraftInput,
  mapHash,
  mapId,
  mapInput,
  mapPoint,
  mapPolygon,
  mapLimits,
} from "./maps.mjs";

function known(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...names].sort().join(",")
  )
    throw new Error("本机地图草稿格式无法识别，已保留");
}
function localText(value, max) {
  // Unfinished input is deliberately allowed here; applying/saving validates separately.
  if (typeof value !== "string" || value.length > max)
    throw new Error("本机地图输入过长或无法识别，已保留");
  return value;
}
export function referenceForMap(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new Error("地图版本无效");
  return {
    id: mapId(value.id),
    revision: value.revision,
    diskHash: mapHash(value.diskHash),
  };
}
export function fieldsForMap(value) {
  return mapDraftInput(
    Object.fromEntries(
      ["title", "notes", "era", "canvas", "scale", "elements"].map((key) => [
        key,
        value?.[key],
      ]),
    ),
  );
}
function scaleDraft(value) {
  if (value === null) return null;
  known(value, ["from", "to", "distance", "unit"]);
  return {
    from: localText(value.from, 128),
    to: localText(value.to, 128),
    distance: localText(value.distance, 128),
    unit: localText(value.unit, 200),
  };
}
export function parseMapLocalDraft(raw, bookId, id) {
  if (typeof raw !== "string" || raw.length > 2 * 1024 * 1024)
    throw new Error("本机地图草稿过大或无法识别，已保留");
  const value = JSON.parse(raw);
  known(value, [
    "schemaVersion",
    "bookId",
    "id",
    "expected",
    "input",
    "selectedId",
    "coordinates",
    "scale",
    "drawingId",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.bookId !== mapId(bookId) ||
    value.id !== mapId(id)
  )
    throw new Error("本机地图草稿版本或作品不符，已保留");
  known(value.expected, ["id", "revision", "diskHash"]);
  const expected = referenceForMap(value.expected),
    input = mapDraftInput(value.input);
  if (expected.id !== id) throw new Error("本机地图草稿身份不符，已保留");
  const selectedId = value.selectedId === null ? null : mapId(value.selectedId),
    selected = input.elements.find((item) => item.id === selectedId);
  if (selectedId && !selected)
    throw new Error("本机地图对象草稿身份失联，已保留");
  let coordinates = null;
  if (value.coordinates !== null) {
    known(value.coordinates, ["id", "value"]);
    if (mapId(value.coordinates.id) !== selectedId || !selected)
      throw new Error("本机坐标草稿对象不符，已保留");
    coordinates = {
      id: selectedId,
      value: localText(value.coordinates.value, 65536),
    };
  }
  const drawingId = value.drawingId === null ? null : mapId(value.drawingId);
  if (
    drawingId &&
    (drawingId !== selectedId ||
      selected?.kind !== "region" ||
      selected.deletedAt)
  )
    throw new Error("本机区域绘制状态不符，已保留");
  return {
    schemaVersion: 1,
    bookId,
    id,
    expected,
    input,
    selectedId,
    coordinates,
    scale: scaleDraft(value.scale),
    drawingId,
  };
}
export function parseMapCreationIntent(raw, bookId) {
  if (typeof raw !== "string" || raw.length > 2 * 1024 * 1024)
    throw new Error("本机地图创建记录过大，已保留");
  const value = JSON.parse(raw);
  known(value, ["schemaVersion", "bookId", "id", "input"]);
  if (value.schemaVersion !== 1 || value.bookId !== mapId(bookId))
    throw new Error("本机地图创建记录无法识别，已保留");
  return {
    schemaVersion: 1,
    bookId,
    id: mapId(value.id),
    input: mapInput(value.input),
  };
}
function numberText(value) {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
    throw new Error("请填写完整有效数字，空白不会按零处理");
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error("数字超出有效范围");
  return number;
}
export function parseMapCoordinates(value, min = 0, max = mapLimits.vertices) {
  const raw = localText(value, 65536).trim(),
    lines = raw ? raw.split(/\r?\n/) : [];
  if (lines.length < min || lines.length > max)
    throw new Error(`请填写${min}至${max}行坐标，每行x,y，不写百分号`);
  return lines.map((line) => {
    const pair = line.replaceAll("，", ",").split(",");
    if (pair.length !== 2) throw new Error("每行应为x,y两个百分比坐标");
    return mapPoint({
      x: numberText(pair[0]) / 100,
      y: numberText(pair[1]) / 100,
    });
  });
}
export function mapCoordinateText(element) {
  const points =
    element.kind === "place"
      ? [element.point]
      : element.kind === "region"
        ? element.points
        : element.via;
  return points.map((p) => `${p.x * 100},${p.y * 100}`).join("\n");
}
export function applyMapCoordinates(input, draft) {
  const data = mapDraftInput(input);
  if (draft === null) return data;
  const index = data.elements.findIndex((item) => item.id === mapId(draft.id));
  if (index < 0) throw new Error("坐标所属对象已不存在，输入已保留");
  const element = data.elements[index];
  if (element.deletedAt) throw new Error("请先恢复地图对象再修改坐标");
  const points = parseMapCoordinates(
    draft.value,
    element.kind === "place" ? 1 : element.kind === "region" ? 3 : 0,
    element.kind === "place" ? 1 : mapLimits.vertices,
  );
  data.elements[index] =
    element.kind === "place"
      ? { ...element, point: points[0] }
      : element.kind === "region"
        ? { ...element, points: mapPolygon(points) }
        : { ...element, via: points };
  return data;
}
export function applyMapScale(input, draft) {
  const data = mapDraftInput(input);
  if (draft === null) return data;
  const value = scaleDraft(draft),
    unit = value.unit;
  if (!unit.trim() || !unit.isWellFormed() || unit.length > 30)
    throw new Error("比例尺需要1至30字符的完整单位");
  data.scale = {
    from: parseMapCoordinates(value.from, 1, 1)[0],
    to: parseMapCoordinates(value.to, 1, 1)[0],
    distance: numberText(value.distance),
    unit,
  };
  return mapDraftInput(data);
}
