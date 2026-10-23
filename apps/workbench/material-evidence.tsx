import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { evidenceKinds } from "../../packages/novel-domain/evidence.mjs";
import type { Material } from "./materials-panel";
import type { TextAnchor } from "./manuscript-editor";
export type EvidenceSource = {
  chapterId: string;
  body: string;
  hash: string;
  start: number;
  end: number;
  dirty?: boolean;
};
export type Evidence = {
  id: string;
  kind: string;
  statement: string;
  storyTime: string;
  scope: string;
  status: string;
  chapterId: string;
  chapterTitle: string;
  anchor: TextAnchor;
  freshness: string;
  sourceFreshness: string;
  resolution: { status: string; start: number | null; end: number | null };
  related: {
    id: string;
    title: string;
    state: string;
    freshness: string;
    revision?: number;
    baselineRevision: number | null;
  }[];
};
export function MaterialEvidence({
  bookId,
  material,
  source,
  disabled,
  setPending,
  updated,
  openChapter,
}: {
  bookId: string;
  material: Material;
  source: EvidenceSource | null;
  disabled: boolean;
  setPending: (pending: boolean) => void;
  updated: (value: Material) => void;
  openChapter: (id: string, anchor?: TextAnchor) => Promise<void>;
}) {
  const [kind, setKind] = useState("fact"),
    [statement, setStatement] = useState(""),
    [storyTime, setStoryTime] = useState(""),
    [scope, setScope] = useState("world"),
    [relatedIds, setRelated] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [choices, setChoices] = useState<Material[]>([]),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      api<{ items: Material[] }>("materials.list", {
        bookId,
        options: { query },
      })
        .then((result) => {
          if (active)
            setChoices(result.items.filter((item) => item.id !== material.id));
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [bookId, material.id, query]);
  const usable =
    source &&
    !source.dirty &&
    source.end > source.start &&
    source.end - source.start <= 12000;
  const checkedSource = useRef(`${source?.chapterId}:${source?.hash}`),
    onUpdated = useRef(updated);
  onUpdated.current = updated;
  useEffect(() => {
    const key = `${source?.chapterId}:${source?.hash}`;
    if (disabled || checkedSource.current === key) return;
    let active = true;
    api<Material>("materials.read", { bookId, id: material.id })
      .then((value) => {
        if (active) {
          checkedSource.current = key;
          onUpdated.current(value);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [source?.chapterId, source?.hash, disabled, bookId, material.id]);
  async function mutate(action: string, eventId?: string) {
    setPending(true);
    setError("");
    try {
      const value = await api<Material>("materials.evidence", {
        bookId,
        expected: material,
        mutation: {
          action,
          eventId,
          kind,
          statement,
          storyTime,
          scope,
          relatedIds,
          source,
        },
      });
      updated(value);
      if (action === "add") {
        setStatement("");
        setRelated([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const records = material.evidence || [],
    active = records.filter((event) => event.status === "active");
  return (
    <div className="material-evidence" aria-label="正文证据">
      <h4>正文证据与变化</h4>
      <p className="muted">
        选择已保存正文，填写说明后绑定。故事时间由作者填写；关系和认知分别记录，历史不覆盖。正文版本变化后须复核。未绑定的说明尚未保存。
      </p>
      <p>
        有效记录 {active.filter((e) => e.freshness === "current").length} ·
        待复核 {active.filter((e) => e.freshness !== "current").length} · 已停用{" "}
        {records.length - active.length}
      </p>
      {disabled && <p className="muted">请先保存资料调整，再操作证据。</p>}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <details>
        <summary>添加正文证据</summary>
        <fieldset disabled={disabled} className="material-form">
          <label>
            证据类型
            <select
              aria-label="证据类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {evidenceKinds
                .filter(
                  (k) =>
                    material.kind === "foreshadow" ||
                    !["plant", "reinforce", "payoff"].includes(k.id),
                )
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            证据说明
            <textarea
              aria-label="证据说明"
              rows={3}
              maxLength={10000}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </label>
          <label>
            故事时间
            <input
              aria-label="故事时间"
              maxLength={200}
              value={storyTime}
              onChange={(e) => setStoryTime(e.target.value)}
              placeholder="例如抵港前一天；可留空"
            />
          </label>
          <label>
            认知范围
            <select
              aria-label="认知范围"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="world">故事真相</option>
              <option value="reader">读者已知</option>
              {material.kind === "character" && (
                <option value="character">本资料人物已知</option>
              )}
            </select>
          </label>
          <label>
            关联资料检索
            <input
              aria-label="关联资料检索"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索人物或其他资料"
            />
          </label>
          <div className="material-chapters">
            {choices.map((choice) => (
              <label key={choice.id} className="inline-check">
                <input
                  type="checkbox"
                  checked={relatedIds.includes(choice.id)}
                  onChange={(e) =>
                    setRelated(
                      e.target.checked
                        ? [...relatedIds, choice.id]
                        : relatedIds.filter((id) => id !== choice.id),
                    )
                  }
                />
                {choice.title}
              </label>
            ))}
          </div>
          <p className="muted">
            当前检索最多 40 项，已选 {relatedIds.length}{" "}
            项。关系变化须关联其他资料。
          </p>
          <p>
            {usable
              ? "将绑定当前正文选区，保存前会核对正文版本。"
              : source?.dirty
                ? "正文尚未保存，请先保存再绑定证据。"
                : "请先选择一段正文（最多 1.2 万字符）"}
          </p>
          {usable && (
            <blockquote className="evidence-quote">
              {source.body.slice(source.start, source.end)}
            </blockquote>
          )}
          <button
            disabled={!usable || !statement.trim()}
            onClick={() => mutate("add")}
          >
            绑定当前选区为证据
          </button>
        </fieldset>
      </details>
      <div aria-label="证据记录">
        {records.slice(offset, offset + 20).map((event) => (
          <article key={event.id} className="evidence-card">
            <h5>
              {evidenceKinds.find((k) => k.id === event.kind)?.label} ·{" "}
              {event.status === "retired"
                ? "已停用"
                : event.freshness === "current"
                  ? "正文版本一致"
                  : event.sourceFreshness === "current"
                    ? "关联资料已变或未核对 · 待复核"
                    : "正文已变或缺失 · 待复核"}
            </h5>
            <p>{event.statement}</p>
            <p className="muted">
              故事时间：{event.storyTime || "未指定"} ·{" "}
              {event.scope === "reader"
                ? "读者已知"
                : event.scope === "character"
                  ? "本资料人物已知"
                  : "故事真相"}
            </p>
            {event.related.length > 0 && (
              <p>
                关联：
                {event.related
                  .map(
                    (r) =>
                      `${r.title}（绑定版本 ${r.baselineRevision ?? "未记录"} → 当前 ${r.revision ?? "不可读"}；${r.state !== "active" ? "已删除或不可读" : r.freshness === "current" ? "设定一致" : r.freshness === "unknown" ? "旧记录未核对" : "设定已变，待复核"}）`,
                  )
                  .join("、")}
              </p>
            )}
            <details>
              <summary>原始引文 · {event.chapterTitle}</summary>
              <blockquote className="evidence-quote">
                {event.anchor.quote}
              </blockquote>
              <p className="muted">
                定位：
                {{
                  exact: "原位匹配",
                  relocated: "已找到新位置",
                  missing: "原文缺失",
                  ambiguous: "存在多个可能位置",
                }[event.resolution.status] || "待检查"}
                ；引用为绑定时的原文，复核前不替换。
              </p>
            </details>
            <div className="material-actions">
              <button
                disabled={disabled || event.freshness === "missing"}
                onClick={() =>
                  openChapter(event.chapterId, event.anchor).catch((e) =>
                    setError(e.message),
                  )
                }
              >
                定位正文证据
              </button>
              <button
                disabled={disabled || !usable}
                onClick={() => mutate("reconfirm", event.id)}
              >
                用当前选区重新确认
              </button>
              <button
                disabled={disabled || event.status === "retired"}
                onClick={() => mutate("retire", event.id)}
              >
                停用证据
              </button>
            </div>
          </article>
        ))}
      </div>
      {records.length > 20 && (
        <div className="material-actions">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页证据
          </button>
          <button
            disabled={offset + 20 >= records.length}
            onClick={() => setOffset(offset + 20)}
          >
            下一页证据
          </button>
        </div>
      )}
      <button
        disabled={disabled}
        onClick={async () => {
          setPending(true);
          try {
            updated(await api("materials.read", { bookId, id: material.id }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setPending(false);
          }
        }}
      >
        重新检查证据
      </button>
    </div>
  );
}
