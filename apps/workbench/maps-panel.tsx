import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type Book } from "./api";
import { registerEditorCloseGuard } from "./editor-close-guards";
import {
  MapCanvas,
  type MapCanvasActions,
  type MapCanvasMode,
} from "./map-canvas";
import {
  mapInput,
  mapPolygon,
  mapLimits,
  mapRouteGeometry,
  type MapRecord,
  type MapReference,
  type MapSummary,
  type MapInput,
  type MapElement,
  type MapPoint,
} from "../../packages/novel-domain/maps.mjs";
import {
  fieldsForMap,
  referenceForMap,
  parseMapLocalDraft,
  parseMapCreationIntent,
  mapCoordinateText,
  applyMapCoordinates,
  applyMapScale,
  parseMapCoordinates,
  type MapCoordinateDraft,
  type MapScaleDraft,
  type MapCreationIntent,
} from "../../packages/novel-domain/map-drafts.mjs";
import type { AssetRecord } from "../../packages/novel-domain/assets.mjs";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const blank = (): MapInput => ({
  title: "新地图",
  notes: "",
  era: "",
  canvas: { width: 1000, height: 700 },
  scale: null,
  elements: [],
});
const kinds = { place: "地点", region: "区域", route: "路线" };
interface Editor {
  record: MapRecord | null;
  base: MapReference | null;
  input: MapInput | null;
  selectedId: string | null;
  coordinates: MapCoordinateDraft | null;
  scaleRaw: MapScaleDraft | null;
  drawingId: string | null;
  dirty: boolean;
  locked: boolean;
  cleanup: boolean;
  busy: boolean;
  composing: boolean;
  dragging: boolean;
  past: MapInput[];
  future: MapInput[];
}
const emptyEditor = (): Editor => ({
  record: null,
  base: null,
  input: null,
  selectedId: null,
  coordinates: null,
  scaleRaw: null,
  drawingId: null,
  dirty: false,
  locked: false,
  cleanup: false,
  busy: false,
  composing: false,
  dragging: false,
  past: [],
  future: [],
});
const sameBase = (a: MapReference | null, b: MapReference | null) =>
  !!a &&
  !!b &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.diskHash === b.diskHash;
