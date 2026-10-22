import React, { useState } from "react";
import { mergeThreeWay } from "../../packages/novel-domain/merge.mjs";
export function ConflictDialog({
  base,
  local,
  remote,
  localTitle,
  remoteTitle,
  onResolve,
  onReload,
}: {
  base: string | null;
  local: string;
  remote: string;
  localTitle: string;
  remoteTitle: string;
  onResolve: (body: string, title: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [proposal] = useState(() => mergeThreeWay(base, local, remote));
  const [body, setBody] = useState(proposal.body),
    [title, setTitle] = useState(localTitle);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function accept(text: string, name: string) {
    setBusy(true);
    setError("");
    try {
      await onResolve(text, name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal merge-modal"
        role="dialog"
        aria-modal="true"
        aria-label="三方合并正文"
      >
        <h2>正文已在其他地方修改</h2>
        <p className="muted">
          确认前先保存两侧和共同基线的独立副本，可在历史版本中恢复。
        </p>
        <div className="conflict-columns three-way">
          <section>
            <h3>共同基线</h3>
            <pre>
              {base === null ? "此缓存未保留共同基线，无法自动合并。" : base}
            </pre>
          </section>
          <section>
            <h3>磁盘稿</h3>
            <pre>{remote}</pre>
          </section>
          <section>
            <h3>当前编辑</h3>
            <pre>{local}</pre>
          </section>
        </div>
        <p className={proposal.automatic ? "muted" : "inline-error"}>
          {proposal.reason}。确认前仍可手动调整。
        </p>
        <label>
          合并后的章节标题
          <input
            aria-label="合并后的章节标题"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          合并稿
          <textarea
            aria-label="三方合并稿"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
          />
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onReload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            重新读取磁盘稿
          </button>
          <button disabled={busy} onClick={() => accept(remote, remoteTitle)}>
            使用磁盘稿
          </button>
          <button disabled={busy} onClick={() => accept(local, localTitle)}>
            保留当前编辑
          </button>
          <button
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() => accept(body, title)}
          >
            接受合并稿
          </button>
        </div>
      </div>
    </div>
  );
}
