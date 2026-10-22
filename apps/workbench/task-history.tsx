import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { X, RefreshCw } from "lucide-react";
import { api } from "./api";
import type { WritingSnapshot } from "./assistant";
import { formatCost, type BudgetSettings } from "./budget-settings";

const statusLabels: Record<string, string> = {
  preparing: "准备中",
  running: "生成中",
  "awaiting-review": "待审阅",
  accepting: "接受状态待核对",
  "acceptance-uncertain": "接受结果待核对",
  applied: "已接受",
  discarded: "已放弃",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "中断待处理",
};
type TaskSummary = {
  id: string;
  bookId?: string;
  bookTitle?: string;
  chapterId?: string;
  chapterTitle?: string;
  skillId: string;
  status: string;
  startedAt: string;
  model: string;
  hasCandidate: boolean;
};
export type StoredTask = {
  reviewDraft?: { text: string; revision: number; updatedAt: string } | null;
  reviewDraftError?: string;
  record: TaskSummary & {
    candidate?: string;
    acceptedText?: string;
    partialCandidate?: boolean;
    partialSource?: "stream";
    streamTruncated?: boolean;
    acceptance?: { acceptedText: string };
    acceptanceRecovery?: string;
    retryOf?: string;
    errorCode?: string;
    usage?: {
      steps: number;
      attempts: number;
      reportedAttempts: number;
      unknownAttempts: number;
      observedTokens: number;
      stopReason?: string;
      policy: BudgetSettings;
      cost: number | null;
      knownCost: number | null;
      estimates: {
        inputTokens: number;
        outputTokenCap: number;
        projectedCost: number | null;
        admitted: boolean;
      }[];
      counts: Record<string, { value: number; reported: number }>;
    };
  };
  snapshot: {
    context: string;
    selectedText: string;
    instruction?: string;
    target?: WritingSnapshot;
  };
};

