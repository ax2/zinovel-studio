import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api";
import type { WritingSnapshot } from "./assistant";

type Marker = {
  id: string;
  kind: "note" | "bookmark" | "scene";
  title: string;
  text: string;
  anchor: { quote: string };
  resolved: boolean;
  deletedAt?: string;
  location: {
    status: "exact" | "relocated" | "missing" | "ambiguous";
    start: number | null;
    end: number | null;
  };
};
type Markers = {
  revision: number;
  bodyHash: string;
  metadataHash: string | null;
  items: Marker[];
};
const kinds = { note: "批注", bookmark: "书签", scene: "场景" };
const locations = {
  exact: "原位有效",
  relocated: "已重新定位",
  missing: "原文已改变，需重新绑定",
  ambiguous: "存在重复位置，需重新绑定",
};

export function AnnotationsDialog({
  snapshot,
  onClose,
  onLocate,
}: {
  snapshot: WritingSnapshot & { hash: string };
  onClose: () => void;
  onLocate: (range: { start: number; end: number }) => void;
}) {
  const [data, setData] = useState<Markers | null>(null),
    [error, setError] = useState("");
  const [kind, setKind] = useState<Marker["kind"]>("note"),
    [title, setTitle] = useState(""),
    [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null),
    [trash, setTrash] = useState(false),
    [busy, setBusy] = useState(false);
  const payload = { bookId: snapshot.bookId, chapterId: snapshot.chapterId };
  async function refresh() {
    setData(await api<Markers>("annotations.read", payload));
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function mutate(mutation: object) {
    if (!data || busy) return false;
    if (data.bodyHash !== snapshot.hash) {
      setError(
        "磁盘正文与编辑器不同，请关闭窗口并重新打开章节后再添加或绑定标记。",
      );
      return false;
    }
    setBusy(true);
    setError("");
    try {
      await api("annotations.mutate", {
        ...payload,
        expectedRevision: data.revision,
        expectedMetadataHash: data.metadataHash,
        expectedBodyHash: data.bodyHash,
        mutation,
      });
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const selectionLength = snapshot.end - snapshot.start;
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal"
        role="dialog"
        aria-modal="true"
        aria-label="批注书签与场景"
      >
        <div className="modal-heading">
          <h2>批注、书签与场景</h2>
          <button aria-label="关闭批注" disabled={busy} onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          当前章节 · 选中 {selectionLength} 字符。标记独立保存，正文仍是原始
          Markdown。
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="annotation-layout">
          <section className="annotation-form">
            <h3>{editing ? "编辑标记" : "新增标记"}</h3>
            <label>
              类型
              <select
                aria-label="标记类型"
                value={kind}
                disabled={!!editing || busy}
                onChange={(e) => setKind(e.target.value as Marker["kind"])}
              >
                {Object.entries(kinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              标题
              <input
                aria-label="标记标题"
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              说明
              <textarea
                aria-label="标记说明"
                maxLength={20000}
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="修改意见、回访原因，或场景目标与转折"
              />
            </label>
            <p className="muted">
              {selectionLength
                ? `引用：${snapshot.body.slice(snapshot.start, Math.min(snapshot.end, snapshot.start + 100))}`
                : "未选中文字时，批注和书签绑定当前光标。场景需先选中正文。"}
            </p>
            <button
              className="primary"
              disabled={
                !data ||
                busy ||
                !title.trim() ||
                (!editing && kind === "scene" && !selectionLength)
              }
              onClick={async () => {
                const ok = await mutate(
                  editing
                    ? { type: "edit", id: editing, title, text }
                    : {
                        type: "create",
                        kind,
                        title,
                        text,
                        start: snapshot.start,
                        end: snapshot.end,
                      },
                );
                if (ok) {
                  setTitle("");
                  setText("");
                  setEditing(null);
                }
              }}
            >
              {editing ? "保存标记修改" : "添加标记"}
            </button>
            {editing && (
              <button
                onClick={() => {
                  setEditing(null);
                  setTitle("");
                  setText("");
                }}
              >
                取消编辑标记
              </button>
            )}
          </section>
          <section className="annotation-list">
            <div className="modal-heading">
              <h3>本章标记</h3>
              <button onClick={() => setTrash(!trash)}>
                {trash ? "显示有效标记" : "标记回收站"}
              </button>
            </div>
            {data && !data.items.some((item) => !!item.deletedAt === trash) && (
              <p className="muted">{trash ? "回收站为空" : "本章还没有标记"}</p>
            )}
            {data?.items
              .filter((item) => !!item.deletedAt === trash)
              .map((item) => (
                <article
                  key={item.id}
                  className="annotation-card"
                  data-marker-id={item.id}
                >
                  <h4>{item.title}</h4>
                  <p className="muted">
                    {kinds[item.kind]} · {locations[item.location.status]}
                    {item.resolved ? " · 已处理" : ""}
                  </p>
                  <blockquote>
                    {item.anchor.quote.slice(0, 180) || "光标位置"}
                  </blockquote>
                  {item.text && <p className="annotation-text">{item.text}</p>}
                  <div className="annotation-actions">
                    {trash ? (
                      <button
                        disabled={busy}
                        onClick={() => mutate({ type: "restore", id: item.id })}
                      >
                        恢复标记
                      </button>
                    ) : (
                      <>
                        <button
                          disabled={
                            item.location.start === null ||
                            busy ||
                            data.bodyHash !== snapshot.hash
                          }
                          onClick={() =>
                            onLocate({
                              start: item.location.start!,
                              end: item.location.end!,
                            })
                          }
                        >
                          定位正文
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setEditing(item.id);
                            setKind(item.kind);
                            setTitle(item.title);
                            setText(item.text);
                          }}
                        >
                          编辑标记
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            mutate({
                              type: "resolved",
                              id: item.id,
                              value: !item.resolved,
                            })
                          }
                        >
                          {item.resolved ? "重新打开批注" : "标为已处理"}
                        </button>
                        <button
                          disabled={
                            busy || (item.kind === "scene" && !selectionLength)
                          }
                          onClick={() =>
                            mutate({
                              type: "reanchor",
                              id: item.id,
                              start: snapshot.start,
                              end: snapshot.end,
                            })
                          }
                        >
                          绑定当前选区
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => mutate({ type: "trash", id: item.id })}
                        >
                          回收标记
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
          </section>
        </div>
      </div>
    </div>
  );
}
