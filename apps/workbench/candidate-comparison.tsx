import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "./api";
import type { StoredTask } from "./task-history";
import { reviewContent } from "../../packages/novel-domain/review-content.mjs";

export function CandidateComparison({
  first,
  choices,
  onClose,
  onReview,
}: {
  first: StoredTask;
  choices: { id: string; startedAt: string; model: string }[];
  onClose: () => void;
  onReview?: (task: StoredTask) => void;
}) {
  const [secondId, setSecondId] = useState(choices[0]?.id || "");
  const [second, setSecond] = useState<StoredTask | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setSecond(null);
    setError("");
    if (secondId)
      api<StoredTask>("ai.task", { id: secondId })
        .then((value) => {
          if (active) setSecond(value);
        })
        .catch((failure) => {
          if (active) setError(failure.message);
        });
    return () => {
      active = false;
    };
  }, [secondId]);
  const a = first.snapshot.target,
    b = second?.snapshot.target;
  const compatible =
    !!a &&
    !!b &&
    typeof a.baseHash === "string" &&
    a.baseHash === b.baseHash &&
    a.bookId === b.bookId &&
    a.chapterId === b.chapterId &&
    a.body === b.body &&
    a.start === b.start &&
    a.end === b.end;
  function text(task: StoredTask) {
    return reviewContent(task).text;
  }
  function source(task: StoredTask) {
    return reviewContent(task).source === "recovered-acceptance"
      ? "显示接受前确认文本"
      : reviewContent(task).source === "saved-review"
        ? "显示已保存审阅草稿"
        : "显示任务候选";
  }
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="modal candidate-comparison"
        role="dialog"
        aria-modal="true"
        aria-label="比较候选"
      >
        <div className="modal-heading">
          <h2>比较候选</h2>
          <button aria-label="关闭候选比较" onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          比较当前任务页中的同章候选，不调用模型、不修改正文。已保存的审阅草稿优先显示；选择版本后仍需审阅并明确接受。
        </p>
        <label>
          对比的任务
          <select
            aria-label="对比的任务"
            value={secondId}
            onChange={(event) => setSecondId(event.target.value)}
          >
            {choices.map((task) => (
              <option key={task.id} value={task.id}>
                {new Date(task.startedAt).toLocaleString("zh-CN")} ·{" "}
                {task.model} · {task.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {second && (
          <p
            className={compatible ? "muted" : "inline-error"}
            role="status"
            aria-label="候选基线核对"
          >
            {compatible
              ? "两份候选来自同一章、同一原稿和选区。"
              : "原稿或选区不同：只读对照，不能从此处选择另一版接受。"}
          </p>
        )}
        <div className="conflict-columns">
          <section>
            <h3>当前候选</h3>
            <small>
              {source(first)} ·{" "}
              {first.record.status === "awaiting-review"
                ? "可继续审阅"
                : "只读历史候选"}
            </small>
            <textarea readOnly aria-label="当前对比候选" value={text(first)} />
            {first.reviewDraftError && (
              <p className="inline-error">{first.reviewDraftError}</p>
            )}
          </section>
          <section>
            <h3>另一候选</h3>
            <small>
              {second
                ? `${source(second)} · ${second.record.status === "awaiting-review" ? "可继续审阅" : "只读历史候选"}`
                : "正在读取"}
            </small>
            <textarea
              readOnly
              aria-label="另一对比候选"
              value={second ? text(second) : "正在读取…"}
            />
            {second?.reviewDraftError && (
              <p className="inline-error">{second.reviewDraftError}</p>
            )}
          </section>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>返回任务</button>
          {onReview && (
            <>
              <button
                disabled={first.record.status !== "awaiting-review"}
                onClick={() => onReview(first)}
              >
                审阅当前版
              </button>
              <button
                className="primary"
                disabled={
                  !second ||
                  !compatible ||
                  second.record.status !== "awaiting-review"
                }
                onClick={() => second && onReview(second)}
              >
                审阅另一版
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