export function TaskHistory({
  bookId,
  onClose,
  onReview,
  openChapter,
  onRetry,
  retryTarget,
}: {
  bookId?: string;
  onClose: () => void;
  onReview?: (task: StoredTask) => void;
  openChapter: (id: string, bookId?: string) => Promise<void>;
  onRetry?: (task: StoredTask) => void;
  retryTarget?: { bookId: string; chapterId: string } | null;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]),
    [selected, setSelected] = useState<StoredTask | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState(bookId ? "book" : "all"),
    [offset, setOffset] = useState(0);
  const requestSequence = useRef(0);
  async function refresh() {
    const request = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<TaskSummary[]>("ai.tasks", {
        bookId: scope === "book" ? bookId : undefined,
        unbound: scope === "unbound",
        offset,
      });
      if (request === requestSequence.current) setTasks(result);
    } catch (e) {
      if (request === requestSequence.current) setError((e as Error).message);
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [bookId, scope, offset]);
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="modal task-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="写作任务记录"
      >
        <div className="modal-heading">
          <h2>{selected ? "任务详情" : "写作任务记录"}</h2>
          <button aria-label="关闭任务记录" onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          任务保存在本机。中断任务不会自动重试或再次消耗模型额度。关闭候选窗口后，可在这里继续审阅。
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {selected ? (
          <>
            <p>
              <strong>{selected.record.chapterTitle || "未绑定章节"}</strong> ·{" "}
              {statusLabels[selected.record.status] || selected.record.status}
            </p>
            <p className="muted">
              {selected.record.model} ·{" "}
              {new Date(selected.record.startedAt).toLocaleString("zh-CN")}
            </p>
            {selected.record.errorCode === "budget-limit" && (
              <p className="inline-error">
                本次因预算停止。已保存结果仅供参考，调整预算后可在对应章节用当前选区重试。
              </p>
            )}
            {selected.record.usage ? (
              <details
                className="task-usage"
                open={selected.record.errorCode === "budget-limit"}
              >
                <summary>本次用量与预算</summary>
                <p>
                  模型步骤：{selected.record.usage.steps} /{" "}
                  {selected.record.usage.policy.maxSteps}；模型尝试：
                  {selected.record.usage.attempts}；每步输出上限：
                  {selected.record.usage.policy.maxOutputTokens} Token。
                </p>
                <p>
                  供应商已回报合计：
                  {selected.record.usage.reportedAttempts
                    ? `${selected.record.usage.observedTokens} Token`
                    : "未知"}
                  。
                  {selected.record.usage.unknownAttempts > 0 &&
                    `另有 ${selected.record.usage.unknownAttempts} 次尝试或步骤未回报完整用量。`}
                </p>
                <p>
                  {(
                    [
                      ["inputTokens", "非缓存输入"],
                      ["outputTokens", "输出"],
                      ["cacheReadTokens", "缓存读取"],
                      ["cacheWriteTokens", "缓存写入"],
                    ] as const
                  )
                    .map(([key, label]) => {
                      const count = selected.record.usage!.counts[key];
                      return `${label}：${count?.reported ? count.value : "未知"}`;
                    })
                    .join("；")}
                  。
                </p>
                <p className="muted">
                  {selected.record.usage.cost !== null
                    ? `按本任务冻结单价换算：${formatCost(selected.record.usage.cost)} ${selected.record.usage.policy.pricing?.currency}。`
                    : selected.record.usage.policy.pricing
                      ? `完整费用未知；可确认部分为 ${formatCost(selected.record.usage.knownCost || 0)} ${selected.record.usage.policy.pricing.currency}。`
                      : "费用未知：尚未配置单价。"}
                  未回报不等于零；自定义单价换算不替代服务商账单。
                </p>
                {selected.record.usage.estimates?.length > 0 && (
                  <details>
                    <summary>完整请求预估明细</summary>
                    <p className="muted">
                      官方启发式估算包含系统、消息与工具；金额按输入最高单价和输出上限计算，实际输出和计费可能不同。
                    </p>
                    <ol>
                      {selected.record.usage.estimates.map(
                        (estimate, index) => (
                          <li key={index}>
                            输入约 {estimate.inputTokens} Token，输出上限{" "}
                            {estimate.outputTokenCap} Token；
                            {estimate.projectedCost === null
                              ? "费用未知"
                              : `估算 ${formatCost(estimate.projectedCost)} ${selected.record.usage!.policy.pricing?.currency}`}
                            ；
                            {estimate.admitted ? "已准入" : "预算拦截，未发送"}
                            。
                          </li>
                        ),
                      )}
                    </ol>
                  </details>
                )}
              </details>
            ) : (
              <p className="muted">本次尚无用量回报；费用未知。</p>
            )}
            {!selected.snapshot.target && (
              <p className="inline-error">
                这是没有章节绑定的旧版任务，仅供查看和复制。不会猜测原章节，也不能直接应用到当前作品。
              </p>
            )}
            {selected.record.retryOf && (
              <p className="muted">
                本次为作者主动重试的新任务，使用重新选择的当前正文；原任务仍保留。
              </p>
            )}
            <label>
              当时的写作要求
              <textarea
                readOnly
                aria-label="任务写作要求"
                value={selected.snapshot.instruction || "旧任务未保存写作要求"}
              />
            </label>
            <label>
              冻结的原文选区
              <textarea
                readOnly
                aria-label="任务原文选区"
                value={selected.snapshot.selectedText || "（插入新内容）"}
              />
            </label>
            {selected.record.partialCandidate && (
              <p className="inline-error">
                这是任务停止前已保存的部分结果，仅供查看和复制；任务没有正常完成。
              </p>
            )}
            {selected.record.partialSource === "stream" && (
              <p className="muted">
                以下为已保存的模型文字片段，可能包含多次尝试或说明文字，并非完整提案。
                {selected.record.streamTruncated &&
                  "片段达到保留上限，后续文字未保留。"}
              </p>
            )}
            {selected.record.candidate ? (
              <label>
                生成的候选
                <textarea
                  readOnly
                  aria-label="历史候选文本"
                  className="task-candidate"
                  value={selected.record.candidate}
                />
              </label>
            ) : (
              <p className="muted">
                此任务没有完整候选，可保留记录，重新选择正文后另开任务。
              </p>
            )}
            {selected.reviewDraft && (
              <label>
                已保存的审阅草稿（版本 {selected.reviewDraft.revision}）
                <textarea
                  readOnly
                  aria-label="已保存的审阅草稿"
                  value={selected.reviewDraft.text}
                />
              </label>
            )}
            {selected.reviewDraftError && (
              <p className="inline-error" role="alert">
                {selected.reviewDraftError}
              </p>
            )}
            {selected.record.acceptedText &&
              selected.record.acceptedText !== selected.record.candidate && (
                <label>
                  作者最终接受的文本
                  <textarea readOnly value={selected.record.acceptedText} />
                </label>
              )}
            {selected.record.status === "interrupted" && (
              <p className="inline-error">
                上次退出时任务未完成，正式稿未因本任务改变。
              </p>
            )}
            {selected.record.acceptance && !selected.record.acceptedText && (
              <label>
                接受前确认的文本
                <textarea
                  readOnly
                  aria-label="接受前确认文本"
                  value={selected.record.acceptance.acceptedText}
                />
              </label>
            )}
            {["accepting", "acceptance-uncertain"].includes(
              selected.record.status,
            ) && (
              <p className="inline-error">
                接受操作未能完全确认。当前稿与原稿、预期结果可能不一致，请打开对应章节核对；这里不会自动再次改稿。
              </p>
            )}
            {selected.record.acceptanceRecovery ===
              "original-text-retained" && (
              <p className="muted">
                恢复检查确认原稿仍在，候选尚未写入，可重新审阅。
              </p>
            )}
            {selected.record.acceptanceRecovery === "receipt-confirmed" && (
              <p className="muted">
                已找到本次接受的存盘回执，已补全任务记录。正文后续编辑不影响这条历史记录。
              </p>
            )}
            <div className="modal-actions task-actions">
              {["accepting", "acceptance-uncertain"].includes(
                selected.record.status,
              ) && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setSelected(
                        await api("ai.reconcile", { id: selected.record.id }),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  重新核对接受状态
                </button>
              )}
              <button onClick={() => setSelected(null)}>返回列表</button>
              {selected.record.chapterId && selected.record.bookId && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await openChapter(
                        selected.record.chapterId!,
                        selected.record.bookId,
                      );
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  打开对应章节
                </button>
              )}
              {[
                "awaiting-review",
                "interrupted",
                "cancelled",
                "failed",
                "acceptance-uncertain",
              ].includes(selected.record.status) && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api("ai.discard", { id: selected.record.id });
                      setSelected(null);
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  标记放弃
                </button>
              )}
              {onReview &&
                selected.record.bookId === bookId &&
                selected.record.status === "awaiting-review" &&
                selected.record.candidate &&
                selected.snapshot.target && (
                  <button
                    className="primary"
                    onClick={() => onReview(selected)}
                  >
                    继续审阅
                  </button>
                )}
              {onRetry &&
                retryTarget?.bookId === selected.record.bookId &&
                retryTarget?.chapterId === selected.record.chapterId &&
                selected.snapshot.instruction &&
                ["cancelled", "failed", "interrupted"].includes(
                  selected.record.status,
                ) && (
                  <button className="primary" onClick={() => onRetry(selected)}>
                    用当前选区重试
                  </button>
                )}
            </div>
            {onRetry &&
              ["cancelled", "failed", "interrupted"].includes(
                selected.record.status,
              ) && (
                <p className="muted">
                  重试会重新调用模型，使用当前章节和选区生成新候选；原任务与部分结果保留。请先打开对应章节。
                </p>
              )}
          </>
        ) : (
          <>
            <div className="task-list-heading">
              <label>
                任务范围
                <select
                  aria-label="任务范围"
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    setOffset(0);
                  }}
                >
                  {bookId && <option value="book">当前作品</option>}
                  <option value="all">全部作品</option>
                  <option value="unbound">未绑定的旧版任务</option>
                </select>
              </label>
              <button
                aria-label="刷新任务记录"
                disabled={loading}
                onClick={refresh}
              >
                <RefreshCw size={16} />
                刷新
              </button>
            </div>
            {loading ? (
              <p role="status">正在读取…</p>
            ) : tasks.length ? (
              <ul className="task-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      className="task-row"
                      onClick={async () => {
                        setError("");
                        try {
                          const detail = await api<StoredTask>("ai.task", {
                            id: task.id,
                          });
                          setSelected({
                            ...detail,
                            record: {
                              ...detail.record,
                              bookTitle: task.bookTitle,
                            },
                          });
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <span>
                        <strong>
                          {scope === "all" && task.bookTitle
                            ? `${task.bookTitle} · `
                            : ""}
                          {task.chapterTitle || "未绑定章节"}
                        </strong>
                        <small>
                          {new Date(task.startedAt).toLocaleString("zh-CN")} ·{" "}
                          {task.model}
                        </small>
                      </span>
                      <span
                        className={`task-status task-status-${task.status}`}
                      >
                        {statusLabels[task.status] || task.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-note">当前范围没有更多写作任务。</p>
            )}
            <div className="modal-actions">
              <button
                disabled={loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                上一页任务
              </button>
              <span className="muted">第 {offset / 100 + 1} 页</span>
              <button
                disabled={loading || tasks.length < 100}
                onClick={() => setOffset(offset + 100)}
              >
                下一页任务
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
