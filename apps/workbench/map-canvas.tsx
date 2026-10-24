import React, {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  mapRouteGeometries,
  type MapInput,
  type MapPoint,
  type MapPlace,
} from "../../packages/novel-domain/maps.mjs";

export type MapCanvasMode = "select" | "place" | "region" | "pan" | "calibrate";
export interface MapCanvasActions {
  select: (id: string) => boolean;
  pick: (point: MapPoint) => void;
  move: (id: string, point: MapPoint, vertex: number | null) => void;
  gesture: (active: boolean) => void;
}
interface Props {
  elements: MapInput["elements"];
  canvas: MapInput["canvas"];
  scale: MapInput["scale"];
  background: string;
  selectedId: string | null;
  drawingId: string | null;
  mode: MapCanvasMode;
  readOnly: boolean;
  calibration: MapPoint[];
  actions: MapCanvasActions;
}
interface Drag {
  id: string;
  vertex: number | null;
  point: MapPoint;
  start: MapPoint;
  origin: MapPoint;
  moved: boolean;
  pointer: number;
}
export const MapCanvas = memo(function MapCanvas({
  elements,
  canvas,
  scale,
  background,
  selectedId,
  drawingId,
  mode,
  readOnly,
  calibration,
  actions,
}: Props) {
  const svg = useRef<SVGSVGElement>(null),
    world = useRef<SVGGElement>(null),
    drag = useRef<Drag | null>(null),
    panDrag = useRef<{
      pointer: number;
      x: number;
      y: number;
      startX: number;
      startY: number;
    } | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 }),
    [extent, setExtent] = useState({ width: 800, height: 480 }),
    [ghost, setGhost] = useState<Drag | null>(null);
  const seed = useId().replace(/[^a-zA-Z0-9_-]/g, ""),
    gridId = "map-grid-" + seed,
    arrowId = "map-arrow-" + seed,
    hintId = "map-hint-" + seed;
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0)
        setExtent((old) =>
          old.width === box.width && old.height === box.height
            ? old
            : { width: box.width, height: box.height },
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setView({ zoom: 1, x: 0, y: 0 });
    drag.current = null;
    panDrag.current = null;
    setGhost(null);
  }, [canvas.width, canvas.height]);
  const routes = useMemo(
    () =>
      mapRouteGeometries({
        title: "",
        notes: "",
        era: "",
        canvas,
        scale,
        elements,
      }),
    [elements, canvas, scale],
  );
  const places = useMemo(
    () =>
      elements.filter((e): e is MapPlace => e.kind === "place" && !e.deletedAt),
    [elements],
  );
  const selected = elements.find((e) => e.id === selectedId),
    construction = elements.find(
      (e) => e.id === drawingId && e.kind === "region",
    ),
    unavailable = routes.filter((r) => r.state === "missing-endpoint").length;
  const baseScale = Math.max(
      0.00001,
      Math.min(extent.width / canvas.width, extent.height / canvas.height),
    ),
    unit = 1 / baseScale / view.zoom;
  const pairs = (points: MapPoint[]) =>
    points.map((p) => `${p.x * canvas.width},${p.y * canvas.height}`).join(" ");
  function rootPoint(event: React.PointerEvent<SVGElement>) {
    const element = svg.current,
      matrix = element?.getScreenCTM();
    if (!element || !matrix) return null;
    const point = element.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  }
  function worldPoint(
    event: React.PointerEvent<SVGElement>,
    allowOutside = false,
  ): MapPoint | null {
    const element = svg.current,
      matrix = world.current?.getScreenCTM();
    if (!element || !matrix) return null;
    const point = element.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const value = point.matrixTransform(matrix.inverse()),
      x = value.x / canvas.width,
      y = value.y / canvas.height;
    if (!allowOutside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x, y };
  }
  function startObject(
    event: React.PointerEvent<SVGElement>,
    id: string,
    vertex: number | null = null,
  ) {
    if (
      mode !== "select" ||
      event.button !== 0 ||
      event.altKey ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!actions.select(id) || readOnly) return;
    const element = elements.find((item) => item.id === id),
      point = worldPoint(event, true);
    if (
      !element ||
      !point ||
      element.deletedAt ||
      (element.kind !== "place" && vertex === null)
    )
      return;
    const origin =
      element.kind === "place"
        ? element.point
        : element.kind === "region"
          ? element.points[vertex!]
          : element.via[vertex!];
    if (!origin) return;
    drag.current = {
      id,
      vertex,
      start: point,
      origin,
      point: origin,
      moved: false,
      pointer: event.pointerId,
    };
    actions.gesture(true);
    svg.current?.setPointerCapture(event.pointerId);
    svg.current?.focus();
  }
  function start(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    if (
      mode === "pan" ||
      event.altKey ||
      (event.shiftKey && mode === "select")
    ) {
      const p = rootPoint(event);
      if (p) {
        panDrag.current = {
          pointer: event.pointerId,
          x: view.x,
          y: view.y,
          startX: p.x,
          startY: p.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
      return;
    }
    if (!readOnly && ["place", "region", "calibrate"].includes(mode)) {
      const p = worldPoint(event);
      if (p) {
        event.preventDefault();
        actions.pick(p);
      }
    }
  }
  function move(event: React.PointerEvent<SVGSVGElement>) {
    if (panDrag.current?.pointer === event.pointerId) {
      const p = rootPoint(event),
        start = panDrag.current;
      if (p)
        setView((old) => ({
          ...old,
          x: Math.max(
            -4 * canvas.width,
            Math.min(4 * canvas.width, start.x + p.x - start.startX),
          ),
          y: Math.max(
            -4 * canvas.height,
            Math.min(4 * canvas.height, start.y + p.y - start.startY),
          ),
        }));
      return;
    }
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId || readOnly) return;
    const p = worldPoint(event, true);
    if (p) {
      current.point = {
        x: Math.max(0, Math.min(1, current.origin.x + p.x - current.start.x)),
        y: Math.max(0, Math.min(1, current.origin.y + p.y - current.start.y)),
      };
      current.moved ||=
        Math.abs(p.x - current.start.x) + Math.abs(p.y - current.start.y) >
        1e-7;
      setGhost({ ...current });
    }
  }
  function end(event: React.PointerEvent<SVGSVGElement>, cancel = false) {
    const current = drag.current;
    if (current && current.pointer !== event.pointerId) return;
    drag.current = null;
    panDrag.current = null;
    setGhost(null);
    actions.gesture(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && current?.moved && !readOnly)
      actions.move(current.id, current.point, current.vertex);
  }
  function keys(event: React.KeyboardEvent<SVGSVGElement>) {
    if (["+", "=", "-"].includes(event.key)) {
      event.preventDefault();
      setView((old) => ({
        ...old,
        zoom: Math.max(
          1,
          Math.min(4, old.zoom + (event.key === "-" ? -0.25 : 0.25)),
        ),
      }));
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (!delta[event.key]) return;
    event.preventDefault();
    event.stopPropagation();
    const [x, y] = delta[event.key];
    if (
      !readOnly &&
      mode === "select" &&
      selected?.kind === "place" &&
      !selected.deletedAt &&
      event.target instanceof Element &&
      event.target.closest("[data-map-element]")
    ) {
      const step = event.shiftKey ? 0.001 : 0.01;
      actions.move(
        selected.id,
        {
          x: Math.max(0, Math.min(1, selected.point.x + x * step)),
          y: Math.max(0, Math.min(1, selected.point.y + y * step)),
        },
        null,
      );
    } else
      setView((old) => ({
        ...old,
        x: old.x - (x * canvas.width) / 20,
        y: old.y - (y * canvas.height) / 20,
      }));
  }
  function objectKeys(event: React.KeyboardEvent<SVGElement>, id: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      actions.select(id);
    }
  }
  return (
    <section className="map-stage" aria-label="地图画布与视图">
      <div className="map-view-tools">
        <label>
          缩放
          <input
            aria-label="地图缩放"
            type="range"
            min="1"
            max="4"
            step="0.25"
            value={view.zoom}
            onChange={(e) =>
              setView((old) => ({ ...old, zoom: Number(e.target.value) }))
            }
          />
        </label>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
          适合地图
        </button>
      </div>
      <svg
        ref={svg}
        role="group"
        aria-label="世界地图画布"
        aria-describedby={hintId}
        tabIndex={0}
        viewBox={`0 0 ${canvas.width} ${canvas.height}`}
        className={`map-svg map-mode-${mode}`}
        style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={(event) => end(event)}
        onPointerCancel={(event) => end(event, true)}
        onLostPointerCapture={() => {
          drag.current = null;
          panDrag.current = null;
          setGhost(null);
          actions.gesture(false);
        }}
        onKeyDown={keys}
      >
        <defs>
          <pattern
            id={gridId}
            width={canvas.width / 20}
            height={canvas.height / 20}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${canvas.width / 20} 0 L 0 0 0 ${canvas.height / 20}`}
              fill="none"
              className="map-grid-line"
              vectorEffect="non-scaling-stroke"
            />
          </pattern>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="map-route-arrow" />
          </marker>
        </defs>
        <g
          ref={world}
          data-map-world="true"
          transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}
        >
          <rect
            width={canvas.width}
            height={canvas.height}
            className="map-frame"
          />
          {background && (
            <MapBitmap
              key={background}
              source={background}
              canvas={canvas}
              unit={unit}
            />
          )}
          {!background && (
            <rect
              width={canvas.width}
              height={canvas.height}
              fill={`url(#${gridId})`}
              pointerEvents="none"
            />
          )}
          {elements
            .filter(
              (e) => e.kind === "region" && !e.deletedAt && e.id !== drawingId,
            )
            .map(
              (element) =>
                element.kind === "region" && (
                  <polygon
                    key={element.id}
                    data-map-element={element.id}
                    role="button"
                    aria-label={`区域：${element.title || "未命名"}`}
                    tabIndex={element.id === selectedId ? 0 : -1}
                    points={pairs(element.points)}
                    className={`map-region ${element.id === selectedId ? "selected" : ""}`}
                    vectorEffect="non-scaling-stroke"
                    onPointerDown={(event) => startObject(event, element.id)}
                    onKeyDown={(event) => objectKeys(event, element.id)}
                  />
                ),
            )}
          {routes
            .filter((route) => route.points.length)
            .map((route) => (
              <polyline
                key={route.id}
                data-map-element={route.id}
                role="button"
                aria-label={`路线：${elements.find((e) => e.id === route.id)?.title || "未命名"}`}
                tabIndex={route.id === selectedId ? 0 : -1}
                points={pairs(route.points)}
                fill="none"
                className={`map-route ${route.id === selectedId ? "selected" : ""}`}
                markerEnd={`url(#${arrowId})`}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => startObject(event, route.id)}
                onKeyDown={(event) => objectKeys(event, route.id)}
              />
            ))}
          {construction?.kind === "region" && (
            <polyline
              points={pairs(construction.points)}
              fill="none"
              className="map-construction"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {selected &&
            !selected.deletedAt &&
            (selected.kind === "region" || selected.kind === "route") &&
            (selected.kind === "region" ? selected.points : selected.via).map(
              (p, index) => (
                <circle
                  key={index}
                  data-map-vertex={index}
                  aria-label={`顶点${index + 1}`}
                  cx={
                    (ghost?.id === selected.id && ghost.vertex === index
                      ? ghost.point.x
                      : p.x) * canvas.width
                  }
                  cy={
                    (ghost?.id === selected.id && ghost.vertex === index
                      ? ghost.point.y
                      : p.y) * canvas.height
                  }
                  r={5 * unit}
                  className="map-vertex"
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) =>
                    startObject(event, selected.id, index)
                  }
                />
              ),
            )}
          {places.map((place) => {
            const p =
              ghost?.id === place.id && ghost.vertex === null
                ? ghost.point
                : place.point;
            return (
              <g
                key={place.id}
                data-map-element={place.id}
                role="button"
                aria-label={`地点：${place.title || "未命名"}`}
                tabIndex={place.id === selectedId ? 0 : -1}
                className={`map-place ${place.id === selectedId ? "selected" : ""}`}
                transform={`translate(${p.x * canvas.width} ${p.y * canvas.height})`}
                onPointerDown={(event) => startObject(event, place.id)}
                onKeyDown={(event) => objectKeys(event, place.id)}
              >
                <circle r={14 * unit} className="map-place-hit" />
                <circle
                  r={5 * unit}
                  className="map-place-dot"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={(p.x > 0.65 ? -9 : 9) * unit}
                  y={(p.y < 0.1 ? 20 : -7) * unit}
                  textAnchor={p.x > 0.65 ? "end" : "start"}
                  fontSize={13 * unit}
                  strokeWidth={3 * unit}
                >
                  <title>{place.title || "未命名"}</title>
                  {Array.from(place.title || "未命名").length > 18
                    ? Array.from(place.title).slice(0, 18).join("") + "…"
                    : place.title || "未命名"}
                </text>
              </g>
            );
          })}
          {calibration.length > 0 && (
            <g className="map-calibration" pointerEvents="none">
              {calibration.length === 2 && (
                <line
                  x1={calibration[0].x * canvas.width}
                  y1={calibration[0].y * canvas.height}
                  x2={calibration[1].x * canvas.width}
                  y2={calibration[1].y * canvas.height}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {calibration.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x * canvas.width}
                  cy={p.y * canvas.height}
                  r={5 * unit}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}
        </g>
      </svg>
      <p id={hintId} className="map-canvas-hint">
        地点可拖动；选中图上地点后用方向键移动，Shift
        为精细移动。区域顶点可拖动。列表与坐标表单也可编辑；空白处方向键平移，+
        / − 缩放。
      </p>
      {unavailable > 0 && (
        <p className="map-warning">
          {unavailable}{" "}
          条路线的端点已回收或失联，请在对象列表核对；程序不会按同名地点重接。
        </p>
      )}
      {scale && (
        <p className="map-canvas-hint">
          距离按作者填写的“{scale.unit}”比例尺估算；不代表行程时间。
        </p>
      )}
    </section>
  );
});

function MapBitmap({
  source,
  canvas,
  unit,
}: {
  source: string;
  canvas: MapInput["canvas"];
  unit: number;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  return (
    <g pointerEvents="none">
      <image
        aria-label="冻结地图底图"
        href={source}
        width={canvas.width}
        height={canvas.height}
        preserveAspectRatio="none"
        data-map-image-state={status}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("failed")}
      />
      {status !== "ready" && (
        <text
          x={canvas.width / 2}
          y={canvas.height / 2}
          textAnchor="middle"
          fontSize={13 * unit}
          className="map-bitmap-message"
          role={status === "failed" ? "alert" : "status"}
        >
          {status === "failed"
            ? "底图预览未能显示，原图未修改"
            : "正在显示底图…"}
        </text>
      )}
    </g>
  );
}
