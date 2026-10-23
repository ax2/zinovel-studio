import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { TextAnchor } from "./manuscript-editor";
export type LegacyPreview = {
  owner: {
    id: string;
    title: string;
    kind: string;
    revision: number;
    diskHash: string;
  };
  eventId: string;
  eventHash: string;
  event: {
    id: string;
    statement: string;
    scope: string;
    storyTime: string;
    anchor: TextAnchor;
    chapterId: string;
    status: string;
  };
};
type Result = {
  items: {
    ownerId: string;
    ownerTitle: string;
    ownerDeleted: boolean;
    event: LegacyPreview["event"];
  }[];
  total: number;
  offset: number;
  errors: string[];
};
const scopes: Record<string, string> = {
  world: "世界记录",
  reader: "读者",
  character: "所属人物",
};
export function LegacyKnowledgePanel({
  bookId,
  disabled,
  onSelect,
}: {
  bookId: string;
  disabled: boolean;
  onSelect: (ownerId: string, eventId: string) => void;
}) {
  const [sessionId] = useState(() => crypto.randomUUID()),
    request = useRef(0);
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<Result | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const requestId = ++request.current;
    setLoading(true);
    setError("");
    const timer = setTimeout(
      () =>
        api<Result>("knowledge.legacy-list", {
          bookId,
          sessionId,
          requestId,
          options: { query, offset },
        })
          .then((value) => {
            if (active) {
              if (value.total && value.offset >= value.total) {
                setOffset(Math.floor((value.total - 1) / 40) * 40);
                return;
              }
              setResult(value);
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setLoading(false);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      void api("knowledge.legacy-cancel", { sessionId, requestId }).catch(
        () => {},
      );
    };
  }, [bookId, query, offset]);
  return (
    <section aria-label="旧认知整理">
      <p>
        先从矩阵为命题开始新记录，再带入旧认知，核对范围与状态并选择当前正文依据。原资料和事件保持不变。
      </p>
      <label>
        搜索旧认知
        <input
          aria-label="搜索旧认知"
          maxLength={200}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <p role="status">
        {loading ? "正在读取旧认知…" : `共 ${result?.total || 0} 条旧认知`}
      </p>
      {result?.errors.map((text, i) => (
        <p role="alert" key={i}>
          {text}
        </p>
      ))}
      {result?.items.map((item) => (
        <article key={`${item.ownerId}.${item.event.id}`}>
          <b>
            {item.ownerTitle} · {scopes[item.event.scope]}
          </b>
          <p>{item.event.statement}</p>
          <p>
            {item.event.storyTime || "未标故事时间"}
            {item.ownerDeleted ? " · 资料已删除" : ""}
            {item.event.status === "retired" ? " · 已停用" : ""}
          </p>
          <button
            disabled={
              disabled ||
              loading ||
              item.ownerDeleted ||
              item.event.status !== "active"
            }
            onClick={() => onSelect(item.ownerId, item.event.id)}
          >
            带入此旧认知
          </button>
        </article>
      ))}
      <button
        disabled={loading || !result?.offset}
        onClick={() => setOffset(Math.max(0, offset - 40))}
      >
        上一页旧认知
      </button>
      <span>第 {Math.floor((result?.offset || 0) / 40) + 1} 页</span>
      <button
        disabled={loading || !result || result.offset + 40 >= result.total}
        onClick={() => setOffset(offset + 40)}
      >
        下一页旧认知
      </button>
    </section>
  );
}
