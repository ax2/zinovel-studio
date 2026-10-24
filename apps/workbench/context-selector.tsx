import React, { useEffect, useState, useRef } from "react";
import { api } from "./api";
export type MaterialContext = {
  schemaVersion: number;
  bookId: string;
  hash: string;
  characters: number;
  truncated: false;
  materials: {
    id: string;
    title: string;
    kind: string;
    revision: number;
    diskHash: string;
    content: string;
  }[];
};
export type ContextSelection = {
  ready: boolean;
  ids: string[];
  pack: MaterialContext | null;
};
export function ContextSelector({
  bookId,
  disabled,
  onChange,
}: {
  bookId: string;
  disabled: boolean;
  onChange: (selection: ContextSelection) => void;
}) {
  const [selected, setSelected] = useState<{ id: string; title: string }[]>([]),
    [choices, setChoices] = useState<
      { id: string; title: string; unavailable?: boolean }[]
    >([]),
    [kind, setKind] = useState("material"),
    [offset, setOffset] = useState(0),
    [listing, setListing] = useState<{
      total: number;
      offset: number;
      errors: string[];
    } | null>(null),
    [listBusy, setListBusy] = useState(false),
    [listError, setListError] = useState(""),
    [query, setQuery] = useState(""),
    [refresh, setRefresh] = useState(0),
    [listRevision, setListRevision] = useState(0),
    [pack, setPack] = useState<MaterialContext | null>(null),
    [error, setError] = useState("");
  const [sessionId] = useState(() => crypto.randomUUID());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const nextQuery = useRef(0);
  useEffect(() => {
    const changed = (event: Event) => {
      const changedBook = (event as CustomEvent<{ bookId?: string }>).detail
        ?.bookId;
      if (!changedBook || changedBook === bookId)
        setListRevision((value) => value + 1);
    };
    window.addEventListener("novel-reference-options-changed", changed);
    return () =>
      window.removeEventListener("novel-reference-options-changed", changed);
  }, [bookId]);
  useEffect(() => {
    let active = true;
    const requestId = ++nextQuery.current;
    setListBusy(true);
    setListError("");
    const timer = setTimeout(() => {
      api<{
        items: typeof choices;
        total: number;
        offset: number;
        errors: string[];
      }>("context.choices", {
        bookId,
        sessionId,
        requestId,
        options: { query, kind, offset },
      })
        .then((value) => {
          if (active) {
            if (value.total && value.offset >= value.total) {
              setOffset(Math.floor((value.total - 1) / 40) * 40);
              return;
            }
            setChoices(value.items);
            setListing(value);
          }
        })
        .catch((e) => {
          if (active) setListError(e.message);
        })
        .finally(() => {
          if (active) setListBusy(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
      void api("context.cancel", { sessionId, requestId }).catch(() => {});
    };
  }, [bookId, query, refresh, kind, offset, sessionId, listRevision]);
  useEffect(() => {
    let active = true;
    const ids = selected.map((item) => item.id);
    setError("");
    setPack(null);
    if (!ids.length) {
      onChange({ ready: true, ids: [], pack: null });
      return;
    }
    onChange({ ready: false, ids, pack: null });
    api<MaterialContext>("materials.context", { bookId, materialIds: ids })
      .then((value) => {
        if (active) {
          setPack(value);
          onChange({ ready: true, ids, pack: value });
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [bookId, selected, refresh, onChange]);
  return (
    <details className="context-selector">
      <summary>本次参考资料 · 已选 {selected.length}/8</summary>
      <p className="muted">
        仅发送明确选择的资料、认知或作者选择，总共最多8份。认知包含范围、状态、命题含义与本条正文引文，不附带未选作者真相设置、其他认知或旧资料全文；计划、相信和怀疑不等于事实。重新生成使用本次选择。
      </p>
      <label>
        参考资料类型
        <select
          aria-label="参考资料类型"
          disabled={disabled}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
          }}
        >
          <option value="material">资料卡</option>
          <option value="knowledge">认知事件</option>
          <option value="choice">作者当前选择</option>
        </select>
      </label>
      <label>
        搜索参考资料
        <input
          aria-label="搜索参考资料"
          value={query}
          maxLength={200}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
          disabled={disabled}
        />
      </label>
      <div className="context-choices">
        {choices.map((item) => (
          <label className="inline-check" key={item.id}>
            <input
              type="checkbox"
              disabled={
                disabled ||
                listBusy ||
                item.unavailable ||
                (selected.length >= 8 &&
                  !selected.some((value) => value.id === item.id))
              }
              checked={selected.some((value) => value.id === item.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, item]
                    : selected.filter((value) => value.id !== item.id),
                )
              }
            />
            {item.title}
            {item.unavailable && "（来源失联或不可读取）"}
          </label>
        ))}
      </div>
      <p role="status">
        {listBusy
          ? "正在读取参考资料…"
          : `共 ${listing?.total || 0} 份可选参考`}
      </p>
      {listError && (
        <p role="alert" className="inline-error">
          {listError}
        </p>
      )}
      {listing?.errors.map((text, i) => (
        <p role="alert" className="inline-error" key={i}>
          {text}
        </p>
      ))}
      <div>
        <button
          disabled={disabled || listBusy || !listing?.offset}
          onClick={() => setOffset(Math.max(0, offset - 40))}
        >
          上一页参考
        </button>
        <span>第 {Math.floor((listing?.offset || 0) / 40) + 1} 页</span>
        <button
          disabled={
            disabled ||
            listBusy ||
            !listing ||
            listing.offset + 40 >= listing.total
          }
          onClick={() => setOffset(offset + 40)}
        >
          下一页参考
        </button>
      </div>
      {!choices.length && (
        <p className="muted">没有匹配资料，可先在资料卡中创建并保存。</p>
      )}
      {selected.map((item) => (
        <button
          key={item.id}
          disabled={disabled}
          onClick={() =>
            setSelected(selected.filter((value) => value.id !== item.id))
          }
        >
          移除参考：
          {pack?.materials.find((entry) => entry.id === item.id)?.title ??
            item.title}
        </button>
      ))}
      <button
        disabled={disabled}
        onClick={() => setRefresh((value) => value + 1)}
      >
        刷新资料快照
      </button>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {pack && (
        <div aria-label="将发送的资料快照">
          <p className="muted">
            {pack.materials.length} 份 · {pack.characters} 字符 ·
            无截断；正文与资料合计执行上下文预算。
          </p>
          {pack.materials.map((material) => (
            <details key={material.id} open={expanded.has(material.id)}>
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setExpanded((before) => {
                    const next = new Set(before);
                    if (next.has(material.id)) next.delete(material.id);
                    else next.add(material.id);
                    return next;
                  });
                }}
              >
                {material.title} · 版本 {material.revision}
              </summary>
              <article className="context-prose">{material.content}</article>
            </details>
          ))}
        </div>
      )}
    </details>
  );
}
