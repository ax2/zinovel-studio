import React, { useState } from "react";
import { X } from "lucide-react";
import { previewReplacement } from "../../packages/novel-domain/replace.mjs";
import type { WritingSnapshot } from "./assistant";
export function ReplaceDialog({
  snapshot,
  onApply,
  onClose,
}: {
  snapshot: WritingSnapshot;
  onApply: (base: WritingSnapshot, candidate: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [replacement, setReplacement] = useState(""),
    [preview, setPreview] = useState<ReturnType<
      typeof previewReplacement
    > | null>(null),
    [error, setError] = useState("");
  const [selection, setSelection] = useState<{
    all: boolean;
    starts: number[];
  }>({ all: true, starts: [] });
  function updatePreview(next = selection, offset = 0) {
    try {
      setError("");
      const result = previewReplacement(snapshot.body, query, replacement, {
        ...next,
        offset,
      });
      setSelection(next);
      setPreview(result);
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal replace-modal"
        role="dialog"
        aria-modal="true"
        aria-label="查找替换预览"
      >
        <div className="modal-heading">
          <h2>查找替换预览</h2>
          <button aria-label="关闭替换预览" onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          仅修改当前章节。先检查匹配位置，接受后可以一次撤销。
        </p>
        <div className="book-fields">
          <label>
            查找内容
            <input
              autoFocus
              aria-label="查找内容"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label>
            替换为
            <input
              aria-label="替换为"
              value={replacement}
              onChange={(e) => {
                setReplacement(e.target.value);
                setPreview(null);
              }}
            />
          </label>
        </div>
        <button
          disabled={!query}
          onClick={() => updatePreview({ all: true, starts: [] })}
        >
          预览替换位置
        </button>
        {preview && (
          <>
            <p>
              本章共有 {preview.count} 处匹配，已选 {preview.selectedCount} 处。
              {preview.count > 0 &&
                `当前展示 ${preview.offset + 1}–${preview.offset + preview.matches.length} 处。`}
            </p>
            <div className="modal-actions">
              <button
                onClick={() =>
                  updatePreview({ all: true, starts: [] }, preview.offset)
                }
              >
                选中全部匹配
              </button>
              <button
                onClick={() =>
                  updatePreview({ all: false, starts: [] }, preview.offset)
                }
              >
                取消全部选择
              </button>
              <button
                disabled={preview.offset === 0}
                onClick={() =>
                  updatePreview(selection, Math.max(0, preview.offset - 50))
                }
              >
                上一页匹配
              </button>
              <button
                disabled={preview.offset + 50 >= preview.count}
                onClick={() => updatePreview(selection, preview.offset + 50)}
              >
                下一页匹配
              </button>
            </div>
            <div className="replacement-matches">
              {preview.matches.map((match) => (
                <div key={match.start}>
                  <label className="replacement-choice">
                    <input
                      type="checkbox"
                      aria-label={`替换位置 ${match.start + 1}`}
                      checked={match.selected}
                      onChange={() =>
                        updatePreview(
                          {
                            ...selection,
                            starts: selection.starts.includes(match.start)
                              ? selection.starts.filter(
                                  (start) => start !== match.start,
                                )
                              : [...selection.starts, match.start],
                          },
                          preview.offset,
                        )
                      }
                    />
                    位置 {match.start + 1}
                  </label>
                  <p>{match.excerpt}</p>
                </div>
              ))}
            </div>
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!preview?.selectedCount}
            onClick={async () => {
              if (
                preview &&
                (await onApply(
                  { ...snapshot, start: 0, end: snapshot.body.length },
                  preview.body,
                ))
              )
                onClose();
            }}
          >
            应用本章替换
          </button>
        </div>
      </div>
    </div>
  );
}
