import React, { memo } from "react";
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
  return (
    <aside className="chapters">
      <div className="chapter-heading">
        <h2>{book.title}</h2>
        <button title="新建章节" onClick={onCreate}>
          <Plus size={18} />
        </button>
      </div>
      <div className="chapter-list">
        {[{ id: null, title: "未分卷" }, ...(book.volumes || [])].map(
          (volume) => {
            const chapters = book.chapters.filter(
              (chapter) =>
                !chapter.deletedAt &&
                (chapter.volumeId || null) === volume.id &&
                chapter.title.includes(query),
            );
            if (!volume.id && !chapters.length) return null;
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
                    {chapter.status === "final" && <small>正式</small>}
                  </button>
                ))}
              </div>
            );
          },
        )}
        {query &&
          !book.chapters.some(
            (chapter) => !chapter.deletedAt && chapter.title.includes(query),
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
