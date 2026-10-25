import React, { memo, useMemo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import type { Book } from "./api";
import { useSceneTree } from "./use-scene-tree";
import { SceneTreeBranch } from "./scene-tree-branch";
type Props = {
  book: Book;
  chapterId?: string;
  query: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onManage: () => void;
  onScene: (id: string) => void;
  onPlan: () => void;
};
export const ChapterTree = memo(function ChapterTree({
  book,
  chapterId,
  query,
  onOpen,
  onCreate,
  onManage,
  onScene,
  onPlan,
}: Props) {
  const [status, setStatus] = useState("all");
  const scenes = useSceneTree(book.id);
  const byChapter = useMemo(
    () =>
      new Map(
        scenes.snapshot?.columns.map((column) => [column.id, column]) || [],
      ),
    [scenes.snapshot],
  );
  const matchesChapter = (chapter: Book["chapters"][number]) =>
    !chapter.deletedAt &&
    (status === "all" || (chapter.status || "draft") === status) &&
    (chapter.title.includes(query) ||
      !!byChapter
        .get(chapter.id)
        ?.scenes.some((scene) => scene.title.includes(query)));
  const extras =
    scenes.snapshot?.columns.filter(
      (column) => column.id === null || column.state !== "active",
    ) || [];
  return (
    <aside className="chapters">
      <div className="chapter-heading">
        <h2>{book.title}</h2>
        <button title="新建章节" onClick={onCreate}>
          <Plus size={18} />
        </button>
      </div>
      <label className="chapter-filter">
        章节状态
        <select
          aria-label="筛选章节状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部章节</option>
          <option value="draft">草稿</option>
          <option value="reviewed">已审读</option>
          <option value="final">正式</option>
        </select>
      </label>
      <div className="chapter-list">
        <div className="scene-tree-tools">
          <small>场景为计划，不自动改正文。</small>
          <button onClick={onPlan}>编排场景位置</button>
          <button onClick={scenes.refresh} disabled={scenes.loading}>
            刷新场景树
          </button>
          {scenes.loading && <small role="status">正在读取场景…</small>}
          {scenes.error && <p role="alert">场景树未刷新：{scenes.error}</p>}
          {!!scenes.snapshot?.errorCount && (
            <p role="alert">
              {scenes.snapshot.errorCount}份资料不可读取，请保留文件并检查。
            </p>
          )}
        </div>
        {[{ id: null, title: "未分卷" }, ...(book.volumes || [])].map(
          (volume) => {
            const chapters = book.chapters.filter(
              (chapter) =>
                (chapter.volumeId || null) === volume.id &&
                matchesChapter(chapter),
            );
            if (!chapters.length && (!volume.id || query || status !== "all"))
              return null;
            return (
              <div key={volume.id || "unassigned"}>
                {(book.volumes?.length || 0) > 0 && (
                  <h3 className="volume-label">{volume.title}</h3>
                )}
                {chapters.map((chapter) => (
                  <React.Fragment key={chapter.id}>
                    <button
                      className={`chapter-entry ${chapter.id === chapterId ? "selected" : ""}`}
                      data-chapter-id={chapter.id}
                      onClick={() => onOpen(chapter.id)}
                    >
                      <FileText size={17} />
                      <span>{chapter.title}</span>
                      <small>
                        {chapter.status === "final"
                          ? "正式"
                          : chapter.status === "reviewed"
                            ? "已审"
                            : "草稿"}
                      </small>
                    </button>
                    <SceneTreeBranch
                      title={chapter.title}
                      scenes={(byChapter.get(chapter.id)?.scenes || []).filter(
                        (scene) =>
                          chapter.title.includes(query) ||
                          scene.title.includes(query),
                      )}
                      expanded={chapter.id === chapterId}
                      query={query}
                      onScene={onScene}
                    />
                  </React.Fragment>
                ))}
              </div>
            );
          },
        )}
        {(query || status !== "all") && !book.chapters.some(matchesChapter) && (
          <p className="muted">没有匹配的章节或章内场景</p>
        )}
        {status === "all" &&
          extras.map((column) => {
            const list = column.scenes.filter(
              (scene) =>
                column.title.includes(query) || scene.title.includes(query),
            );
            if (!list.length) return null;
            const label =
              column.id === null
                ? "未安排"
                : `${column.title} · ${column.state === "deleted" ? "章节已回收" : "章节缺失"}`;
            return (
              <div
                key={column.id || "unassigned-scenes"}
                className="scene-tree-extra"
              >
                <h3 className="volume-label">{label}</h3>
                <SceneTreeBranch
                  title={label}
                  scenes={list}
                  expanded
                  query={query}
                  onScene={onScene}
                />
              </div>
            );
          })}
        {status !== "all" && (
          <p className="muted">未安排与失联场景可在“全部章节”下查看。</p>
        )}
      </div>
      <button className="book-manage" onClick={onManage}>
        管理作品 / 回收站
      </button>
      <button className="add-chapter" onClick={onCreate}>
        <Plus size={18} />
        新建章节
      </button>
    </aside>
  );
});
