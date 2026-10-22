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
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal"
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
          onClick={() => {
            try {
              setError("");
              setPreview(previewReplacement(snapshot.body, query, replacement));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          预览替换位置
        </button>
        {preview && (
          <>
            <p>
              本章共有 {preview.count} 处匹配
              {preview.truncated ? "，下方展示前 50 处" : ""}。
            </p>
            <div className="replacement-matches">
              {preview.matches.map((match) => (
                <div key={match.start}>
                  <span>位置 {match.start + 1}</span>
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
            disabled={!preview?.count}
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
