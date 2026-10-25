import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PlanningSnapshot as Snapshot } from "./planning-types";
export function ScenePlanner({
  bookId,
  onClose,
  onEdit,
  onChapter,
}: {
  bookId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  onChapter: (id: string) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [outline, setOutline] = useState(false),
    [filter, setFilter] = useState("all");
  const active = useRef(true),
    locked = useRef(false),
    dragged = useRef<string | null>(null);
  async function refresh() {
    const value = await api<Snapshot>("planning.read", { bookId });
    if (active.current) setSnapshot(value);
  }
  useEffect(() => {
    active.current = true;
    void refresh().catch((e) => active.current && setError(e.message));
    return () => {
      active.current = false;
    };
  }, [bookId]);
  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  function move(
    sceneId: string,
    chapterId: string | null,
    beforeId: string | null = null,
  ) {
    if (!snapshot || sceneId === beforeId) return;
    void perform(async () => {
      await api("planning.move", {
        bookId,
        mutation: { sceneId, chapterId, beforeId },
        expected: { revision: snapshot.revision, diskHash: snapshot.diskHash },
      });
      await refresh();
      if (active.current) setMessage("已保存场景位置；正文未改动。");
    });
  }
  const key = (id: string | null) => id || "unassigned";
  const targets =
    snapshot?.columns.filter((column) => column.state === "active") || [];
  return (
    <div className="modal-backdrop">
      <section
        className="modal scene-planner"
        role="dialog"
        aria-modal="true"
        aria-label="场景编排"
      >
        <header>
          <div>
            <h2>场景编排</h2>
            <p>规划位置尚未写入正文；卡片内容与资料卡共用。</p>
          </div>
          <button aria-label="关闭场景编排" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        <div className="scene-toolbar">
          <div role="group" aria-label="场景视图">
            <button aria-pressed={!outline} onClick={() => setOutline(false)}>
              看板
            </button>
            <button aria-pressed={outline} onClick={() => setOutline(true)}>
              章纲
            </button>
          </div>
          <label>
            显示章节
            <select
              aria-label="显示规划章节"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部章节</option>
              {snapshot?.columns.map((column) => (
                <option key={key(column.id)} value={key(column.id)}>
                  {column.title}
                  {column.state !== "active" ? "（失联）" : ""}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => void perform(refresh)}>
            刷新规划
          </button>
          <span>版本 {snapshot?.revision ?? "…"}</span>
        </div>
        {error && (
          <p role="alert" className="alert error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!!snapshot?.errorCount && (
          <p role="alert">
            {snapshot.errorCount}{" "}
            份资料无法读取，原文件保留。失联卡仍显示在原位置。
          </p>
        )}
        {!snapshot && !error && <p role="status">正在读取场景…</p>}
        <div
          className={`scene-columns ${outline ? "scene-outline" : ""}`}
          aria-busy={busy}
        >
          {snapshot?.columns
            .filter((column) => filter === "all" || key(column.id) === filter)
            .map((column) => {
              const valid = column.scenes.filter(
                (scene) => scene.state === "active",
              );
              return (
                <section
                  key={key(column.id)}
                  className="scene-column"
                  aria-label={`规划列：${column.title}`}
                >
                  <header>
                    <h3>{column.title}</h3>
                    <span>{valid.length} 场景</span>
                  </header>
                  {column.volume && <small>{column.volume}</small>}
                  {column.state !== "active" && (
                    <p role="status">
                      {column.state === "deleted" ? "章节已删除" : "章节失联"}
                      ，请将场景移到有效章节。
                    </p>
                  )}
                  {column.id && column.state === "active" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await onChapter(column.id!);
                          onClose();
                        })
                      }
                    >
                      打开本章正文
                    </button>
                  )}
                  {column.scenes.map((scene) => {
                    const index = valid.findIndex(
                        (item) => item.id === scene.id,
                      ),
                      enabled = !busy && scene.state === "active";
                    return (
                      <article
                        key={scene.id}
                        className="scene-card"
                        aria-label={`场景：${scene.title}`}
                        draggable={enabled}
                        onDragStart={(e) => {
                          if (!enabled) {
                            e.preventDefault();
                            return;
                          }
                          dragged.current = scene.id;
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", scene.id);
                        }}
                        onDragEnd={() => {
                          dragged.current = null;
                        }}
                        onDragOver={(e) => {
                          if (
                            enabled &&
                            column.state === "active" &&
                            dragged.current
                          ) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (
                            enabled &&
                            column.state === "active" &&
                            dragged.current
                          )
                            move(dragged.current, column.id, scene.id);
                          dragged.current = null;
                        }}
                      >
                        <h4>{scene.title}</h4>
                        {scene.state !== "active" ? (
                          <p>
                            {scene.state === "deleted"
                              ? "场景已删除，可到资料回收站恢复；原位置保留。"
                              : "场景失联，原位置保留。"}
                          </p>
                        ) : (
                          <>
                            <dl>
                              {(outline
                                ? [
                                    ["pov", "视角"],
                                    ["location", "地点"],
                                    ["time", "时间"],
                                    ["goal", "目标"],
                                    ["obstacle", "阻碍"],
                                    ["choice", "选择"],
                                    ["result", "结果"],
                                  ]
                                : [
                                    ["goal", "目标"],
                                    ["obstacle", "阻碍"],
                                    ["result", "结果"],
                                  ]
                              ).map(([field, label]) => (
                                <React.Fragment key={field}>
                                  <dt>{label}</dt>
                                  <dd>{scene.fields?.[field] || "尚未设定"}</dd>
                                </React.Fragment>
                              ))}
                            </dl>
                            <button
                              disabled={busy}
                              onClick={() => onEdit(scene.id)}
                            >
                              编辑场景完整资料
                            </button>
                            <label>
                              移动到
                              <select
                                aria-label={`移动 ${scene.title} 到章节`}
                                value={
                                  column.state === "active"
                                    ? key(column.id)
                                    : "lost"
                                }
                                disabled={!enabled}
                                onChange={(e) =>
                                  move(
                                    scene.id,
                                    e.target.value === "unassigned"
                                      ? null
                                      : e.target.value,
                                  )
                                }
                              >
                                {column.state !== "active" && (
                                  <option value="lost" disabled>
                                    当前章节失联
                                  </option>
                                )}
                                {targets.map((target) => (
                                  <option
                                    key={key(target.id)}
                                    value={key(target.id)}
                                  >
                                    {target.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="scene-order">
                              <button
                                disabled={
                                  !enabled ||
                                  index <= 0 ||
                                  column.state !== "active"
                                }
                                onClick={() =>
                                  move(scene.id, column.id, valid[index - 1].id)
                                }
                              >
                                上移
                              </button>
                              <button
                                disabled={
                                  !enabled ||
                                  index < 0 ||
                                  index >= valid.length - 1 ||
                                  column.state !== "active"
                                }
                                onClick={() =>
                                  move(
                                    scene.id,
                                    column.id,
                                    valid[index + 2]?.id || null,
                                  )
                                }
                              >
                                下移
                              </button>
                            </div>
                          </>
                        )}
                      </article>
                    );
                  })}
                  {column.state === "active" && (
                    <div
                      className="scene-drop"
                      aria-label={`追加场景到：${column.title}`}
                      onDragOver={(e) => {
                        if (!busy && dragged.current) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!busy && dragged.current)
                          move(dragged.current, column.id);
                        dragged.current = null;
                      }}
                    >
                      拖放到末尾 · 也可用卡片的移动菜单
                    </div>
                  )}
                </section>
              );
            })}
        </div>
        <p className="scene-help">
          字段显示前 240 字符；完整内容请打开资料。新增场景：创作参考 → 资料卡 →
          场景。
        </p>
      </section>
    </div>
  );
}
