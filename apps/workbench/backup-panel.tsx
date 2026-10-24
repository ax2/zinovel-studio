import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import { registerEditorCloseGuard } from "./editor-close-guards";

type Snapshot = {
  id: string;
  hash: string;
  createdAt: string;
  files: number;
  logicalBytes: number;
};
type Selection = {
  token: string;
  path: string;
  canCapture: boolean;
  snapshots: Snapshot[];
  total: number;
  page: number;
  pages: number;
  errors: { message: string }[];
  validation: string;
};
type Job = {
  id: string;
  status: string;
  progress: { copiedBytes?: number } | null;
  error: string | null;
  result: {
    copiedBytes: number;
    logicalBytes: number;
    files: number;
    lockReleaseFailed?: boolean;
    notificationFailed?: boolean;
  } | null;
};
const labels: Record<string, string> = {
  capturing: "准备备份",
  scanning: "读取完整目录",
  copying: "写入新增内容",
  verifying: "核对源文件与备份",
  committing: "保存备份版本",
  cancelling: "正在取消",
  completed: "备份完成",
  failed: "备份未完成",
  cancelled: "已取消",
};
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(2)} MiB`;
const timestamp = (value: string) => {
  const date = new Date(value);
  return `${date.toLocaleString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
};

export function BackupPanel({
  book,
  onClose,
  onRestored,
}: {
  book: Book;
  onClose: () => void;
  onRestored: (book: Book) => Promise<void>;
}) {
  const [selection, setSelection] = useState<Selection | null>(null),
    [job, setJob] = useState<Job | null>(null),
    [jobId, setJobId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<Snapshot | null>(null),
    [confirming, setConfirming] = useState(false);
  const alive = useRef(true),
    pending = useRef(false),
    runningJob = useRef<string | null>(null);
  const close = () => {
    if (pending.current) {
      setNotice("备份或恢复仍在进行，请先取消备份或等待完成，再关闭窗口。");
      return false;
    }
    onClose();
    return true;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      registerEditorCloseGuard(() => {
        if (!pending.current) return true;
        setNotice("备份或恢复仍在进行，请等待完成或先取消备份，再退出程序。");
        return false;
      }),
    [],
  );
  function adopt(next: Selection) {
    setSelection(next);
    setSelected(null);
    setConfirming(false);
  }
  async function operation(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (!runningJob.current) {
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function choose(create: boolean) {
    await operation(async () => {
      const value = await api<Selection | { id: string } | { cancelled: true }>(
        create ? "backup.choose" : "backup.open",
        { bookId: book.id },
      );
      if (!alive.current) return;
      if ("cancelled" in value) {
        setNotice("未选择目录，已有备份不变。");
        return;
      }
      if ("id" in value) {
        runningJob.current = value.id;
        setJob(null);
        setJobId(value.id);
      } else adopt(value);
    });
  }
  useEffect(() => {
    if (!jobId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    pending.current = true;
    setBusy(true);
    const poll = async () => {
      try {
        const value = await api<Job>("backup.status", {
          bookId: book.id,
          id: jobId,
        });
        if (!active) return;
        setJob(value);
        if (["completed", "failed", "cancelled"].includes(value.status)) {
          if (value.status === "completed") {
            setNotice(
              `已保存完整备份版本：本次新增内容${bytes(value.result?.copiedBytes || 0)}，不含版本清单。`,
            );
            if (value.result?.lockReleaseFailed)
              setError(
                "备份版本已保存，但写入锁释放异常；请保留备份库并退出程序后重试。",
              );
            try {
              const next = await api<Selection>("backup.result", {
                bookId: book.id,
                id: jobId,
              });
              if (active) adopt(next);
            } catch (e) {
              if (active)
                setError(
                  `备份版本已保存，但列表未能打开：${(e as Error).message}`,
                );
            }
          } else if (value.status === "failed")
            setError(value.error || "备份未完成，旧版本已保留。");
          else
            setNotice(
              "本次已取消，未增加备份版本；旧版本保留，未完成内容可由下次备份复用。",
            );
          if (active) {
            runningJob.current = null;
            pending.current = false;
            setBusy(false);
            setJobId(null);
          }
          return;
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setNotice(
            "任务状态暂时无法读取，仍保留备份任务；可重试取消或等待状态恢复。",
          );
        }
      }
      if (active) timer = setTimeout(poll, 250);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, book.id]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal backup-panel"
        role="dialog"
        aria-modal="true"
        aria-label="增量备份与恢复"
      >
        <div className="modal-heading">
          <div>
            <h2>增量备份与恢复</h2>
            <p>当前作品：{book.title}</p>
          </div>
          <button aria-label="关闭增量备份" onClick={close}>
            关闭
          </button>
        </div>
        <p className="muted">
          每次保存完整版本，只新增变化的内容。备份库必须整体保留或搬移；不要只复制其中一个版本文件。重要稿件请选择书库外、不同物理磁盘的位置。
        </p>
        <p className="muted">
          包含作品内正文、资料、历史和原图；不含全局AI任务、模型Key及本机编辑草稿。原有“备份整部作品”仍可创建单代完整独立副本。
        </p>
        <div className="backup-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void choose(true)}
          >
            选择位置并备份当前作品
          </button>
          <button disabled={busy} onClick={() => void choose(false)}>
            打开已有备份库
          </button>
          <button
            disabled={busy || !selection?.canCapture}
            onClick={() =>
              void operation(async () => {
                const value = await api<{ id: string }>("backup.append", {
                  bookId: book.id,
                  token: selection!.token,
                });
                runningJob.current = value.id;
                setJob(null);
                setJobId(value.id);
              })
            }
          >
            追加备份
          </button>
          <button
            disabled={busy || !selection}
            onClick={() =>
              void operation(async () =>
                adopt(
                  await api<Selection>("backup.refresh", {
                    bookId: book.id,
                    token: selection!.token,
                  }),
                ),
              )
            }
          >
            刷新版本
          </button>
        </div>
        {jobId && (
          <div className="backup-progress" role="status">
            <strong>{labels[job?.status || "capturing"] || "正在备份"}</strong>
            <span>已新增内容 {bytes(job?.progress?.copiedBytes || 0)}</span>
            <button
              disabled={
                job?.status === "committing" || job?.status === "cancelling"
              }
              onClick={() => {
                void api<{ cancelled: boolean }>("backup.cancel", {
                  bookId: book.id,
                  id: jobId,
                })
                  .then((value) => {
                    if (!value.cancelled)
                      setNotice("版本已经进入保存阶段，请等待完成。");
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              取消本次备份
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="backup-notice">
            {notice}
          </p>
        )}
        {selection ? (
          <>
            <p className="backup-path">备份库：{selection.path}</p>
            {!selection.canCapture && (
              <p>此备份库属于其他作品，可以恢复为新书，不能追加当前作品。</p>
            )}
            <p className="muted">
              {selection.validation}
              。共享内容损坏可能影响多个版本，请另保留独立副本。
            </p>
            {selection.errors.length > 0 && (
              <p role="alert">
                有{selection.errors.length}
                个清单损坏或版本不支持，原文件保留，不出现在可选列表。
              </p>
            )}
            <div
              className="backup-version-list"
              role="group"
              aria-label="备份版本列表"
            >
              {selection.snapshots.map((item) => (
                <label
                  key={item.id}
                  className={selected?.id === item.id ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="backup-version"
                    disabled={busy}
                    checked={selected?.id === item.id}
                    onChange={() => {
                      setSelected(item);
                      setConfirming(false);
                    }}
                  />
                  <span>
                    {timestamp(item.createdAt)}
                    <small>
                      {item.files}个文件 · 完整大小{bytes(item.logicalBytes)}
                    </small>
                  </span>
                </label>
              ))}
              {!selection.total && <p>还没有已提交的备份版本。</p>}
            </div>
            <div className="backup-pagination">
              <button
                disabled={busy || selection.page === 0}
                onClick={() =>
                  void operation(async () =>
                    adopt(
                      await api<Selection>("backup.page", {
                        bookId: book.id,
                        token: selection.token,
                        page: selection.page - 1,
                      }),
                    ),
                  )
                }
              >
                上一页版本
              </button>
              <span>
                第{selection.page + 1}/{selection.pages}页 · 共{selection.total}
                个版本
              </span>
              <button
                disabled={busy || selection.page + 1 >= selection.pages}
                onClick={() =>
                  void operation(async () =>
                    adopt(
                      await api<Selection>("backup.page", {
                        bookId: book.id,
                        token: selection.token,
                        page: selection.page + 1,
                      }),
                    ),
                  )
                }
              >
                下一页版本
              </button>
            </div>
            {!confirming ? (
              <button
                disabled={busy || !selected}
                onClick={() => setConfirming(true)}
              >
                恢复所选版本
              </button>
            ) : (
              <div
                className="backup-confirm"
                role="group"
                aria-label="确认恢复"
              >
                <p>
                  将{selected && timestamp(selected.createdAt)}
                  的完整备份恢复成新作品。当前作品与备份库都不会被覆盖。
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      const value = await api<{ book: Book }>(
                        "backup.restore",
                        {
                          bookId: book.id,
                          token: selection.token,
                          id: selected!.id,
                          hash: selected!.hash,
                        },
                      );
                      pending.current = false;
                      await onRestored(value.book);
                    })
                  }
                >
                  确认恢复为新作品
                </button>
                <button disabled={busy} onClick={() => setConfirming(false)}>
                  返回版本列表
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="backup-empty">
            先选择位置创建备份，或打开已有备份库查看历史版本。
          </div>
        )}
      </section>
    </div>
  );
}
