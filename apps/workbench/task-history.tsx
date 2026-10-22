import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, RefreshCw } from "lucide-react";
import { api } from "./api";
import type { WritingSnapshot } from "./assistant";

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
  chapterId?: string;
  chapterTitle?: string;
  skillId: string;
  status: string;
  startedAt: string;
  model: string;
  hasCandidate: boolean;
};
export type StoredTask = {
  record: TaskSummary & {
    candidate?: string;
    acceptedText?: string;
    partialCandidate?: boolean;
    acceptance?: { acceptedText: string };
    acceptanceRecovery?: string;
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
}: {
  bookId: string;
  onClose: () => void;
  onReview: (task: StoredTask) => void;
  openChapter: (id: string) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]),
    [selected, setSelected] = useState<StoredTask | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setTasks(await api("ai.tasks", { bookId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [bookId]);
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
                这是中断前已保存的部分结果，仅供查看和复制；任务没有正常完成。
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
              {selected.record.chapterId && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await openChapter(selected.record.chapterId!);
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
              {selected.record.status === "awaiting-review" &&
                selected.record.candidate &&
                selected.snapshot.target && (
                  <button
                    className="primary"
                    onClick={() => onReview(selected)}
                  >
                    继续审阅
                  </button>
                )}
            </div>
          </>
        ) : (
          <>
            <div className="task-list-heading">
              <span className="muted">本书最近 100 个任务</span>
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
                          setSelected(await api("ai.task", { id: task.id }));
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <span>
                        <strong>{task.chapterTitle || "未绑定章节"}</strong>
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
              <p className="empty-note">这部作品还没有写作任务。</p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
