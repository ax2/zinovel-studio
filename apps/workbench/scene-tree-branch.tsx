import React, { useEffect, useState } from "react";
import type { PlannedScene } from "./planning-types";

export function SceneTreeBranch({
  title,
  scenes,
  expanded = false,
  query,
  onScene,
}: {
  title: string;
  scenes: PlannedScene[];
  expanded?: boolean;
  query: string;
  onScene: (id: string) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const [page, setPage] = useState(0);
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
        {scenes.slice(currentPage * 20, (currentPage + 1) * 20).map((scene) => (
          <button
            key={scene.id}
            className="scene-tree-item"
            disabled={scene.state === "missing"}
            onClick={() => onScene(scene.id)}
          >
            <span>{scene.title}</span>
            {scene.state !== "active" && (
              <small>{scene.state === "deleted" ? "已回收" : "不可读取"}</small>
            )}
          </button>
        ))}
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
