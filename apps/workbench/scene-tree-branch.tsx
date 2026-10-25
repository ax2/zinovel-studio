import React, { useEffect, useState } from "react";
import type { PlannedScene, PlanningColumn } from "./planning-types";

export function SceneTreeBranch({
  title,
  scenes,
  expanded = false,
  query,
  onScene,
  chapterId,
  columnState,
  allScenes,
  targets,
  disabled,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  title: string;
  scenes: PlannedScene[];
  expanded?: boolean;
  query: string;
  onScene: (id: string) => void;
  chapterId: string | null;
  columnState: string;
  allScenes: PlannedScene[];
  targets: PlanningColumn[];
  disabled: boolean;
  onMove: (
    id: string,
    chapterId: string | null,
    beforeId?: string | null,
  ) => Promise<void>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (
    event: React.DragEvent,
    chapterId: string | null,
    beforeId?: string | null,
  ) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const [page, setPage] = useState(0);
  const [actions, setActions] = useState<string | null>(null);
  const active = allScenes.filter((scene) => scene.state === "active");
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  useEffect(() => setPage(0), [query]);
  const lastPage = Math.max(0, Math.ceil(scenes.length / 20) - 1);
  const currentPage = Math.min(page, lastPage);
  if (!scenes.length) return null;
  return (
    <details
      className="scene-tree-branch"
      open={!!query || open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary aria-label={`${title}的计划场景`}>
        计划场景 <small>{scenes.length}</small>
      </summary>
      <div role="group" aria-label={`${title}的场景列表`}>
        {scenes.slice(currentPage * 20, (currentPage + 1) * 20).map((scene) => {
          const index = active.findIndex((item) => item.id === scene.id),
            movable = !disabled && scene.state === "active";
          return (
            <div className="scene-tree-row" key={scene.id}>
              <button
                className="scene-tree-item"
                disabled={scene.state === "missing"}
                onClick={() => onScene(scene.id)}
                draggable={movable}
                onDragStart={(e) => {
                  if (!movable) {
                    e.preventDefault();
                    return;
                  }
                  onDragStart(scene.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", scene.id);
                }}
                onDragEnd={onDragEnd}
                onDragOver={(e) => {
                  if (movable && columnState === "active") e.preventDefault();
                }}
                onDrop={(e) => {
                  if (movable && columnState === "active")
                    onDrop(e, chapterId, scene.id);
                }}
              >
                <span>{scene.title}</span>
                {scene.state !== "active" && (
                  <small>
                    {scene.state === "deleted" ? "已回收" : "不可读取"}
                  </small>
                )}
              </button>
              <button
                className="scene-tree-action"
                aria-label={`调整 ${scene.title} 位置`}
                aria-expanded={actions === scene.id}
                disabled={!movable}
                onClick={() =>
                  setActions(actions === scene.id ? null : scene.id)
                }
              >
                ⋯
              </button>
              {actions === scene.id && (
                <div
                  className="scene-tree-position"
                  role="group"
                  aria-label={`${scene.title}的位置操作`}
                >
                  <small>按本列完整顺序调整；正文不变。</small>
                  <label>
                    移动到
                    <select
                      aria-label={`树中移动 ${scene.title} 到章节`}
                      disabled={!movable}
                      value={
                        columnState === "active"
                          ? chapterId || "unassigned"
                          : "lost"
                      }
                      onChange={(e) =>
                        void onMove(
                          scene.id,
                          e.target.value === "unassigned"
                            ? null
                            : e.target.value,
                        )
                      }
                    >
                      {columnState !== "active" && (
                        <option value="lost" disabled>
                          原章节失联
                        </option>
                      )}
                      {targets.map((target) => (
                        <option
                          key={target.id || "unassigned"}
                          value={target.id || "unassigned"}
                        >
                          {target.volume ? `${target.volume} / ` : ""}
                          {target.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    aria-label={`${scene.title}上移`}
                    disabled={
                      !movable || columnState !== "active" || index <= 0
                    }
                    onClick={() =>
                      void onMove(scene.id, chapterId, active[index - 1].id)
                    }
                  >
                    上移
                  </button>
                  <button
                    aria-label={`${scene.title}下移`}
                    disabled={
                      !movable ||
                      columnState !== "active" ||
                      index < 0 ||
                      index >= active.length - 1
                    }
                    onClick={() =>
                      void onMove(
                        scene.id,
                        chapterId,
                        active[index + 2]?.id || null,
                      )
                    }
                  >
                    下移
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {scenes.length > 20 && (
        <div className="scene-tree-pages">
          <button
            aria-label={`${title}上一页场景`}
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <small>
            {currentPage + 1}/{lastPage + 1}
          </small>
          <button
            aria-label={`${title}下一页场景`}
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </details>
  );
}
