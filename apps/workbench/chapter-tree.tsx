import React, { memo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import type { Book } from "./api";
type Props = {
  book: Book;
  chapterId?: string;
  query: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onManage: () => void;
};
export const ChapterTree = memo(function ChapterTree({
  book,
  chapterId,
  query,
  onOpen,
  onCreate,
  onManage,
}: Props) {
  const [status, setStatus] = useState("all");
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
        {[{ id: null, title: "未分卷" }, ...(book.volumes || [])].map(
          (volume) => {
            const chapters = book.chapters.filter(
              (chapter) =>
                !chapter.deletedAt &&
                (chapter.volumeId || null) === volume.id &&
                chapter.title.includes(query) &&
                (status === "all" || (chapter.status || "draft") === status),
            );
            if (!chapters.length && (!volume.id || query || status !== "all"))
              return null;
            return (
              <div key={volume.id || "unassigned"}>
                {(book.volumes?.length || 0) > 0 && (
                  <h3 className="volume-label">{volume.title}</h3>
                )}
                {chapters.map((chapter) => (
                  <button
                    key={chapter.id}
                    className={chapter.id === chapterId ? "selected" : ""}
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
                ))}
              </div>
            );
          },
        )}
        {(query || status !== "all") &&
          !book.chapters.some(
            (chapter) =>
              !chapter.deletedAt &&
              chapter.title.includes(query) &&
              (status === "all" || (chapter.status || "draft") === status),
          ) && <p className="muted">没有匹配的章节</p>}
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
