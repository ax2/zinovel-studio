import React, { useEffect, useState } from "react";
import { api, type Book } from "./api";
import type { Evidence } from "./material-evidence";
import type { TextAnchor } from "./manuscript-editor";
import { evidenceKinds } from "../../packages/novel-domain/evidence.mjs";
import { orderedChapters } from "../../packages/novel-domain/structure.mjs";

type Row = Evidence & {
  key: string;
  ownerId: string;
  ownerTitle: string;
  ownerKind: string;
  ownerRevision: number;
  ownerDeleted: boolean;
  condition: string;
  chapterOrder: number | null;
};
type Result = {
  items: Row[];
  total: number;
  counts: Record<string, number>;
  errors: string[];
  scannedSources: number;
  completedAt: string;
};
const scopes: Record<string, string> = {
  world: "世界记录",
  reader: "读者已知",
  character: "所属人物已知",
};
const states: Record<string, string> = {
  current: "有效",
  stale: "待复核",
  missing: "来源缺失",
  retired: "已停用",
  deleted: "资料已删除",
};

export function ContinuityWorkbench({
  book,
  onClose,
  onEdit,
  onChapter,
}: {
  book: Book;
  onClose: () => void;
  onEdit: (id: string) => void;
  onChapter: (id: string, anchor: TextAnchor) => Promise<void>;
}) {
  const [kind, setKind] = useState(""),
    [scope, setScope] = useState(""),
    [state, setState] = useState(""),
    [chapterId, setChapterId] = useState(""),
    [query, setQuery] = useState(""),
    [owner, setOwner] = useState<{ id: string; title: string } | null>(null),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0),
    [result, setResult] = useState<Result | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    const timer = setTimeout(() => {
      api<Result>("continuity.query", {
        bookId: book.id,
        options: {
          kind,
          scope,
          state,
          chapterId,
          query,
          ownerId: owner?.id || "",
          offset,
        },
      })
        .then((value) => {
          if (active) setResult(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    book.id,
    kind,
    scope,
    state,
    chapterId,
    query,
    owner?.id,
    offset,
    refresh,
  ]);
  const filter = (change: () => void) => {
    change();
    setOffset(0);
  };
  const locked = busy || !!error;
  return (
    <div className="modal-backdrop">
      <section
        className="modal continuity-workbench"
        role="dialog"
        aria-modal="true"
        aria-label="全书证据"
      >
        <header>
          <div>
            <h2>全书证据</h2>
            <p>
              集中核对正文中的事实、关系、认知与伏笔。计划字段不作为已写事实。
            </p>
          </div>
          <button aria-label="关闭全书证据" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="continuity-filters">
          <label>
            查找证据
            <input
              aria-label="查找证据"
              value={query}
              maxLength={200}
              placeholder="人物、说明、原引文或关联资料"
              onChange={(e) => filter(() => setQuery(e.target.value))}
            />
          </label>
          <label>
            事件类型
            <select
              aria-label="事件类型"
              value={kind}
              onChange={(e) => filter(() => setKind(e.target.value))}
            >
              <option value="">全部事件</option>
              {evidenceKinds.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            知情范围
            <select
              aria-label="知情范围"
              value={scope}
              onChange={(e) => filter(() => setScope(e.target.value))}
            >
              <option value="">全部范围</option>
              {Object.entries(scopes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            有效状态
            <select
              aria-label="有效状态"
              value={state}
              onChange={(e) => filter(() => setState(e.target.value))}
            >
              <option value="">全部状态</option>
              {Object.entries(states).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            来源章节
            <select
              aria-label="来源章节"
              value={chapterId}
              onChange={(e) => filter(() => setChapterId(e.target.value))}
            >
              <option value="">全部章节</option>
              {orderedChapters(book).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setRefresh((n) => n + 1)} disabled={busy}>
            刷新证据
          </button>
        </div>
        {owner && (
          <p>
            只看资料：{owner.title}{" "}
            <button onClick={() => filter(() => setOwner(null))}>
              查看全部资料
            </button>
          </p>
        )}
        {error && (
          <p className="alert error" role="alert">
            {error}。请刷新；此前结果不能用于操作。
          </p>
        )}
        <p role="status" aria-live="polite">
          {busy
            ? "正在核对正文与关联资料…"
            : result
              ? `共 ${result.total} 条符合筛选的证据`
              : "尚未读取"}
        </p>
        {result && (
          <>
            <p className="muted">
              状态统计（应用其余筛选）：
              {Object.entries(states)
                .map(([key, label]) => `${label} ${result.counts[key] || 0}`)
                .join(" · ")}
            </p>
            {!!result.errors.length && (
              <details className="alert">
                <summary>
                  {result.errors.length} 份资料未能读取，结果可能不完整
                </summary>
                {result.errors.map((message, index) => (
                  <p key={index}>{message}</p>
                ))}
              </details>
            )}
            <p className="muted">
              按资料及记录顺序分页，不推断故事先后。故事时间保留作者原文；叙述章序单独标示。刷新会重新核对，跨页扫描期间的编辑可能改变结果。
            </p>
            <div className="continuity-table-wrap">
              <table aria-label="正文证据记录">
                <thead>
                  <tr>
                    <th>所属资料</th>
                    <th>事件与依据</th>
                    <th>时间与来源</th>
                    <th>范围与状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((row) => (
                    <tr key={row.key}>
                      <td data-label="所属资料">
                        <strong>{row.ownerTitle}</strong>
                        <p>资料版本 {row.ownerRevision}</p>
                        {row.ownerDeleted && <p>已删除，证据仍保留</p>}
                      </td>
                      <td data-label="事件与依据">
                        <strong>
                          {evidenceKinds.find((item) => item.id === row.kind)
                            ?.label || row.kind}
                        </strong>
                        <p className="continuity-statement">{row.statement}</p>
                        <details>
                          <summary>原始正文引文</summary>
                          <blockquote>{row.anchor.quote}</blockquote>
                        </details>
                        {!!row.related.length && (
                          <details>
                            <summary>关联资料（{row.related.length}）</summary>
                            {row.related.map((item) => (
                              <p key={item.id}>
                                {item.title} ·{" "}
                                {item.state === "active"
                                  ? states[item.freshness] || "版本未知"
                                  : item.state === "deleted"
                                    ? "已删除"
                                    : "失联"}
                              </p>
                            ))}
                          </details>
                        )}
                      </td>
                      <td data-label="时间与来源">
                        <p>故事时间：{row.storyTime || "未填写"}</p>
                        <p>叙述章序：{row.chapterOrder ?? "不在当前目录"}</p>
                        <p>{row.chapterTitle}</p>
                      </td>
                      <td data-label="范围与状态">
                        <strong>{scopes[row.scope]}</strong>
                        <p
                          className={
                            row.condition === "current"
                              ? ""
                              : "continuity-warning"
                          }
                        >
                          {states[row.condition]}
                        </p>
                        {row.scope === "character" && (
                          <p>人物：{row.ownerTitle}</p>
                        )}
                        <p>正文：{states[row.sourceFreshness] || "未知"}</p>
                      </td>
                      <td data-label="操作">
                        <div className="continuity-actions">
                          <button
                            disabled={locked}
                            onClick={() => onEdit(row.ownerId)}
                          >
                            打开资料
                          </button>
                          <button
                            disabled={locked}
                            onClick={() =>
                              filter(() =>
                                setOwner({
                                  id: row.ownerId,
                                  title: row.ownerTitle,
                                }),
                              )
                            }
                          >
                            只看此资料
                          </button>
                          <button
                            disabled={locked || row.chapterOrder === null}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await onChapter(row.chapterId, row.anchor);
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            查看正文依据
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.items.length && (
              <p>没有符合筛选的已记录证据；这不表示故事中不存在相关事实。</p>
            )}
            <nav aria-label="证据分页" className="continuity-pagination">
              <button
                disabled={locked || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 40))}
              >
                上一页证据
              </button>
              <span>
                {result.total
                  ? `${offset + 1}–${Math.min(offset + 40, result.total)} / ${result.total}`
                  : "0 条"}
              </span>
              <button
                disabled={locked || offset + 40 >= result.total}
                onClick={() => setOffset(offset + 40)}
              >
                下一页证据
              </button>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}
