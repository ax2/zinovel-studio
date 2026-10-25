import React, { useEffect, useState } from "react";
import { moveReadonlyCaret } from "../../packages/novel-domain/readonly-caret.mjs";

export type ImportPreview = {
  chapters: { id: string; title: string; body: string; volume: string }[];
  sources: { name: string }[];
  totalCharacters: number;
  adjustments: number;
};
export function ImportPreviewEditor({
  preview,
  selected,
  onSelected,
  busy,
  onEdit,
}: {
  preview: ImportPreview;
  selected: number;
  onSelected: (index: number) => void;
  busy: boolean;
  onEdit: (operation: Record<string, unknown>) => Promise<void>;
}) {
  const chapter = preview.chapters[selected];
  const [name, setName] = useState(chapter.title),
    [volume, setVolume] = useState(chapter.volume);
  const [nextName, setNextName] = useState(""),
    [offset, setOffset] = useState(0);
  const [separator, setSeparator] = useState("\n\n");
  useEffect(() => {
    setName(chapter.title);
    setVolume(chapter.volume);
    setOffset(0);
    setNextName(`${Array.from(chapter.title).slice(0, 190).join("")}（续）`);
  }, [chapter.id, chapter.title, chapter.volume, chapter.body]);
  return (
    <>
      <div className="import-preview">
        <div aria-label="预览章节列表">
          {preview.chapters.map((item, index) => (
            <button
              key={item.id}
              disabled={busy}
              className={selected === index ? "selected" : ""}
              onClick={() => onSelected(index)}
            >
              {item.volume && <small>{item.volume}</small>}
              {item.title}
            </button>
          ))}
        </div>
        <textarea
          className="import-body"
          aria-label="预览正文（选择拆分位置）"
          readOnly
          value={chapter.body}
          onSelect={(e) =>
            setOffset(
              e.currentTarget.selectionDirection === "backward"
                ? e.currentTarget.selectionStart
                : e.currentTarget.selectionEnd,
            )
          }
          onKeyDown={(e) => {
            if (e.altKey || e.metaKey) return;
            const field = e.currentTarget;
            const next = moveReadonlyCaret(chapter.body, {
              start: field.selectionStart,
              end: field.selectionEnd,
              direction: field.selectionDirection,
              key: e.key,
              shift: e.shiftKey,
              control: e.ctrlKey,
            });
            if (!next) return;
            e.preventDefault();
            field.setSelectionRange(
              next.start,
              next.end,
              next.direction as "forward" | "backward" | "none",
            );
            setOffset(next.focus);
          }}
        />
      </div>
      <details className="import-edit" aria-label="调整导入章节">
        <summary>手工调整章节名称与边界</summary>
        <p className="muted">
          在上方正文中点击或用键盘移动光标后拆分。这里只调整本次预览，确认后才创建作品；单章正式保存最多8
          MiB。
        </p>
        <div className="import-edit-fields">
          <label>
            本章名称
            <input
              aria-label="预览章名"
              value={name}
              disabled={busy}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            所属卷名（留空为未分卷）
            <input
              aria-label="预览卷名"
              value={volume}
              disabled={busy}
              maxLength={200}
              onChange={(e) => setVolume(e.target.value)}
            />
          </label>
        </div>
        <button
          disabled={busy || !name.trim()}
          onClick={() =>
            onEdit({
              type: "rename",
              chapterId: chapter.id,
              title: name,
              volume,
            })
          }
        >
          应用卷章名称
        </button>
        <div className="import-edit-fields">
          <label>
            拆分后新章名称
            <input
              aria-label="拆分后新章名称"
              value={nextName}
              disabled={busy}
              maxLength={200}
              onChange={(e) => setNextName(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              offset <= 0 ||
              offset >= chapter.body.length ||
              !nextName.trim()
            }
            onClick={() =>
              onEdit({
                type: "split",
                chapterId: chapter.id,
                offset,
                title: nextName,
              })
            }
          >
            从光标处拆分
          </button>
        </div>
        <div className="import-edit-fields">
          <label>
            合并时的连接方式
            <select
              aria-label="合并分隔方式"
              value={separator}
              disabled={busy}
              onChange={(e) => setSeparator(e.target.value)}
            >
              <option value="\n\n">加入空行</option>
              <option value="\n">加入换行</option>
              <option value="">直接连接</option>
            </select>
          </label>
          <button
            disabled={busy || selected + 1 >= preview.chapters.length}
            onClick={() =>
              onEdit({ type: "merge-next", chapterId: chapter.id, separator })
            }
          >
            与下一章合并
          </button>
        </div>
        <p className="muted">
          合并保留本章名称与卷名，下一章的正文按所选方式接入。
        </p>
        <button
          disabled={busy || !preview.adjustments}
          onClick={() => onEdit({ type: "reset" })}
        >
          放弃全部预览调整
        </button>
      </details>
    </>
  );
}
