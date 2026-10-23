import React, { useEffect, useState } from "react";
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
    [choices, setChoices] = useState<{ id: string; title: string }[]>([]),
    [query, setQuery] = useState(""),
    [refresh, setRefresh] = useState(0),
    [pack, setPack] = useState<MaterialContext | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api<{ items: typeof choices }>("materials.list", {
        bookId,
        options: { query },
      })
        .then((value) => {
          if (active) setChoices(value.items);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bookId, query, refresh]);
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
        仅发送明确选择的资料快照。计划、已确认设定与待复核证据会保留各自标签；不会自动混入其他作品。重新生成使用本次选择。
      </p>
      <label>
        搜索参考资料
        <input
          aria-label="搜索参考资料"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
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
          </label>
        ))}
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
          移除参考：{item.title}
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
            <details key={material.id}>
              <summary>
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
