import React, { useMemo, useRef, useState } from "react";
import type { Row } from "./continuity-workbench";
import { materialKinds } from "../../packages/novel-domain/materials.mjs";

type Node = {
  id: string;
  title: string;
  kind: string;
  state: string;
  changedDuringScan: boolean;
};
export type RelationshipData = {
  nodes: Node[];
  events: (Row & { number: number })[];
  totalEvents: number;
  omittedEvents: number;
  nodeLimit: number;
  eventLimit: number;
};
const conditions: Record<string, string> = {
  current: "有效",
  stale: "待复核",
  missing: "来源缺失",
  retired: "已停用",
  deleted: "资料已删除",
};
const preview = (text: string) => {
  const chars = Array.from(text);
  return chars.length > 140 ? chars.slice(0, 140).join("") + "…" : text;
};

export function RelationshipGraph({
  data,
  disabled,
  focusId,
  onFocus,
  onEdit,
  onChapter,
  onTable,
}: {
  data: RelationshipData;
  disabled: boolean;
  focusId?: string;
  onFocus: (node: { id: string; title: string }) => void;
  onEdit: (id: string) => void;
  onChapter: (row: Row) => Promise<void>;
  onTable: (row: Row) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(""),
    [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const selected =
    data.events.find((event) => event.key === selectedKey) || data.events[0];
  const layout = useMemo(() => {
    const radius = Math.max(220, data.nodes.length * 28),
      size = radius * 2 + 240;
    const positions = new Map(
      data.nodes.map((node, index) => {
        const angle =
          -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, data.nodes.length);
        return [
          node.id,
          {
            x: size / 2 + Math.cos(angle) * radius,
            y: size / 2 + Math.sin(angle) * radius,
          },
        ];
      }),
    );
    const edges = data.events.flatMap((event) =>
      event.related.map((target) => ({
        key: `${event.key}/${target.id}`,
        event,
        source: event.ownerId,
        target: target.id,
        pair: [event.ownerId, target.id].sort().join("/"),
      })),
    );
    const pairs = new Map<string, typeof edges>();
    for (const edge of edges) {
      const group = pairs.get(edge.pair) || [];
      group.push(edge);
      pairs.set(edge.pair, group);
    }
    return {
      size,
      positions,
      edges: edges.map((edge) => {
        const a = positions.get(edge.source)!,
          b = positions.get(edge.target)!;
        const siblings = pairs.get(edge.pair)!,
          lane = siblings.indexOf(edge),
          amount = siblings.length;
        if (edge.source === edge.target) {
          const loop = 90 + Math.min(lane, 6) * 9;
          return {
            ...edge,
            path: `M ${a.x} ${a.y} C ${a.x + loop} ${a.y - loop}, ${a.x - loop} ${a.y - loop}, ${a.x} ${a.y}`,
          };
        }
        const first = edge.source < edge.target ? a : b;
        const last = edge.source < edge.target ? b : a;
        const dx = last.x - first.x,
          dy = last.y - first.y,
          length = Math.hypot(dx, dy);
        const bend =
          amount === 1
            ? 0
            : (lane / (amount - 1) - 0.5) * Math.min(240, amount * 30);
        const cx = (first.x + last.x) / 2 - (dy / length) * bend,
          cy = (first.y + last.y) / 2 + (dx / length) * bend;
        return {
          ...edge,
          path: `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${last.x.toFixed(1)} ${last.y.toFixed(1)}`,
        };
      }),
    };
  }, [data]);
  return (
    <section className="relationship-graph" aria-label="关系图与事件">
      <h3>人物与设定关系图</h3>
      <p>
        图中显示 {data.events.length} / {data.totalEvents}{" "}
        条关系事件。连接表示记录所属资料与关联对象，具体含义以事件说明为准。
      </p>
      {data.omittedEvents > 0 && (
        <p className="alert" role="status">
          当前图最多容纳 {data.nodeLimit} 个对象、{data.eventLimit} 条事件，另有{" "}
          {data.omittedEvents}{" "}
          条未绘制。可聚焦对象、缩小筛选，或切换表格查看全部事件。
        </p>
      )}
      <p className="muted">
        有效事件为实线，待复核、失联、停用及删除记录为虚线。点击事件高亮对应连接；点击人物或设定可查看与它关联的记录。
      </p>
      <div
        className="relationship-controls"
        role="group"
        aria-label="关系图缩放"
      >
        <button
          disabled={zoom <= 0.35}
          onClick={() =>
            setZoom((value) => Math.max(0.35, +(value - 0.15).toFixed(2)))
          }
        >
          缩小关系图
        </button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          disabled={zoom >= 1.75}
          onClick={() =>
            setZoom((value) => Math.min(1.75, +(value + 0.15).toFixed(2)))
          }
        >
          放大关系图
        </button>
        <button
          onClick={() =>
            setZoom(
              Math.max(
                0.35,
                Math.min(
                  1,
                  Math.min(
                    viewport.current?.clientWidth || layout.size,
                    viewport.current?.clientHeight || layout.size,
                  ) / layout.size,
                ),
              ),
            )
          }
        >
          适合视图
        </button>
        <button onClick={() => setZoom(1)}>实际大小</button>
      </div>
      {!data.events.length ? (
        <p>
          当前筛选没有已记录的关系事件。可在资料卡中选择正文，添加关系变化与关联对象。
        </p>
      ) : (
        <>
          <div
            className="relationship-viewport"
            ref={viewport}
            tabIndex={0}
            aria-label="关系连接图，可滚动查看"
          >
            <div
              className="relationship-scene"
              style={{ width: layout.size * zoom, height: layout.size * zoom }}
            >
              <div
                className="relationship-canvas"
                style={{
                  width: layout.size,
                  height: layout.size,
                  transform: `scale(${zoom})`,
                }}
              >
                <svg
                  width={layout.size}
                  height={layout.size}
                  aria-hidden="true"
                >
                  {layout.edges.map((edge) => (
                    <path
                      key={edge.key}
                      d={edge.path}
                      data-condition={edge.event.condition}
                      data-selected={edge.event.key === selected?.key}
                      className="relationship-edge"
                    />
                  ))}
                </svg>
                {data.nodes.map((node) => {
                  const point = layout.positions.get(node.id)!;
                  return (
                    <button
                      key={node.id}
                      className="relationship-node"
                      style={{ left: point.x - 76, top: point.y - 33 }}
                      disabled={disabled}
                      aria-label={`聚焦关系：${node.title}`}
                      aria-pressed={node.id === focusId}
                      data-state={node.state}
                      title={`${node.title} · ${materialKinds.find((kind) => kind.id === node.kind)?.label || "类型未知"}${node.changedDuringScan ? " · 扫描中版本有变化，请刷新核对" : ""}`}
                      onClick={() => onFocus(node)}
                    >
                      <strong>{node.title}</strong>
                      <small>
                        {materialKinds.find((kind) => kind.id === node.kind)
                          ?.label || "类型未知"}
                        {node.state !== "active"
                          ? ` · ${node.state === "deleted" ? "已删除" : "失联"}`
                          : ""}
                        {node.changedDuringScan ? " · 待刷新" : ""}
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="relationship-event-layout">
            <div
              className="relationship-event-list"
              role="group"
              aria-label="选择关系事件"
            >
              {data.events.map((event) => (
                <button
                  key={event.key}
                  disabled={disabled}
                  aria-pressed={selected?.key === event.key}
                  onClick={() => setSelectedKey(event.key)}
                >
                  <strong>
                    事件 {event.number} · {event.ownerTitle} ·{" "}
                    {conditions[event.condition]}
                  </strong>
                  <span>{preview(event.statement)}</span>
                </button>
              ))}
            </div>
            {selected && (
              <article
                aria-label="关系事件详情"
                className="relationship-detail"
              >
                <h4>
                  事件 {selected.number} · {conditions[selected.condition]}
                </h4>
                <p className="continuity-statement">{selected.statement}</p>
                <p>
                  所属资料：{selected.ownerTitle}（版本 {selected.ownerRevision}
                  ）
                </p>
                <p>
                  关联对象：
                  {selected.related
                    .map(
                      (target) =>
                        `${target.title}${target.state === "active" ? "" : target.state === "deleted" ? "（已删除）" : "（失联）"}`,
                    )
                    .join("、")}
                </p>
                <p>
                  故事时间：{selected.storyTime || "未填写"} · 叙述章序：
                  {selected.chapterOrder ?? "不在当前目录"}
                </p>
                <p>
                  正文来源：{selected.chapterTitle} ·{" "}
                  {conditions[selected.sourceFreshness] || "未知"}
                </p>
                <details>
                  <summary>查看关系事件原引文</summary>
                  <blockquote>{selected.anchor.quote}</blockquote>
                </details>
                <div className="continuity-actions">
                  <button disabled={disabled} onClick={() => onTable(selected)}>
                    在表格核对此事件
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => onEdit(selected.ownerId)}
                  >
                    打开关系原资料
                  </button>
                  <button
                    disabled={disabled || selected.chapterOrder === null}
                    onClick={() => void onChapter(selected)}
                  >
                    查看关系正文依据
                  </button>
                </div>
              </article>
            )}
          </div>
        </>
      )}
    </section>
  );
}
