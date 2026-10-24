import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { registerEditorCloseGuard } from "./editor-close-guards";

type Snapshot = {
  runtime: {
    app: string;
    electron: string;
    node: string;
    platform: string;
    arch: string;
  };
  events: unknown[];
  discarded: number;
};
export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmClear, setConfirmClear] = useState(false);
  const pending = useRef(false),
    alive = useRef(true);
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
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void operation(async () =>
      setSnapshot(await api<Snapshot>("diagnostics.get")),
    );
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      registerEditorCloseGuard(() => {
        if (!pending.current) return true;
        setNotice("请等待诊断操作完成，再关闭程序。");
        return false;
      }),
    [],
  );
  function close() {
    if (pending.current) {
      setNotice("请先完成或取消文件选择，再关闭诊断。");
      return;
    }
    onClose();
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal diagnostics-panel"
        role="dialog"
        aria-modal="true"
        aria-label="故障诊断"
      >
        <div className="modal-heading">
          <h2>故障诊断</h2>
          <button aria-label="关闭故障诊断" onClick={close}>
            关闭
          </button>
        </div>
        <p>
          只保留本次程序会话最近200条操作元数据，退出后清空，不会自动上传。时间与操作类型仍反映使用活动，分享前请查看预览。
        </p>
        <p className="muted">
          不收集正文、提示词、候选、书名、作品或任务ID、路径、模型地址、Key、原始异常或堆栈。AI私有任务与上游会话存档不属于此诊断包。
        </p>
        <p className="muted">
          这里记录宿主调用的返回结果；备份等后台任务的最终状态请在对应窗口查看。
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {snapshot && (
          <>
            <p>
              当前保留{snapshot.events.length}条；更早{snapshot.discarded}
              条已丢弃。版本{snapshot.runtime.app} · {snapshot.runtime.platform}
              /{snapshot.runtime.arch}
            </p>
            <pre aria-label="诊断内容预览">
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </>
        )}
        <div className="diagnostics-actions">
          <button
            disabled={busy}
            onClick={() =>
              void operation(async () =>
                setSnapshot(await api<Snapshot>("diagnostics.get")),
              )
            }
          >
            刷新诊断
          </button>
          <button
            className="primary"
            disabled={busy || !snapshot}
            onClick={() =>
              void operation(async () => {
                const result = await api<{
                  cancelled?: true;
                  path: string;
                  events: number;
                }>("diagnostics.export");
                if (result.cancelled) setNotice("已取消导出，未写入诊断文件。");
                else setNotice(`已导出${result.events}条到：${result.path}`);
              })
            }
          >
            导出为新文件
          </button>
          <button
            disabled={busy || !snapshot}
            onClick={() => setConfirmClear(true)}
          >
            清空会话记录
          </button>
        </div>
        <p className="muted">
          导出仅创建新的JSON文件，不覆盖已有文件，不允许写入应用数据目录。文件只包含白名单元数据；不改变原稿或删除AI任务。
        </p>
        {confirmClear && (
          <div role="group" aria-label="确认清空诊断">
            <p>清空当前会话的诊断元数据？作品与任务保持不变。</p>
            <button
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  setSnapshot(await api<Snapshot>("diagnostics.clear"));
                  setConfirmClear(false);
                  setNotice("本次会话记录已清空。");
                })
              }
            >
              确认清空诊断
            </button>
            <button disabled={busy} onClick={() => setConfirmClear(false)}>
              保留诊断
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