function scaleFields(input: MapInput | null): MapScaleDraft {
  const scale = input?.scale;
  return scale
    ? {
        from: `${scale.from.x * 100},${scale.from.y * 100}`,
        to: `${scale.to.x * 100},${scale.to.y * 100}`,
        distance: String(scale.distance),
        unit: scale.unit,
      }
    : { from: "0,0", to: "100,0", distance: "", unit: "" };
}
function coordinateDirty(editor: Editor) {
  if (!editor.coordinates) return false;
  const selected = editor.input?.elements.find(
    (item) => item.id === editor.coordinates!.id,
  );
  return !selected || mapCoordinateText(selected) !== editor.coordinates.value;
}
export function MapsPanel({
  book,
  onClose,
  onAssets,
  onEditLocation,
}: {
  book: Book;
  onClose: () => void;
  onAssets: () => void;
  onEditLocation: (id: string) => void;
}) {
  const [editor, setEditor] = useState<Editor>(emptyEditor),
    state = useRef(editor),
    signature = useRef(""),
    seen = useRef<{ id: string; raw: string | null } | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<MapSummary[]>([]),
    [total, setTotal] = useState(0),
    [listErrors, setListErrors] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [recycled, setRecycled] = useState(false),
    [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<"maps" | "objects">("maps"),
    [catalogExpanded, setCatalogExpanded] = useState(false),
    [objectQuery, setObjectQuery] = useState(""),
    [objectKind, setObjectKind] = useState(""),
    [objectRecycled, setObjectRecycled] = useState(false),
    [objectOffset, setObjectOffset] = useState(0);
  const [mode, setMode] = useState<MapCanvasMode>("select"),
    modeRef = useRef<MapCanvasMode>(mode),
    [calibration, setCalibration] = useState<MapPoint[]>([]);
  const [historical, setHistorical] = useState<MapRecord | null>(null),
    [historySelected, setHistorySelected] = useState<string | null>(null),
    [history, setHistory] = useState<MapRecord[]>([]),
    [historyErrors, setHistoryErrors] = useState<string[]>([]),
    [comparison, setComparison] = useState<MapRecord | null>(null);
  const [preview, setPreview] = useState(""),
    [previewError, setPreviewError] = useState("");
  const [assetsOpen, setAssetsOpen] = useState(false),
    [assets, setAssets] = useState<AssetRecord[]>([]),
    [assetQuery, setAssetQuery] = useState(""),
    [assetOffset, setAssetOffset] = useState(0),
    [assetTotal, setAssetTotal] = useState(0),
    [assetErrors, setAssetErrors] = useState<string[]>([]);
  const [locationsOpen, setLocationsOpen] = useState(false),
    [locations, setLocations] = useState<{ id: string; title: string }[]>([]),
    [locationQuery, setLocationQuery] = useState(""),
    [locationOffset, setLocationOffset] = useState(0),
    [locationTotal, setLocationTotal] = useState(0),
    [locationErrors, setLocationErrors] = useState<string[]>([]),
    [locationLabel, setLocationLabel] = useState("");
  const [intent, setIntent] = useState<MapCreationIntent | null>(null),
    [unknownIntent, setUnknownIntent] = useState(false);
  const alive = useRef(true),
    viewSequence = useRef(0),
    heading = useRef<HTMLHeadingElement>(null),
    objectHeading = useRef<HTMLHeadingElement>(null),
    commands = useRef<MapCanvasActions | null>(null);
  const intentKey = `zinovel.map-create.${book.id}`,
    key = (id: string) => `zinovel.map-draft.${book.id}.${id}`;
  state.current = editor;
  function patch(patch: Partial<Editor>, calculate = true) {
    const next = { ...state.current, ...patch };
    if (calculate)
      next.dirty =
        !!next.input &&
        (JSON.stringify(next.input) !== signature.current ||
          coordinateDirty(next) ||
          !!next.scaleRaw ||
          !!next.drawingId ||
          (!!next.record &&
            !!next.base &&
            !sameBase(next.base, referenceForMap(next.record))));
    state.current = next;
    if (alive.current) setEditor(next);
  }
  function changeMode(value: MapCanvasMode) {
    modeRef.current = value;
    setMode(value);
  }
  function collision() {
    patch({ locked: true });
    setError(
      "本机另有地图草稿已改变，原记录已保留。当前输入仍在窗口，可保存到作品，或明确放弃调整后重新读取。",
    );
  }
  function clearSlot() {
    const current = state.current;
    if (!current.record) return true;
    try {
      const raw = localStorage.getItem(key(current.record.id));
      if (
        !seen.current ||
        seen.current.id !== current.record.id ||
        raw !== seen.current.raw
      ) {
        collision();
        patch({ cleanup: false });
        return !state.current.dirty;
      }
      localStorage.removeItem(key(current.record.id));
      seen.current = { id: current.record.id, raw: null };
      patch({ cleanup: false });
      return true;
    } catch {
      patch({ cleanup: true });
      setError(
        "地图已在作品中保存，但本机草稿未能清理。请重试清理，避免重复保存。",
      );
      return false;
    }
  }
  function persist(closing = false) {
    const current = state.current;
    if (current.busy || (closing && (current.composing || current.dragging))) {
      if (closing)
        setError(
          current.dragging
            ? "请先结束地图拖动，再关闭地图。"
            : current.composing
              ? "请先完成当前中文输入，再关闭地图。"
              : "正在处理地图，请等待完成后再关闭。",
        );
      return false;
    }
    if (!current.record || !current.input || !current.base) return true;
    if (current.cleanup) return clearSlot();
    if (current.locked) return !current.dirty;
    if (!current.dirty) return seen.current?.raw !== null ? clearSlot() : true;
    try {
      const raw = localStorage.getItem(key(current.record.id));
      if (
        !seen.current ||
        seen.current.id !== current.record.id ||
        raw !== seen.current.raw
      ) {
        collision();
        return false;
      }
      const value = JSON.stringify({
        schemaVersion: 1,
        bookId: book.id,
        id: current.record.id,
        expected: current.base,
        input: current.input,
        selectedId: current.selectedId,
        coordinates: current.coordinates,
        scale: current.scaleRaw,
        drawingId: current.drawingId,
      });
      parseMapLocalDraft(value, book.id, current.record.id);
      localStorage.setItem(key(current.record.id), value);
      seen.current = { id: current.record.id, raw: value };
      return true;
    } catch {
      setError(
        "本机地图草稿暂不能保存，输入仍在窗口。可保存地图到作品，或明确放弃本机调整后关闭。",
      );
      return false;
    }
  }
  function load(next: MapRecord, restore = true) {
    const formal = fieldsForMap(next);
    signature.current = JSON.stringify(formal);
    let fresh: Editor = {
      ...emptyEditor(),
      record: next,
      base: referenceForMap(next),
      input: formal,
    };
    try {
      const raw = localStorage.getItem(key(next.id));
      seen.current = { id: next.id, raw };
      if (restore && raw !== null) {
        const draft = parseMapLocalDraft(raw, book.id, next.id);
        fresh = {
          ...fresh,
          base: draft.expected,
          input: draft.input,
          selectedId: draft.selectedId,
          coordinates: draft.coordinates,
          scaleRaw: draft.scale,
          drawingId: draft.drawingId,
        };
        setNotice("已恢复本机地图草稿，正式保存前请核对磁盘版本。");
      }
    } catch {
      fresh.locked = true;
      setError(
        "本机地图草稿无法识别或不能读取，已保留。可查看存档，明确放弃本机草稿后再编辑。",
      );
    }
    fresh.dirty =
      !!fresh.input &&
      (JSON.stringify(fresh.input) !== signature.current ||
        coordinateDirty(fresh) ||
        !!fresh.scaleRaw ||
        !!fresh.drawingId ||
        (!!fresh.record &&
          !!fresh.base &&
          !sameBase(fresh.base, referenceForMap(fresh.record))));
    state.current = fresh;
    setEditor(fresh);
    setHistorical(null);
    setComparison(null);
    setHistorySelected(null);
    setObjectQuery("");
    setObjectKind("");
    setObjectOffset(0);
    setObjectRecycled(false);
    setTab("objects");
    setCalibration([]);
    changeMode(fresh.drawingId ? "region" : "select");
    setRefresh((n) => n + 1);
  }
  function applySaved(next: MapRecord) {
    const old = state.current,
      input = fieldsForMap(next),
      selectedId = input.elements.some((e) => e.id === old.selectedId)
        ? old.selectedId
        : null,
      selected = input.elements.find((e) => e.id === selectedId);
    signature.current = JSON.stringify(input);
    patch({
      record: next,
      base: referenceForMap(next),
      input,
      selectedId,
      coordinates: selected
        ? { id: selected.id, value: mapCoordinateText(selected) }
        : null,
      scaleRaw: null,
      drawingId: null,
      past: [],
      future: [],
      locked: old.locked,
      cleanup: false,
    });
    changeMode("select");
    setHistorical(null);
    setComparison(null);
    setCalibration([]);
    setRefresh((value) => value + 1);
    setOffset(0);
    if (!old.locked) clearSlot();
  }
  function changeInput(
    input: MapInput,
    history = true,
    extra: Partial<Editor> = {},
  ) {
    const current = state.current;
    if (
      !current.input ||
      current.busy ||
      current.cleanup ||
      current.locked ||
      historical ||
      current.record?.deletedAt
    )
      return false;
    if (
      input.elements.length > mapLimits.elements ||
      input.elements.some(
        (e) =>
          (e.kind === "region" && e.points.length > mapLimits.vertices) ||
          (e.kind === "route" && e.via.length > mapLimits.vertices),
      )
    ) {
      setError("地图对象或顶点超过保护上限，请拆分为多张地图。");
      return false;
    }
    const changed = JSON.stringify(input) !== JSON.stringify(current.input);
    patch({
      input,
      ...extra,
      past:
        changed && history
          ? [...current.past, current.input].slice(-80)
          : current.past,
      future: changed && history ? [] : current.future,
    });
    setError("");
    setNotice("");
    return true;
  }
  function candidateCoordinates(current = state.current) {
    if (!current.input) throw Error("请先选择地图");
    return coordinateDirty(current)
      ? applyMapCoordinates(current.input, current.coordinates)
      : current.input;
  }
  function selectObject(id: string) {
    if (historical) {
      setHistorySelected(id);
      return true;
    }
    const current = state.current;
    if (current.busy || current.cleanup || (current.locked && current.dirty))
      return false;
    if (current.drawingId && current.drawingId !== id) {
      setError("请先结束或取消这次区域绘制。");
      return false;
    }
    try {
      const input = candidateCoordinates(),
        element = input.elements.find((e) => e.id === id);
      if (!element) return false;
      const changed = input !== current.input;
      patch({
        input,
        selectedId: id,
        coordinates: { id, value: mapCoordinateText(element) },
        past: changed
          ? [...current.past, current.input!].slice(-80)
          : current.past,
        future: changed ? [] : current.future,
      });
      setTab("objects");
      if (element.deletedAt) setObjectRecycled(true);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }
  function changeElement(element: MapElement) {
    const current = state.current;
    if (!current.input) return;
    changeInput({
      ...current.input,
      elements: current.input.elements.map((e) =>
        e.id === element.id ? element : e,
      ),
    });
  }
  function addElement(element: MapElement, drawing = false) {
    try {
      const input = candidateCoordinates();
      if (state.current.drawingId) throw Error("请先结束或取消当前区域绘制");
      if (
        changeInput(
          { ...input, elements: [...input.elements, element] },
          true,
          {
            selectedId: element.id,
            coordinates: { id: element.id, value: mapCoordinateText(element) },
            drawingId: drawing ? element.id : null,
          },
        )
      ) {
        setTab("objects");
        setObjectQuery("");
        setObjectKind("");
        setObjectRecycled(false);
        setObjectOffset(
          Math.floor(input.elements.filter((e) => !e.deletedAt).length / 40) *
            40,
        );
        changeMode(drawing ? "region" : "select");
      }
    } catch (e) {
      setError(message(e));
    }
  }
  function newPlace(point: MapPoint) {
    addElement({
      id: crypto.randomUUID(),
      kind: "place",
      title: "新地点",
      notes: "",
      locationId: null,
      point,
    });
  }
  function drawRegion() {
    addElement(
      {
        id: crypto.randomUUID(),
        kind: "region",
        title: "新区域",
        notes: "",
        locationId: null,
        points: [],
      },
      true,
    );
  }
  function newRoute() {
    const points =
      state.current.input?.elements.filter(
        (e) => e.kind === "place" && !e.deletedAt,
      ) || [];
    if (points.length < 2) {
      setError("请先创建两个地点，再建立路线。");
      return;
    }
    addElement({
      id: crypto.randomUUID(),
      kind: "route",
      title: "新路线",
      notes: "",
      fromId: points[0].id,
      toId: points[1].id,
      via: [],
      travelNotes: "",
    });
  }
  function pick(point: MapPoint) {
    const current = state.current;
    if (
      !current.input ||
      current.locked ||
      current.busy ||
      current.cleanup ||
      current.composing ||
      historical ||
      current.record?.deletedAt
    )
      return;
    if (modeRef.current === "place") {
      newPlace(point);
      return;
    }
    if (modeRef.current === "region" && current.drawingId) {
      try {
        const input = candidateCoordinates(),
          region = input.elements.find((e) => e.id === current.drawingId);
        if (!region || region.kind !== "region") return;
        const next = { ...region, points: [...region.points, point] },
          existing = !!current.record?.elements.some((e) => e.id === region.id);
        if (
          changeInput(
            {
              ...input,
              elements: input.elements.map((e) =>
                e.id === next.id ? next : e,
              ),
            },
            true,
            {
              coordinates: { id: next.id, value: mapCoordinateText(next) },
              drawingId: existing ? null : next.id,
            },
          ) &&
          existing
        )
          changeMode("select");
      } catch (e) {
        setError(message(e));
      }
    }
    if (modeRef.current === "calibrate") {
      const points =
          calibration.length >= 2 ? [point] : [...calibration, point],
        previous = current.scaleRaw ?? scaleFields(current.input);
      setCalibration(points);
      patch({
        scaleRaw: {
          ...previous,
          from: `${points[0].x * 100},${points[0].y * 100}`,
          to: points[1] ? `${points[1].x * 100},${points[1].y * 100}` : "",
        },
      });
      if (points.length === 2) changeMode("select");
    }
  }
  function move(id: string, point: MapPoint, vertex: number | null) {
    try {
      const input = candidateCoordinates(),
        element = input.elements.find((e) => e.id === id);
      if (!element || element.deletedAt) return;
      const changed: MapElement =
        element.kind === "place"
          ? { ...element, point }
          : element.kind === "region"
            ? {
                ...element,
                points: element.points.map((p, i) =>
                  i === vertex ? point : p,
                ),
              }
            : {
                ...element,
                via: element.via.map((p, i) => (i === vertex ? point : p)),
              };
      changeInput(
        {
          ...input,
          elements: input.elements.map((e) => (e.id === id ? changed : e)),
        },
        true,
        { coordinates: { id, value: mapCoordinateText(changed) } },
      );
    } catch (e) {
      setError(message(e));
    }
  }
  commands.current = {
    select: selectObject,
    pick,
    move,
    gesture: (active) => patch({ dragging: active }),
  };
  const canvasActions = useMemo<MapCanvasActions>(
    () => ({
      select: (id) => commands.current!.select(id),
      pick: (point) => commands.current!.pick(point),
      move: (id, point, vertex) => commands.current!.move(id, point, vertex),
      gesture: (active) => commands.current!.gesture(active),
    }),
    [],
  );
  function finishRegion() {
    try {
      const current = state.current,
        input = candidateCoordinates(),
        region = input.elements.find((e) => e.id === current.drawingId);
      if (!region || region.kind !== "region") return;
      mapPolygon(region.points);
      changeInput(input, true, {
        drawingId: null,
        coordinates: { id: region.id, value: mapCoordinateText(region) },
      });
      changeMode("select");
    } catch (e) {
      setError(message(e));
    }
  }
  function cancelRegion() {
    const current = state.current;
    if (!current.input || !current.drawingId) return;
    if (current.record?.elements.some((e) => e.id === current.drawingId))
      patch({ drawingId: null });
    else
      changeInput(
        {
          ...current.input,
          elements: current.input.elements.filter(
            (e) => e.id !== current.drawingId,
          ),
        },
        true,
        { drawingId: null, selectedId: null, coordinates: null },
      );
    changeMode("select");
  }
  function undo(redo = false) {
    const current = state.current;
    if (
      !current.input ||
      current.busy ||
      current.dragging ||
      current.locked ||
      current.cleanup ||
      historical
    )
      return;
    if (coordinateDirty(current) || current.scaleRaw) {
      setError("请先应用或放弃尚未完成的坐标、比例尺输入，再撤销地图调整。");
      return;
    }
    const source = redo ? current.future : current.past,
      input = source[source.length - 1];
    if (!input) return;
    const selectedId = input.elements.some((e) => e.id === current.selectedId)
        ? current.selectedId
        : null,
      selected = input.elements.find((e) => e.id === selectedId),
      drawingId = input.elements.some((e) => e.id === current.drawingId)
        ? current.drawingId
        : null;
    patch({
      input,
      selectedId,
      coordinates: selected
        ? { id: selected.id, value: mapCoordinateText(selected) }
        : null,
      drawingId,
      past: redo ? [...current.past, current.input] : current.past.slice(0, -1),
      future: redo
        ? current.future.slice(0, -1)
        : [...current.future, current.input],
    });
    if (!drawingId) changeMode("select");
  }
  async function save() {
    const current = state.current;
    if (
      !current.record ||
      !current.base ||
      !current.input ||
      current.busy ||
      current.cleanup ||
      current.dragging ||
      current.composing ||
      historical ||
      current.record.deletedAt
    )
      return;
    if (current.drawingId) {
      setError("请先结束区域绘制，再保存地图。");
      return;
    }
    try {
      const input = mapInput(
        applyMapScale(candidateCoordinates(current), current.scaleRaw),
      );
      if (!sameBase(current.base, referenceForMap(current.record)))
        throw Error("本机草稿基线已过期，请读取磁盘版本供对照后明确处理。");
      if (JSON.stringify(input) === signature.current) {
        patch({ coordinates: null, scaleRaw: null });
        clearSlot();
        setNotice("地图内容与存档一致，未创建重复修订。");
        return;
      }
      persist();
      patch({ busy: true });
      setError("");
      setNotice("");
      const token = viewSequence.current,
        next = await api<MapRecord>("maps.save", {
          bookId: book.id,
          input,
          expected: current.base,
        });
      if (alive.current && token === viewSequence.current) {
        applySaved(next);
        setNotice(
          "地图已保存。未保存调整的撤销已清空，已保存版本可从历史恢复。",
        );
      }
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  async function open(id: string) {
    if (!persist(true)) return;
    const token = ++viewSequence.current;
    patch({ busy: true });
    setError("");
    setNotice("");
    try {
      const next = await api<MapRecord>("maps.read", { bookId: book.id, id });
      if (alive.current && token === viewSequence.current) load(next);
    } catch (e) {
      if (alive.current && token === viewSequence.current) setError(message(e));
    } finally {
      if (alive.current && token === viewSequence.current)
        patch({ busy: false });
    }
  }
  async function continueCreation(value: MapCreationIntent, check = false) {
    if (!persist(true)) return;
    patch({ busy: true });
    setError("");
    setNotice("");
    try {
      let next = await api<MapRecord | null>("maps.creation", {
        bookId: book.id,
        id: value.id,
      });
      if (!next && !check)
        next = await api<MapRecord>("maps.create", {
          bookId: book.id,
          creationId: value.id,
          input: value.input,
        });
      if (!alive.current) return;
      if (!next) {
        setNotice("尚未找到这次创建的地图，可沿用同一身份继续创建。");
        return;
      }
      viewSequence.current++;
      load(next);
      try {
        localStorage.removeItem(intentKey);
        setIntent(null);
        setUnknownIntent(false);
      } catch {
        setError("地图已保存，待确认创建标记尚未清理，稍后可再次核对。");
      }
      setRefresh((n) => n + 1);
      setNotice("地图已在当前作品中保存；可继续手工编辑。");
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  async function create() {
    if (intent || unknownIntent || !persist(true)) return;
    const value: MapCreationIntent = {
      schemaVersion: 1,
      bookId: book.id,
      id: crypto.randomUUID(),
      input: blank(),
    };
    try {
      localStorage.setItem(intentKey, JSON.stringify(value));
      setIntent(value);
    } catch {
      setError("本机创建记录暂不能保存，未开始创建地图。");
      return;
    }
    await continueCreation(value);
  }
  async function discard() {
    const current = state.current;
    if (!current.record || current.busy) return;
    patch({ busy: true });
    try {
      const next = await api<MapRecord>("maps.read", {
        bookId: book.id,
        id: current.record.id,
      });
      if (!alive.current) return;
      localStorage.removeItem(key(current.record.id));
      load(next, false);
      setError("");
      setNotice("已明确放弃本机地图草稿，重新读取当前存档。");
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  async function disk() {
    const current = state.current;
    if (!current.record || current.busy) return;
    patch({ busy: true });
    try {
      const value = await api<MapRecord>("maps.read", {
        bookId: book.id,
        id: current.record.id,
      });
      if (alive.current) {
        setComparison(value);
        setNotice("磁盘版本仅供对照，当前调整尚未改变。");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  async function restoreMap() {
    const current = state.current;
    if (
      !current.record?.deletedAt ||
      current.busy ||
      current.composing ||
      current.dragging ||
      current.cleanup
    )
      return;
    persist();
    patch({ busy: true });
    setError("");
    try {
      const next = await api<MapRecord>("maps.delete", {
        bookId: book.id,
        expected: referenceForMap(current.record),
        deleted: false,
      });
      if (!alive.current) return;
      if (current.dirty) {
        signature.current = JSON.stringify(fieldsForMap(next));
        patch({ record: next });
        setNotice(
          "地图已恢复，本机输入仍保留；请对照恢复后的磁盘版本，再明确保存当前调整。",
        );
      } else {
        applySaved(next);
        setNotice("地图已恢复，原身份与历史保留。");
      }
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  async function mutate(action: string, payload: object) {
    const current = state.current;
    if (
      !current.record ||
      current.dirty ||
      current.busy ||
      current.cleanup ||
      current.locked ||
      current.composing ||
      !persist(true)
    )
      return;
    patch({ busy: true });
    setError("");
    setNotice("");
    try {
      const next = await api<MapRecord>(action, {
        bookId: book.id,
        expected: referenceForMap(current.record),
        ...payload,
      });
      if (alive.current) {
        applySaved(next);
        setNotice("地图新版本已保存，原版本仍在历史中。");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      patch({ busy: false });
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(intentKey);
      if (raw !== null) setIntent(parseMapCreationIntent(raw, book.id));
    } catch {
      setUnknownIntent(true);
      setError(
        "本机地图创建记录无法识别或不能读取，已保留。请先核对地图列表。",
      );
    }
    return () => {
      alive.current = false;
      viewSequence.current++;
    };
  }, [book.id]);
  useEffect(() => registerEditorCloseGuard(() => persist(true)), [book.id]);
  useEffect(() => {
    if (!editor.record || editor.busy || editor.locked || editor.cleanup)
      return;
    const timer = setTimeout(() => persist(), 160);
    return () => clearTimeout(timer);
  }, [
    editor.input,
    editor.coordinates,
    editor.scaleRaw,
    editor.selectedId,
    editor.drawingId,
    editor.dirty,
    editor.busy,
    editor.locked,
    editor.cleanup,
  ]);
  useEffect(() => {
    let current = true;
    api<{ items: MapSummary[]; total: number; errors: string[] }>("maps.list", {
      bookId: book.id,
      options: { query, deleted: recycled, offset },
    })
      .then((result) => {
        if (current && alive.current) {
          setItems(result.items);
          setTotal(result.total);
          setListErrors(result.errors);
        }
      })
      .catch((e) => {
        if (current && alive.current) setListErrors([message(e)]);
      });
    return () => {
      current = false;
    };
  }, [book.id, query, recycled, offset, refresh]);
  useEffect(() => {
    let current = true;
    setHistory([]);
    setHistoryErrors([]);
    if (!editor.record) return;
    api<{ items: MapRecord[]; errors: string[] }>("maps.history", {
      bookId: book.id,
      id: editor.record.id,
    })
      .then((result) => {
        if (current && alive.current) {
          setHistory(result.items);
          setHistoryErrors(result.errors);
        }
      })
      .catch((e) => {
        if (current && alive.current) setHistoryErrors([message(e)]);
      });
    return () => {
      current = false;
    };
  }, [editor.record?.id, editor.record?.diskHash, refresh]);
  const baseCurrent = editor.record
      ? sameBase(editor.base, referenceForMap(editor.record))
      : false,
    previewTarget = historical ?? (baseCurrent ? editor.record : null);
  useEffect(() => {
    let current = true;
    setPreview("");
    setPreviewError("");
    if (!previewTarget) {
      if (editor.record)
        setPreviewError(
          "草稿基线已过期，暂不借用磁盘新版底图，请读取版本供对照。",
        );
      return;
    }
    if (!previewTarget.background) return;
    api<{ dataUrl?: string }>("maps.preview", {
      bookId: book.id,
      expected: referenceForMap(previewTarget),
      historical: !!historical,
    })
      .then((result) => {
        if (current && alive.current) setPreview(result.dataUrl || "");
      })
      .catch((e) => {
        if (current && alive.current) setPreviewError(message(e));
      });
    return () => {
      current = false;
    };
  }, [
    book.id,
    previewTarget?.id,
    previewTarget?.diskHash,
    !!historical,
    refresh,
  ]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, [editor.record?.id, historical?.diskHash]);
  useEffect(() => {
    if (!assetsOpen) return;
    let current = true;
    api<{ items: AssetRecord[]; total: number; errors: string[] }>(
      "assets.list",
      { bookId: book.id, options: { query: assetQuery, offset: assetOffset } },
    )
      .then((result) => {
        if (current && alive.current) {
          setAssets(result.items);
          setAssetTotal(result.total);
          setAssetErrors(result.errors);
        }
      })
      .catch((e) => {
        if (current && alive.current) setAssetErrors([message(e)]);
      });
    return () => {
      current = false;
    };
  }, [book.id, assetsOpen, assetQuery, assetOffset, refresh]);
  const shown = historical ? fieldsForMap(historical) : editor.input,
    selectedId = historical ? historySelected : editor.selectedId,
    selected = shown?.elements.find((e) => e.id === selectedId);
  const locationId =
    selected && selected.kind !== "route" ? selected.locationId : null;
  useEffect(() => {
    let current = true;
    setLocationLabel("");
    if (!locationId) return;
    api<{ id: string; title: string; state: string }[]>("assets.link-options", {
      bookId: book.id,
      ids: [locationId],
    })
      .then((result) => {
        if (current && alive.current)
          setLocationLabel(
            result[0]?.title +
              (result[0]?.state === "deleted"
                ? "（已删除）"
                : result[0]?.state === "missing"
                  ? "（失联）"
                  : ""),
          );
      })
      .catch(() => {
        if (current && alive.current) setLocationLabel("关联地点暂不能读取");
      });
    return () => {
      current = false;
    };
  }, [book.id, locationId, refresh]);
  useEffect(() => {
    if (!locationsOpen) return;
    let current = true;
    api<{
      items: { id: string; title: string }[];
      total: number;
      errors: string[];
    }>("materials.list", {
      bookId: book.id,
      options: {
        kind: "location",
        query: locationQuery,
        offset: locationOffset,
      },
    })
      .then((result) => {
        if (current && alive.current) {
          setLocations(result.items);
          setLocationTotal(result.total);
          setLocationErrors(result.errors);
        }
      })
      .catch((e) => {
        if (current && alive.current) setLocationErrors([message(e)]);
      });
    return () => {
      current = false;
    };
  }, [book.id, locationsOpen, locationQuery, locationOffset, refresh]);
  const editable =
    !!editor.record &&
    !historical &&
    !editor.record.deletedAt &&
    !editor.busy &&
    !editor.locked &&
    !editor.cleanup;
  const filtered =
    shown?.elements.filter(
      (e) =>
        !!e.deletedAt === objectRecycled &&
        (!objectKind || e.kind === objectKind) &&
        (!objectQuery ||
          [e.title, e.notes]
            .join("\n")
            .toLocaleLowerCase()
            .includes(objectQuery.toLocaleLowerCase())),
    ) || [];
  const routeMetric = useMemo(() => {
    if (!shown || selected?.kind !== "route") return null;
    try {
      return mapRouteGeometry(shown, selected.id);
    } catch {
      return null;
    }
  }, [shown, selected?.id]);
  const scaleValue = editor.scaleRaw ?? scaleFields(editor.input),
    pendingCoordinates = coordinateDirty(editor);
  function applyCoordinates() {
    try {
      const input = candidateCoordinates();
      if (changeInput(input)) {
        const element = input.elements.find((e) => e.id === editor.selectedId);
        patch({
          coordinates: element
            ? { id: element.id, value: mapCoordinateText(element) }
            : null,
        });
      }
    } catch (e) {
      setError(message(e));
    }
  }
  function applyScale() {
    try {
      const input = applyMapScale(state.current.input!, state.current.scaleRaw);
      if (changeInput(input, true, { scaleRaw: null })) setCalibration([]);
    } catch (e) {
      setError(message(e));
    }
  }
  function retireElement(deleted: boolean) {
    if (!selected || historical || !editable) return;
    try {
      const input = candidateCoordinates(),
        element = input.elements.find((e) => e.id === selected.id)!;
      const next = { ...element };
      if (deleted) next.deletedAt = new Date().toISOString();
      else delete next.deletedAt;
      changeInput(
        {
          ...input,
          elements: input.elements.map((e) => (e.id === next.id ? next : e)),
        },
        true,
        { coordinates: { id: next.id, value: mapCoordinateText(next) } },
      );
      setObjectRecycled(deleted);
    } catch (e) {
      setError(message(e));
    }
  }
  const target = eventTargetEditable;
  return (
    <div className="modal-backdrop">
      <section
        className="assets-dialog maps-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="小说世界地图"
        onCompositionStart={() => patch({ composing: true })}
        onCompositionEnd={() => patch({ composing: false })}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "z" &&
            !target(event.target)
          ) {
            event.preventDefault();
            event.stopPropagation();
            undo(event.shiftKey);
          }
        }}
      >
        <header className="assets-header">
          <div>
            <h2>小说世界地图</h2>
            <p>
              手工组织地点、区域与路线。底图按选定版本冻结；作者比例尺不推断旅行时间或正文事实。
            </p>
          </div>
          <div className="map-header-actions">
            <button
              type="button"
              data-dialog-save
              className="primary"
              disabled={
                !editor.dirty ||
                editor.busy ||
                editor.dragging ||
                editor.cleanup ||
                editor.composing ||
                !!historical ||
                !!editor.record?.deletedAt
              }
              onClick={save}
            >
              保存地图
            </button>
            <button
              type="button"
              onClick={() => {
                if (persist(true)) onClose();
              }}
            >
              关闭地图
            </button>
            <button
              type="button"
              disabled={editor.busy}
              onClick={() => {
                setRefresh((n) => n + 1);
                setNotice("重新核对列表、历史和底图，当前输入保留。");
              }}
            >
              重新核对地图
            </button>
          </div>
        </header>
        <div className="assets-notices maps-notices">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {editor.busy && <p role="status">正在处理地图…</p>}
          {editor.cleanup && (
            <button type="button" onClick={clearSlot}>
              重试清理地图草稿
            </button>
          )}
          {(intent || unknownIntent) && (
            <div className="asset-pending">
              <p>
                有一项待确认地图创建。先核对已保存记录，继续时沿用同一身份；放弃标记不会删除已经保存的地图。
              </p>
              {intent && (
                <>
                  <button
                    type="button"
                    disabled={editor.busy}
                    onClick={() => continueCreation(intent, true)}
                  >
                    检查这次地图创建
                  </button>
                  <button
                    type="button"
                    disabled={editor.busy}
                    onClick={() => continueCreation(intent)}
                  >
                    继续这次地图创建
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={editor.busy}
                onClick={() => {
                  try {
                    localStorage.removeItem(intentKey);
                    setIntent(null);
                    setUnknownIntent(false);
                    setError("");
                  } catch {
                    setError("待确认标记仍不能清理，已保留。");
                  }
                }}
              >
                放弃待确认地图标记
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="map-catalog-toggle"
          aria-expanded={catalogExpanded}
          aria-controls="world-map-catalog"
          onClick={() => setCatalogExpanded(!catalogExpanded)}
        >
          {catalogExpanded ? "收起地图与对象目录" : "展开地图与对象目录"}
        </button>
        <div
          className={`assets-layout maps-layout${catalogExpanded ? " map-catalog-expanded" : ""}`}
        >
          <aside
            id="world-map-catalog"
            className="assets-catalog map-catalog"
            aria-label="地图与对象目录"
          >
            <div className="map-tabs">
              <button
                aria-pressed={tab === "maps"}
                onClick={() => setTab("maps")}
              >
                地图目录
              </button>
              <button
                aria-pressed={tab === "objects"}
                disabled={!shown}
                onClick={() => setTab("objects")}
              >
                地图对象
              </button>
            </div>
            {tab === "maps" ? (
              <>
                <button
                  type="button"
                  disabled={
                    editor.busy || editor.composing || !!intent || unknownIntent
                  }
                  onClick={create}
                >
                  新建地图
                </button>
                <label>
                  搜索地图
                  <input
                    value={query}
                    maxLength={200}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label className="asset-checkbox">
                  <input
                    type="checkbox"
                    checked={recycled}
                    onChange={(e) => {
                      setRecycled(e.target.checked);
                      setOffset(0);
                    }}
                  />
                  地图回收站
                </label>
                <p>{total} 份可读取地图</p>
                {listErrors.map((text, i) => (
                  <p role="alert" key={i}>
                    {text}
                  </p>
                ))}
                <div className="asset-list">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={item.id === editor.record?.id}
                      disabled={editor.busy}
                      onClick={() => open(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>
                        {item.era || "未标注年代"} · 地点{item.places} / 区域
                        {item.regions} / 路线{item.routes}
                      </span>
                    </button>
                  ))}
                </div>
                <nav>
                  <button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 40))}
                  >
                    上一页地图
                  </button>
                  <button
                    disabled={offset + 40 >= total}
                    onClick={() => setOffset(offset + 40)}
                  >
                    下一页地图
                  </button>
                </nav>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={editor.busy}
                  onClick={() => setTab("maps")}
                >
                  返回地图目录
                </button>
                <label>
                  搜索地图对象
                  <input
                    value={objectQuery}
                    maxLength={200}
                    onChange={(e) => {
                      setObjectQuery(e.target.value);
                      setObjectOffset(0);
                    }}
                  />
                </label>
                <label>
                  对象类型
                  <select
                    value={objectKind}
                    onChange={(e) => {
                      setObjectKind(e.target.value);
                      setObjectOffset(0);
                    }}
                  >
                    <option value="">全部对象</option>
                    <option value="place">地点</option>
                    <option value="region">区域</option>
                    <option value="route">路线</option>
                  </select>
                </label>
                <label className="asset-checkbox">
                  <input
                    type="checkbox"
                    checked={objectRecycled}
                    onChange={(e) => {
                      setObjectRecycled(e.target.checked);
                      setObjectOffset(0);
                    }}
                  />
                  已回收对象
                </label>
                <p>{filtered.length} 个对象 · 每页40个</p>
                <div className="asset-list">
                  {filtered
                    .slice(objectOffset, objectOffset + 40)
                    .map((element) => (
                      <button
                        key={element.id}
                        type="button"
                        aria-pressed={selectedId === element.id}
                        disabled={editor.busy}
                        onClick={() => selectObject(element.id)}
                      >
                        <strong>{element.title || "未命名"}</strong>
                        <span>{kinds[element.kind]}</span>
                      </button>
                    ))}
                </div>
                <nav>
                  <button
                    disabled={objectOffset === 0}
                    onClick={() =>
                      setObjectOffset(Math.max(0, objectOffset - 40))
                    }
                  >
                    上一页对象
                  </button>
                  <button
                    disabled={objectOffset + 40 >= filtered.length}
                    onClick={() => setObjectOffset(objectOffset + 40)}
                  >
                    下一页对象
                  </button>
                </nav>
              </>
            )}
          </aside>
          <main className="asset-detail map-detail">
            {!editor.record || !editor.input || !shown ? (
              <div className="map-empty">
                <h3>先创建一张世界地图</h3>
                <p>
                  没有底图也可以手工添加地点、区域和路线；坐标、关联与版本跟随作品保存。
                </p>
                <button
                  type="button"
                  disabled={editor.busy || !!intent || unknownIntent}
                  onClick={create}
                >
                  新建空白地图
                </button>
              </div>
            ) : (
              <>
                <h3 ref={heading} tabIndex={-1}>
                  {historical
                    ? `历史地图 · 第${historical.revision}版`
                    : editor.input.title || "未命名地图"}
                </h3>
                {historical && (
                  <div className="map-warning">
                    <p>历史仅供查看，不会改写当前地图。</p>
                    <button
                      onClick={() => {
                        setHistorical(null);
                        setHistorySelected(null);
                      }}
                    >
                      返回当前地图
                    </button>
                    <button
                      disabled={
                        editor.busy ||
                        editor.dirty ||
                        !!editor.record.deletedAt ||
                        editor.locked ||
                        editor.cleanup
                      }
                      onClick={() =>
                        mutate("maps.restore-version", {
                          historical: referenceForMap(historical),
                        })
                      }
                    >
                      采用此历史地图为新版本
                    </button>
                  </div>
                )}
                {editor.record.deletedAt && (
                  <div className="map-warning">
                    <p>当前地图已回收，原坐标和历史仍保留。</p>
                    <button
                      disabled={
                        editor.busy ||
                        editor.composing ||
                        editor.dragging ||
                        editor.cleanup
                      }
                      onClick={restoreMap}
                    >
                      恢复这张地图
                    </button>
                  </div>
                )}
                {!historical && (
                  <details className="map-metadata">
                    <summary>
                      地图信息 · 第{editor.record.revision}版
                      {editor.dirty ? " · 未保存调整" : " · 已保存"}
                    </summary>
                    <label>
                      地图标题
                      <input
                        aria-label="地图标题"
                        disabled={!editable}
                        maxLength={200}
                        value={editor.input.title}
                        onChange={(e) =>
                          changeInput({
                            ...editor.input!,
                            title: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      地图年代标签
                      <input
                        disabled={!editable}
                        maxLength={200}
                        value={editor.input.era}
                        onChange={(e) =>
                          changeInput({ ...editor.input!, era: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      地图说明
                      <textarea
                        disabled={!editable}
                        maxLength={16000}
                        value={editor.input.notes}
                        onChange={(e) =>
                          changeInput({
                            ...editor.input!,
                            notes: e.target.value,
                          })
                        }
                      />
                    </label>
                    <p>年代标签由作者填写，程序不自动推演故事时间。</p>
                  </details>
                )}
                <div className="map-edit-tools">
                  <button
                    aria-pressed={mode === "select"}
                    onClick={() => changeMode("select")}
                  >
                    选择 / 移动
                  </button>
                  <button
                    disabled={
                      !editable || editor.composing || !!editor.drawingId
                    }
                    aria-pressed={mode === "place"}
                    onClick={() => changeMode("place")}
                  >
                    图上添加地点
                  </button>
                  <button
                    disabled={
                      !editable || editor.composing || !!editor.drawingId
                    }
                    onClick={() => newPlace({ x: 0.5, y: 0.5 })}
                  >
                    表单添加地点
                  </button>
                  <button
                    disabled={
                      !editable || editor.composing || !!editor.drawingId
                    }
                    onClick={drawRegion}
                  >
                    绘制区域
                  </button>
                  <button
                    disabled={
                      !editable || editor.composing || !!editor.drawingId
                    }
                    onClick={newRoute}
                  >
                    新建路线
                  </button>
                  <button
                    aria-pressed={mode === "pan"}
                    onClick={() => changeMode("pan")}
                  >
                    平移视图
                  </button>
                  <button
                    disabled={
                      !editable ||
                      !editor.past.length ||
                      pendingCoordinates ||
                      !!editor.scaleRaw
                    }
                    onClick={() => undo()}
                  >
                    撤销未保存调整
                  </button>
                  <button
                    disabled={
                      !editable ||
                      !editor.future.length ||
                      pendingCoordinates ||
                      !!editor.scaleRaw
                    }
                    onClick={() => undo(true)}
                  >
                    重做未保存调整
                  </button>
                </div>
                {editor.drawingId && (
                  <p className="map-warning">
                    点击画布添加区域顶点。
                    <button
                      aria-pressed={mode === "region"}
                      onClick={() => changeMode("region")}
                    >
                      继续添加区域顶点
                    </button>
                    <button onClick={finishRegion}>结束区域绘制</button>
                    <button onClick={cancelRegion}>取消这次区域绘制</button>
                  </p>
                )}
                {mode === "place" && (
                  <p className="map-warning">
                    下一次点击地图将添加一个新地点，之后可填写名称与坐标。
                  </p>
                )}
                {mode === "calibrate" && (
                  <p className="map-warning">
                    依次点击两个比例尺参考点，再填写距离与单位。
                  </p>
                )}
                {previewError && (
                  <p role="alert" className="map-preview-error">
                    {previewError}
                  </p>
                )}
                <div className="map-edit-grid">
                  <MapCanvas
                    key={editor.record.id}
                    elements={shown.elements}
                    canvas={shown.canvas}
                    scale={shown.scale}
                    background={preview}
                    selectedId={selectedId}
                    drawingId={historical ? null : editor.drawingId}
                    mode={
                      historical ? (mode === "pan" ? "pan" : "select") : mode
                    }
                    readOnly={!editable || editor.composing}
                    calibration={historical ? [] : calibration}
                    actions={canvasActions}
                  />
                  <section
                    className="map-object-form"
                    aria-label="地图对象编辑"
                  >
                    <h4 ref={objectHeading} tabIndex={-1}>
                      选中对象
                    </h4>
                    {!selected ? (
                      <p>在图上或对象列表选择一个对象，或先添加地点。</p>
                    ) : (
                      <>
                        <p>
                          {kinds[selected.kind]}
                          {selected.deletedAt ? " · 已回收" : ""}
                        </p>
                        <label>
                          对象名称
                          <input
                            aria-label="地图对象名称"
                            disabled={!editable || !!selected.deletedAt}
                            value={selected.title}
                            maxLength={200}
                            onChange={(e) =>
                              changeElement({
                                ...selected,
                                title: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          对象说明
                          <textarea
                            disabled={!editable || !!selected.deletedAt}
                            maxLength={8000}
                            value={selected.notes}
                            onChange={(e) =>
                              changeElement({
                                ...selected,
                                notes: e.target.value,
                              })
                            }
                          />
                        </label>
                        {selected.kind === "route" && (
                          <>
                            <label>
                              路线起点
                              <select
                                aria-label="路线起点"
                                disabled={!editable || !!selected.deletedAt}
                                value={selected.fromId}
                                onChange={(e) =>
                                  changeElement({
                                    ...selected,
                                    fromId: e.target.value,
                                  })
                                }
                              >
                                {!shown.elements.some(
                                  (e) =>
                                    e.id === selected.fromId &&
                                    e.kind === "place" &&
                                    !e.deletedAt,
                                ) && (
                                  <option value={selected.fromId} disabled>
                                    原端点已回收或失联
                                  </option>
                                )}
                                {shown.elements
                                  .filter(
                                    (e) => e.kind === "place" && !e.deletedAt,
                                  )
                                  .map((e) => (
                                    <option value={e.id} key={e.id}>
                                      {e.title || "未命名"}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <label>
                              路线终点
                              <select
                                aria-label="路线终点"
                                disabled={!editable || !!selected.deletedAt}
                                value={selected.toId}
                                onChange={(e) =>
                                  changeElement({
                                    ...selected,
                                    toId: e.target.value,
                                  })
                                }
                              >
                                {!shown.elements.some(
                                  (e) =>
                                    e.id === selected.toId &&
                                    e.kind === "place" &&
                                    !e.deletedAt,
                                ) && (
                                  <option value={selected.toId} disabled>
                                    原端点已回收或失联
                                  </option>
                                )}
                                {shown.elements
                                  .filter(
                                    (e) => e.kind === "place" && !e.deletedAt,
                                  )
                                  .map((e) => (
                                    <option value={e.id} key={e.id}>
                                      {e.title || "未命名"}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <label>
                              路线行程说明
                              <textarea
                                disabled={!editable || !!selected.deletedAt}
                                maxLength={4000}
                                value={selected.travelNotes}
                                onChange={(e) =>
                                  changeElement({
                                    ...selected,
                                    travelNotes: e.target.value,
                                  })
                                }
                              />
                            </label>
                            <p>
                              {routeMetric?.state === "missing-endpoint"
                                ? "端点失联，请明确重新指定。"
                                : routeMetric?.state === "author-scaled"
                                  ? `约${routeMetric.distance!.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${routeMetric.unit}（按作者比例尺）`
                                  : "尚无有效作者比例尺，不推断距离或时间。"}
                            </p>
                          </>
                        )}
                        <label>
                          {selected.kind === "route"
                            ? "路线折点坐标"
                            : "对象坐标"}
                          <textarea
                            aria-label="地图对象坐标"
                            disabled={!editable || !!selected.deletedAt}
                            value={
                              historical
                                ? mapCoordinateText(selected)
                                : editor.coordinates?.id === selected.id
                                  ? editor.coordinates.value
                                  : mapCoordinateText(selected)
                            }
                            onChange={(e) =>
                              patch({
                                coordinates: {
                                  id: selected.id,
                                  value: e.target.value,
                                },
                              })
                            }
                          />
                        </label>
                        <p>
                          每行 x,y
                          百分比，范围0至100，不写百分号。地点只填一行；区域不重复首点；路线折点可为空。
                        </p>
                        <div className="map-inline-actions">
                          <button
                            disabled={
                              !editable ||
                              !!selected.deletedAt ||
                              !pendingCoordinates
                            }
                            onClick={applyCoordinates}
                          >
                            应用对象坐标
                          </button>
                          <button
                            disabled={!editable || !pendingCoordinates}
                            onClick={() =>
                              patch({
                                coordinates: {
                                  id: selected.id,
                                  value: mapCoordinateText(selected),
                                },
                              })
                            }
                          >
                            放弃坐标输入
                          </button>
                        </div>
                        {selected.kind === "region" &&
                          !historical &&
                          !editor.record.elements.some(
                            (e) => e.id === selected.id,
                          ) &&
                          !editor.drawingId && (
                            <button
                              disabled={!editable}
                              onClick={() => {
                                patch({ drawingId: selected.id });
                                changeMode("region");
                              }}
                            >
                              继续绘制未保存区域
                            </button>
                          )}
                        {selected.kind !== "route" && (
                          <>
                            <p>
                              当前关联地点：
                              {locationId
                                ? locationLabel || "正在读取名称…"
                                : "未关联"}
                            </p>
                            {locationId && (
                              <>
                                <button
                                  disabled={editor.busy}
                                  onClick={() => {
                                    if (persist(true))
                                      onEditLocation(locationId);
                                  }}
                                >
                                  打开当前地点资料
                                </button>
                                <button
                                  disabled={!editable || !!selected.deletedAt}
                                  onClick={() =>
                                    changeElement({
                                      ...selected,
                                      locationId: null,
                                    })
                                  }
                                >
                                  清除地点关联
                                </button>
                              </>
                            )}
                            <details
                              onToggle={(e) =>
                                setLocationsOpen(e.currentTarget.open)
                              }
                            >
                              <summary>关联本书地点资料</summary>
                              <label>
                                查找地点资料
                                <input
                                  disabled={!editable || !!selected.deletedAt}
                                  value={locationQuery}
                                  maxLength={200}
                                  onChange={(e) => {
                                    setLocationQuery(e.target.value);
                                    setLocationOffset(0);
                                  }}
                                />
                              </label>
                              {locationErrors.map((text, i) => (
                                <p role="alert" key={i}>
                                  {text}
                                </p>
                              ))}
                              <div className="map-choice-list">
                                {locations.map((location) => (
                                  <button
                                    key={location.id}
                                    disabled={!editable || !!selected.deletedAt}
                                    onClick={() =>
                                      changeElement({
                                        ...selected,
                                        locationId: location.id,
                                      })
                                    }
                                  >
                                    {location.title}
                                  </button>
                                ))}
                              </div>
                              <nav>
                                <button
                                  disabled={locationOffset === 0}
                                  onClick={() =>
                                    setLocationOffset(
                                      Math.max(0, locationOffset - 40),
                                    )
                                  }
                                >
                                  上一页地点资料
                                </button>
                                <button
                                  disabled={
                                    locationOffset + 40 >= locationTotal
                                  }
                                  onClick={() =>
                                    setLocationOffset(locationOffset + 40)
                                  }
                                >
                                  下一页地点资料
                                </button>
                              </nav>
                            </details>
                          </>
                        )}
                        {!historical && (
                          <button
                            disabled={!editable}
                            onClick={() => retireElement(!selected.deletedAt)}
                          >
                            {selected.deletedAt
                              ? "恢复这个地图对象"
                              : "回收这个地图对象"}
                          </button>
                        )}
                      </>
                    )}
                  </section>
                </div>
                {!historical && (
                  <details className="map-scale">
                    <summary>
                      作者比例尺
                      {editor.input.scale
                        ? ` · ${editor.input.scale.unit}`
                        : " · 未设置"}
                    </summary>
                    <p>
                      只按平面参考点换算距离，不自动计算行程。保存地图时会一并应用完整比例尺输入。
                    </p>
                    <button
                      disabled={
                        !editable || !!editor.drawingId || editor.composing
                      }
                      onClick={() => {
                        setCalibration([]);
                        changeMode("calibrate");
                      }}
                    >
                      从画布选择两个参考点
                    </button>
                    {(
                      [
                        ["from", "比例尺起点"],
                        ["to", "比例尺终点"],
                        ["distance", "比例尺距离"],
                        ["unit", "比例尺单位"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field}>
                        {label}
                        <input
                          aria-label={label}
                          disabled={!editable}
                          value={scaleValue[field]}
                          maxLength={field === "unit" ? 200 : 128}
                          onChange={(e) =>
                            patch({
                              scaleRaw: {
                                ...scaleValue,
                                [field]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    <div className="map-inline-actions">
                      <button
                        disabled={!editable || !editor.scaleRaw}
                        onClick={applyScale}
                      >
                        应用作者比例尺
                      </button>
                      <button
                        disabled={!editable || !editor.scaleRaw}
                        onClick={() => {
                          patch({ scaleRaw: null });
                          setCalibration([]);
                          changeMode("select");
                        }}
                      >
                        放弃比例尺输入
                      </button>
                      <button
                        disabled={!editable || !editor.input.scale}
                        onClick={() => {
                          changeInput({ ...editor.input!, scale: null }, true, {
                            scaleRaw: null,
                          });
                          setCalibration([]);
                        }}
                      >
                        清除作者比例尺
                      </button>
                    </div>
                  </details>
                )}
                <details onToggle={(e) => setAssetsOpen(e.currentTarget.open)}>
                  <summary>
                    冻结地图底图
                    {previewTarget?.background
                      ? ` · ${previewTarget.background.record.title}`
                      : " · 无底图或待核对"}
                  </summary>
                  <p>
                    后续在图像资源里替换或回收原图，不会改变已选底图。换成不同原图会清除旧比例尺，归一化坐标保留，请重新核对；先保存当前地图调整再选底图。
                  </p>
                  <button
                    disabled={editor.busy}
                    onClick={() => {
                      if (persist(true)) onAssets();
                    }}
                  >
                    打开图像资源导入原图
                  </button>
                  {editor.record.background && (
                    <button
                      disabled={!editable || editor.dirty}
                      onClick={() => mutate("maps.clear-background", {})}
                    >
                      移除当前底图
                    </button>
                  )}
                  <label>
                    查找底图资源
                    <input
                      value={assetQuery}
                      maxLength={200}
                      onChange={(e) => {
                        setAssetQuery(e.target.value);
                        setAssetOffset(0);
                      }}
                    />
                  </label>
                  {assetErrors.map((text, i) => (
                    <p role="alert" key={i}>
                      {text}
                    </p>
                  ))}
                  <div className="map-choice-list">
                    {assets.map((asset) => (
                      <button
                        key={asset.id}
                        disabled={!editable || editor.dirty}
                        onClick={() =>
                          mutate("maps.set-background", {
                            asset: referenceForMap(asset),
                          })
                        }
                      >
                        {asset.title} · {asset.blob.displayWidth}×
                        {asset.blob.displayHeight}
                      </button>
                    ))}
                  </div>
                  <nav>
                    <button
                      disabled={assetOffset === 0}
                      onClick={() =>
                        setAssetOffset(Math.max(0, assetOffset - 40))
                      }
                    >
                      上一页底图资源
                    </button>
                    <button
                      disabled={assetOffset + 40 >= assetTotal}
                      onClick={() => setAssetOffset(assetOffset + 40)}
                    >
                      下一页底图资源
                    </button>
                  </nav>
                </details>
                {!historical && (
                  <div className="asset-actions">
                    <button disabled={editor.busy} onClick={disk}>
                      读取磁盘地图供对照
                    </button>
                    <button disabled={editor.busy} onClick={discard}>
                      放弃本机地图草稿并重读
                    </button>
                    <button
                      disabled={!editable || editor.dirty}
                      onClick={() => mutate("maps.delete", { deleted: true })}
                    >
                      回收这张地图
                    </button>
                  </div>
                )}
                {comparison && (
                  <details open>
                    <summary>
                      磁盘地图供对照 · 第{comparison.revision}版
                    </summary>
                    <p>
                      沿用磁盘版本的底图与存档身份，保留当前文字和坐标调整；仍需明确保存。画布尺寸不一致时先核对底图。
                    </p>
                    <pre>
                      {JSON.stringify(fieldsForMap(comparison), null, 2)}
                    </pre>
                    <button
                      disabled={editor.busy || editor.locked || editor.cleanup}
                      onClick={() => {
                        signature.current = JSON.stringify(
                          fieldsForMap(comparison),
                        );
                        patch({
                          record: comparison,
                          base: referenceForMap(comparison),
                        });
                        setComparison(null);
                        setError("");
                        setNotice(
                          "已明确采用磁盘基线并保留当前调整，尚未保存。",
                        );
                      }}
                    >
                      保留调整并采用磁盘地图基线
                    </button>
                  </details>
                )}
                <details className="map-history">
                  <summary>地图历史 · 最近40版</summary>
                  <p>
                    查看历史不会修改当前地图；采用历史会创建一个新版本，后续版本仍保留。
                  </p>
                  {historyErrors.map((text, i) => (
                    <p role="alert" key={i}>
                      {text}
                    </p>
                  ))}
                  {history.map((item) => (
                    <button
                      key={item.diskHash}
                      disabled={
                        editor.busy ||
                        editor.dirty ||
                        editor.cleanup ||
                        editor.locked
                      }
                      onClick={() => {
                        setHistorical(item);
                        setHistorySelected(null);
                        setCalibration([]);
                        changeMode("select");
                      }}
                    >{`查看地图第${item.revision}版 · ${item.title}`}</button>
                  ))}
                  {!history.length && !historyErrors.length && (
                    <p>暂无已保存的历史版本。</p>
                  )}
                </details>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
function eventTargetEditable(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, select, [contenteditable='true']")
  );
}
