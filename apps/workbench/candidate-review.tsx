import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  candidateDiff,
  composeCandidate,
} from "../../packages/novel-domain/candidate-diff.mjs";

export function CandidateReview({
  original,
  candidate,
  applying,
  error,
  onClose,
  onAccept,
}: {
  original: string;
  candidate: string;
  applying: boolean;
  error: string;
  onClose: () => void;
  onAccept: (text: string) => Promise<void>;
}) {
  const [comparison, setComparison] = useState(candidate);
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const diff = useMemo(
    () => candidateDiff(original, comparison),
    [original, comparison],
  );
  const changes = diff.segments.filter((part) => part.kind === "change");
  const text = composeCandidate(diff, rejected);
  const reset = (value: string) => {
    setComparison(value);
    setRejected(new Set());
    setPage(0);
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal proposal-modal"
        role="dialog"
        aria-modal="true"
        aria-label="审阅 AI 候选"
      >
        <div className="modal-heading">
          <h2>审阅 AI 候选</h2>
          <button aria-label="关闭候选" disabled={applying} onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          接受后保存正文，并保留历史版本。正文如有变化，将拒绝替换。关闭窗口后可从写作任务记录找回原候选；尚未接受的逐块选择和手工调整不会保存。
        </p>
        <div className="conflict-columns">
          <section>
            <h3>原文选区</h3>
            <pre>{original || "（插入新内容）"}</pre>
          </section>
          <section>
            <h3>候选文本</h3>
            <textarea
              aria-label="候选文本"
              value={text}
              readOnly={applying}
              onChange={(event) => reset(event.target.value)}
            />
            <small className="muted">
              手工编辑会把当前逐块选择合入文本，并重新计算差异。
            </small>
          </section>
        </div>
        <details className="candidate-diff">
          <summary>
            逐块审阅：{changes.length} 处修改，采用{" "}
            {changes.length - rejected.size} 处
          </summary>
          {diff.coarse && (
            <p className="muted">
              文本较大或修改过多，已将中间差异合为一块。原文和候选保持完整，可在上方手工调整。
            </p>
          )}
          {!changes.length && <p className="muted">候选与原文一致。</p>}
          <div className="diff-actions">
            <button
              disabled={applying || !changes.length}
              onClick={() => setRejected(new Set())}
            >
              全部采用修改
            </button>
            <button
              disabled={applying || !changes.length}
              onClick={() =>
                setRejected(new Set(changes.map((part) => part.id!)))
              }
            >
              全部保留原文
            </button>
            <button disabled={applying} onClick={() => reset(candidate)}>
              恢复本次候选
            </button>
          </div>
          {changes.slice(page * 20, page * 20 + 20).map((part) => (
            <section
              className="diff-block"
              key={part.id}
              aria-label={`修改块 ${part.id! + 1}`}
            >
              <label className="diff-choice">
                <input
                  type="checkbox"
                  checked={!rejected.has(part.id!)}
                  disabled={applying}
                  onChange={(event) =>
                    setRejected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.delete(part.id!);
                      else next.add(part.id!);
                      return next;
                    })
                  }
                />
                采用修改 {part.id! + 1}{" "}
                <span>
                  {rejected.has(part.id!) ? "（保留原文）" : "（待采用）"}
                </span>
              </label>
              <div className="diff-pair">
                <div>
                  <h4>原文</h4>
                  <pre>{part.before || "（无内容）"}</pre>
                </div>
                <div>
                  <h4>候选</h4>
                  <pre>{part.after || "（删除此处内容）"}</pre>
                </div>
              </div>
            </section>
          ))}
          {changes.length > 20 && (
            <div className="diff-actions">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页修改
              </button>
              <span>
                {page + 1} / {Math.ceil(changes.length / 20)}
              </span>
              <button
                disabled={(page + 1) * 20 >= changes.length}
                onClick={() => setPage(page + 1)}
              >
                下一页修改
              </button>
            </div>
          )}
        </details>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button disabled={applying} onClick={onClose}>
            暂不采用
          </button>
          <button
            className="primary"
            disabled={applying || !text.trim()}
            onClick={() => void onAccept(text)}
          >
            {applying ? "正在保存…" : "接受候选"}
          </button>
        </div>
      </div>
    </div>
  );
}
