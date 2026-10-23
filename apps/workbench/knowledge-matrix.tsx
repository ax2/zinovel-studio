import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import type { EvidenceSource } from "./material-evidence";
import type { TextAnchor } from "./manuscript-editor";
import { registerEditorCloseGuard } from "./editor-close-guards";
import { knowledgeStates } from "../../packages/novel-domain/knowledge.mjs";
import { orderedChapters } from "../../packages/novel-domain/structure.mjs";
import { LegacyKnowledgePanel, type LegacyPreview } from "./knowledge-legacy";

type Input = {
  propositionId: string;
  scope: string;
  characterId: string | null;
  state: string;
  statement: string;
  storyTime: string;
};
type Event = Input & {
  origin?: {
    status: string;
    error?: string;
    ownerChanged?: boolean;
    targetChanged?: boolean;
    target?: { revision: number };
    source?: {
      ownerId: string;
      ownerTitle: string;
      event: LegacyPreview["event"];
    };
  } | null;
  id: string;
  revision: number;
  diskHash: string;
  status: string;
  freshness: string;
  sourceFreshness: string;
  chapterId: string;
  chapterTitle: string;
  anchor: TextAnchor;
  references: { id: string; title: string; freshness: string }[];
};
type Preview = { originStatus?: string } & Pick<
  Event,
  | "id"
  | "state"
  | "statement"
  | "freshness"
  | "status"
  | "storyTime"
  | "chapterTitle"
>;
type Choice = {
  id: string;
  revision: number;
  diskHash: string;
  status: string;
  freshness: string;
  snapshot: Event;
  selected: { id: string; revision: number };
  reason: string;
};
type Result = {
  columnIds: string[];
  rows: {
    id: string;
    title: string;
    claim: string;
    truthIntent: string;
    deleted: boolean;
    cells: Record<
      string,
      { total: number; events: Preview[]; choice?: Choice }
    >;
  }[];
  total: number;
  offset: number;
  characters: {
    id: string;
    title: string;
    deleted?: boolean;
    missing?: boolean;
  }[];
  errors: string[];
  excludedMissingSources: number;
};
type Listing = {
  items: Event[];
  total: number;
  offset: number;
  errors: string[];
};
const blank = (): Input => ({
  propositionId: "",
  scope: "reader",
  characterId: null,
  state: "suspects",
  statement: "",
  storyTime: "",
});
const stateLabel = (id: string) =>
  knowledgeStates.find((item) => item.id === id)?.label || id;
const fresh = (id: string) =>
  ({
    current: "有效",
    stale: "待复核",
    missing: "来源缺失",
    cleared: "已清除",
  })[id] || id;

export function KnowledgeMatrix({
  book,
  source,
  onClose,
  onEdit,
  onChapter,
}: {
  book: Book;
  source: EvidenceSource | null;
  onClose: () => void;
  onEdit: (id: string) => void;
  onChapter: (id: string, anchor: TextAnchor) => Promise<void>;
}) {
  const key = `zinovel.knowledge-draft.${book.id}`;
  const [querySession] = useState(() => crypto.randomUUID());
  const nextQuery = useRef(0);
  const [restored] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (
        !value.input ||
        typeof value.input.statement !== "string" ||
        typeof value.input.propositionId !== "string" ||
        typeof value.input.storyTime !== "string" ||
        !["world", "reader", "character"].includes(value.input.scope) ||
        !knowledgeStates.some((item) => item.id === value.input.state) ||
        (value.input.characterId !== null &&
          typeof value.input.characterId !== "string") ||
        (value.legacyExpected &&
          (!value.legacyExpected.owner ||
            typeof value.legacyExpected.owner.id !== "string" ||
            typeof value.legacyExpected.eventId !== "string" ||
            typeof value.legacyExpected.eventHash !== "string" ||
            !value.legacyExpected.event)) ||
        (value.expected !== null &&
          (!value.expected ||
            typeof value.expected.id !== "string" ||
            typeof value.expected.diskHash !== "string" ||
            !Number.isSafeInteger(value.expected.revision)))
      )
        throw new Error();
      return value as {
        input: Input;
        expected: Event | null;
        legacyExpected?: LegacyPreview | null;
      };
    } catch {
      return { invalid: true } as const;
    }
  });
  const [input, setInput] = useState<Input>(
    restored && "input" in restored ? restored.input : blank(),
  );
  const [expected, setExpected] = useState<Event | null>(
    restored && "expected" in restored ? restored.expected : null,
  );
  const [legacyExpected, setLegacyExpected] = useState<LegacyPreview | null>(
    restored && "input" in restored ? restored.legacyExpected || null : null,
  );
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [draftFailed, setDraftFailed] = useState(
    !!restored && "invalid" in restored,
  );
  const [draftPending, setDraftPending] = useState(!!restored);
  const [draftInvalid, setDraftInvalid] = useState(
    !!restored && "invalid" in restored,
  );
  const [query, setQuery] = useState(""),
    [characterIds, setCharacterIds] = useState<string[]>([]),
    [upToChapterId, setUpToChapterId] = useState(""),
    [includeRetired, setIncludeRetired] = useState(false),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [composing, setComposing] = useState(false),
    [error, setError] = useState(
      !!restored && "invalid" in restored
        ? "本机草稿无法解析，原内容已保留。请先检查草稿，或明确放弃后重新开始。"
        : "",
    ),
    [message, setMessage] = useState(
      !!restored && "input" in restored
        ? "已恢复本机认知草稿；保存时仍须重新选择正文依据。"
        : "",
    );
  const [listing, setListing] = useState<Listing | null>(null),
    [listFilter, setListFilter] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState<Event | null>(null),
    [history, setHistory] = useState<{
      items: Event[];
      total: number;
      offset: number;
      errors: string[];
    } | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null),
    [choiceFor, setChoiceFor] = useState("");
  const [choiceHistory, setChoiceHistory] = useState<{
    items: Choice[];
    total: number;
    offset: number;
    errors: string[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    setChoiceFor("");
    setChoice(null);
    setChoiceHistory(null);
    if (selected)
      void api<Choice | null>("knowledge.choice", {
        bookId: book.id,
        target: selected,
      })
        .then((value) => {
          if (active) {
            setChoice(value);
            setChoiceFor(selected.id);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, book.id]);
  const propositionKey = `${key}.proposition`;
  const [propositionDraft] = useState(() => {
    try {
      const raw = localStorage.getItem(propositionKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (
        typeof data.title !== "string" ||
        typeof data.claim !== "string" ||
        !["尚未确定", "作者设定为真", "作者设定为假"].includes(data.truthIntent)
      )
        throw new Error();
      return data as { title: string; claim: string; truthIntent: string };
    } catch {
      return { invalid: true } as const;
    }
  });
  const [newTitle, setNewTitle] = useState(
      propositionDraft && "title" in propositionDraft
        ? propositionDraft.title
        : "",
    ),
    [newClaim, setNewClaim] = useState(
      propositionDraft && "claim" in propositionDraft
        ? propositionDraft.claim
        : "",
    ),
    [truthIntent, setTruthIntent] = useState(
      propositionDraft && "truthIntent" in propositionDraft
        ? propositionDraft.truthIntent
        : "尚未确定",
    );
  const [propositionFailed, setPropositionFailed] = useState(
    !!propositionDraft && "invalid" in propositionDraft,
  );
  const [propositionInvalid, setPropositionInvalid] = useState(
    !!propositionDraft && "invalid" in propositionDraft,
  );
  function editProposition(title: string, claim: string, truth: string) {
    if (propositionInvalid) {
      setError("原命题草稿无法读取；请先明确放弃后再编辑。");
      return;
    }
    setNewTitle(title);
    setNewClaim(claim);
    setTruthIntent(truth);
    try {
      localStorage.setItem(
        propositionKey,
        JSON.stringify({ title, claim, truthIntent: truth }),
      );
      setPropositionFailed(false);
    } catch {
      setPropositionFailed(true);
      setError("命题草稿无法落盘，请保存命题后再关闭。");
    }
  }
  const locked = useRef(false);
  function mayLeave() {
    if (locked.current || composing || draftFailed || propositionFailed) {
      setError("操作、输入或草稿保存尚未完成，请先保存后再离开。");
      return false;
    }
    return true;
  }
  useEffect(
    () => registerEditorCloseGuard(mayLeave),
    [composing, draftFailed, propositionFailed],
  );
  useEffect(() => {
    let active = true;
    const requestId = ++nextQuery.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api<Result>("knowledge.matrix", {
        sessionId: querySession,
        requestId,
        bookId: book.id,
        options: { query, characterIds, upToChapterId, includeRetired, offset },
      })
        .then((value) => {
          if (!active) return;
          if (value.total && value.offset >= value.total) {
            setOffset(Math.floor((value.total - 1) / 20) * 20);
            return;
          }
          setResult({ ...value, columnIds: characterIds });
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
      void api("knowledge.cancel", {
        sessionId: querySession,
        requestId,
      }).catch(() => {});
    };
  }, [
    book.id,
    query,
    characterIds,
    upToChapterId,
    includeRetired,
    offset,
    refresh,
  ]);
  function stash(next: Input, base = expected, legacy = legacyExpected) {
    if (draftInvalid) {
      setError("原认知草稿无法读取；请先明确放弃后再编辑。");
      return;
    }
    setInput(next);
    setExpected(base);
    setLegacyExpected(legacy);
    setDraftPending(true);
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ input: next, expected: base, legacyExpected: legacy }),
      );
      setDraftFailed(false);
    } catch {
      setDraftFailed(true);
      setError("本机草稿空间不足，调整仍在窗口中；请保存记录后再关闭。");
    }
  }
  function clearDraft() {
    localStorage.removeItem(key);
    setDraftFailed(false);
    setDraftInvalid(false);
    setDraftPending(false);
    setInput(blank());
    setExpected(null);
    setLegacyExpected(null);
  }
  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function showList(filter: Record<string, string>, page = 0) {
    const value = await api<Listing>("knowledge.list", {
      bookId: book.id,
      options: { ...filter, offset: page },
    });
    setListFilter(filter);
    setListing(value);
    setSelected(null);
    setHistory(null);
  }
  const columns = [
    { id: "world", title: "世界记录" },
    { id: "reader", title: "读者" },
    ...(result?.columnIds || []).map((id) => ({
      id,
      title:
        result?.characters.find((item) => item.id === id)?.title || "失联人物",
    })),
  ];
  const validSource = !!source && !source.dirty && source.end > source.start;
  const navigate = (fn: () => void) => {
    if (mayLeave()) fn();
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal knowledge-matrix"
        role="dialog"
        aria-modal="true"
        aria-label="认知矩阵"
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      >
        <header>
          <div>
            <h2>认知与秘密矩阵</h2>
            <p>按命题身份保留全部认知；空格表示没有记录，不能推断为不知。</p>
          </div>
          <button aria-label="关闭认知矩阵" onClick={() => navigate(onClose)}>
            关闭
          </button>
        </header>
        <fieldset disabled={busy} className="knowledge-body">
          {propositionFailed && (
            <p role="alert">
              命题草稿无法读取或落盘，关闭已受保护。请保存或明确放弃命题草稿。
            </p>
          )}
          {error && (
            <p className="knowledge-error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          <div className="knowledge-filters">
            <label>
              查找命题
              <input
                aria-label="查找命题"
                maxLength={200}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label>
              截至叙述章节
              <select
                aria-label="截至叙述章节"
                value={upToChapterId}
                onChange={(e) => {
                  setUpToChapterId(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全书记录</option>
                {orderedChapters(book).map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeRetired}
                onChange={(e) => setIncludeRetired(e.target.checked)}
              />
              包含停用
            </label>
            <button
              disabled={loading || busy}
              onClick={() => setRefresh((n) => n + 1)}
            >
              刷新矩阵
            </button>
            <button disabled={busy} onClick={() => perform(() => showList({}))}>
              全部认知记录
            </button>
          </div>
          <details>
            <summary>选择人物列（最多 8 人）</summary>
            <div className="knowledge-characters">
              {result?.characters.map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={characterIds.includes(person.id)}
                    disabled={
                      !characterIds.includes(person.id) &&
                      characterIds.length >= 8
                    }
                    onChange={(e) =>
                      setCharacterIds((ids) =>
                        e.target.checked
                          ? [...ids, person.id]
                          : ids.filter((id) => id !== person.id),
                      )
                    }
                  />
                  {person.title}
                  {person.deleted
                    ? "（已删除）"
                    : person.missing
                      ? "（失联）"
                      : ""}
                </label>
              ))}
            </div>
          </details>
          <p role="status">
            {loading ? "正在读取认知矩阵…" : `共 ${result?.total || 0} 个命题`}
          </p>
          <p className="muted">
            叙述进度仅过滤已出现的记录；倒叙与相反认知不会自动合并。作者当前选择只在全书记录视图展示。表格可横向滚动查看人物列，此视图为分批实时读取。
          </p>
          {!!result?.excludedMissingSources && (
            <p>
              有 {result.excludedMissingSources} 条失联章节记录未纳入叙述进度。
            </p>
          )}
          {result?.errors.map((text, i) => (
            <p role="alert" key={i}>
              {text}
            </p>
          ))}
          <div className="knowledge-table" aria-busy={loading}>
            <table>
              <thead>
                <tr>
                  <th scope="col">命题 / 作者设定</th>
                  {columns.map((col) => (
                    <th scope="col" key={col.id}>
                      {col.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result?.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <strong>
                        {row.title}
                        {row.deleted ? "（已删除）" : ""}
                      </strong>
                      <p>{row.claim}</p>
                      <p>{row.truthIntent || "尚未确定"}（不代表正文成立）</p>
                      <button
                        disabled={busy}
                        onClick={() => navigate(() => onEdit(row.id))}
                      >
                        编辑命题
                      </button>
                      <button
                        disabled={busy || draftPending || row.deleted}
                        onClick={() =>
                          stash({ ...blank(), propositionId: row.id }, null)
                        }
                      >
                        为此命题记录认知
                      </button>
                    </th>
                    {columns.map((col) => {
                      const cell = row.cells[col.id];
                      return (
                        <td key={col.id}>
                          {cell?.choice && (
                            <p className="knowledge-choice">
                              {cell.choice.status === "cleared"
                                ? "作者当前选择：已清除"
                                : `作者选用：${stateLabel(cell.choice.snapshot.state)} · ${fresh(cell.choice.freshness)}`}
                            </p>
                          )}
                          {cell?.total ? (
                            <>
                              <p>{cell.total} 条记录</p>
                              {cell.events.map((event) => (
                                <article key={event.id}>
                                  <b>{stateLabel(event.state)}</b> ·{" "}
                                  {fresh(event.freshness)}
                                  {event.status === "retired"
                                    ? " · 已停用"
                                    : ""}
                                  {event.originStatus &&
                                    event.originStatus !== "unchanged" && (
                                      <small> · 旧来源需核对</small>
                                    )}
                                  <p>{event.statement}</p>
                                  <small>
                                    {event.chapterTitle} ·{" "}
                                    {event.storyTime || "故事时间未标注"}
                                  </small>
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      perform(async () => {
                                        setSelected(
                                          await api<Event>("knowledge.read", {
                                            bookId: book.id,
                                            id: event.id,
                                          }),
                                        );
                                        setHistory(null);
                                      })
                                    }
                                  >
                                    查看认知依据
                                  </button>
                                </article>
                              ))}
                              <button
                                disabled={busy}
                                onClick={() =>
                                  perform(() =>
                                    showList({
                                      propositionId: row.id,
                                      scope:
                                        col.id === "world" ||
                                        col.id === "reader"
                                          ? col.id
                                          : "character",
                                      characterId:
                                        col.id === "world" ||
                                        col.id === "reader"
                                          ? ""
                                          : col.id,
                                    }),
                                  )
                                }
                              >
                                查看此格全部记录
                              </button>
                            </>
                          ) : (
                            <span>没有记录</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="knowledge-filters">
            <button
              disabled={loading || !result?.offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页命题
            </button>
            <span>第 {Math.floor((result?.offset || 0) / 20) + 1} 页</span>
            <button
              disabled={
                loading || !result || result.offset + 20 >= result.total
              }
              onClick={() => setOffset(offset + 20)}
            >
              下一页命题
            </button>
          </div>
          <details>
            <summary>新建命题与秘密</summary>
            <p>命题名称和内容不会自动归并。真相性质只能由作者指定。</p>
            <label>
              新命题名称
              <input
                aria-label="新命题名称"
                maxLength={200}
                value={newTitle}
                onChange={(e) =>
                  editProposition(e.target.value, newClaim, truthIntent)
                }
              />
            </label>
            <label>
              新命题内容
              <textarea
                aria-label="新命题内容"
                maxLength={10000}
                value={newClaim}
                onChange={(e) =>
                  editProposition(newTitle, e.target.value, truthIntent)
                }
              />
            </label>
            <label>
              作者设定真相
              <select
                aria-label="作者设定真相"
                value={truthIntent}
                onChange={(e) =>
                  editProposition(newTitle, newClaim, e.target.value)
                }
              >
                {["尚未确定", "作者设定为真", "作者设定为假"].map((text) => (
                  <option key={text}>{text}</option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !newTitle.trim() || !newClaim.trim()}
              onClick={() =>
                perform(async () => {
                  await api<{ id: string }>("materials.save", {
                    bookId: book.id,
                    input: {
                      title: newTitle,
                      kind: "proposition",
                      fields: { claim: newClaim, truthIntent },
                      notes: "",
                      status: "planned",
                      chapterIds: [],
                    },
                  });
                  setNewTitle("");
                  setNewClaim("");
                  localStorage.removeItem(propositionKey);
                  setPropositionFailed(false);
                  setPropositionInvalid(false);
                  setRefresh((n) => n + 1);
                  setMessage("命题已保存，可在矩阵中添加认知。");
                })
              }
            >
              创建命题
            </button>
            <button
              onClick={() =>
                perform(async () => {
                  localStorage.removeItem(propositionKey);
                  setNewTitle("");
                  setNewClaim("");
                  setTruthIntent("尚未确定");
                  setPropositionFailed(false);
                  setPropositionInvalid(false);
                })
              }
            >
              放弃命题草稿
            </button>
          </details>
          <details onToggle={(e) => setLegacyOpen(e.currentTarget.open)}>
            <summary>整理旧认知证据</summary>
            {legacyOpen && (
              <LegacyKnowledgePanel
                bookId={book.id}
                disabled={
                  busy || !!expected || !input.propositionId || draftInvalid
                }
                onSelect={(ownerId, eventId) =>
                  void perform(async () => {
                    const preview = await api<LegacyPreview>(
                      "knowledge.legacy-preview",
                      { bookId: book.id, ownerId, eventId },
                    );
                    stash(
                      {
                        ...input,
                        scope: preview.event.scope,
                        characterId:
                          preview.event.scope === "character"
                            ? preview.owner.id
                            : null,
                        state: "unspecified",
                        statement: input.statement || preview.event.statement,
                        storyTime: input.storyTime || preview.event.storyTime,
                      },
                      null,
                      preview,
                    );
                    setMessage(
                      "已带入旧范围和原说明（已有说明保留），状态设为未明确。请核对认知状态，再绑定当前选区；原记录不会修改。",
                    );
                  })
                }
              />
            )}
          </details>
          <details open={draftPending || !selected}>
            <summary>添加/编辑认知记录</summary>
            <section className="knowledge-form" aria-label="认知记录编辑">
              {legacyExpected && (
                <section aria-label="待关联旧认知">
                  <h4>
                    待关联旧认知 · {legacyExpected.owner.title} · 版本{" "}
                    {legacyExpected.owner.revision}
                  </h4>
                  <p>{legacyExpected.event.statement}</p>
                  <blockquote>{legacyExpected.event.anchor.quote}</blockquote>
                  <p>旧记录不代表当前认知状态，请核对命题、范围和状态。</p>
                  <button
                    disabled={busy}
                    onClick={() => stash(input, expected, null)}
                  >
                    取消旧来源关联，保留调整
                  </button>
                </section>
              )}
              <h3>
                {expected
                  ? `修订认知 · 版本 ${expected.revision}`
                  : "添加有正文依据的认知"}
              </h3>
              <p>命题 ID：{input.propositionId || "请先从矩阵选择命题"}</p>
              <label>
                认知范围
                <select
                  aria-label="认知范围"
                  value={input.scope}
                  onChange={(e) =>
                    stash({
                      ...input,
                      scope: e.target.value,
                      characterId: null,
                      state:
                        e.target.value === "world" ? "recorded" : "suspects",
                    })
                  }
                >
                  <option value="world">世界记录</option>
                  <option value="reader">读者</option>
                  <option value="character">人物</option>
                </select>
              </label>
              {input.scope === "character" && (
                <label>
                  认知人物
                  <select
                    aria-label="认知人物"
                    value={input.characterId || ""}
                    onChange={(e) =>
                      stash({ ...input, characterId: e.target.value })
                    }
                  >
                    <option value="">请选择人物</option>
                    {result?.characters
                      .filter((person) => !person.deleted && !person.missing)
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                明确认知状态
                <select
                  aria-label="明确认知状态"
                  value={input.state}
                  onChange={(e) => stash({ ...input, state: e.target.value })}
                >
                  {knowledgeStates
                    .filter((item) =>
                      input.scope === "world"
                        ? ["recorded", "unspecified"].includes(item.id)
                        : item.id !== "recorded",
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                认知说明
                <textarea
                  aria-label="认知说明"
                  maxLength={10000}
                  value={input.statement}
                  onChange={(e) =>
                    stash({ ...input, statement: e.target.value })
                  }
                />
              </label>
              <label>
                故事时间
                <input
                  aria-label="认知故事时间"
                  maxLength={200}
                  value={input.storyTime}
                  onChange={(e) =>
                    stash({ ...input, storyTime: e.target.value })
                  }
                />
              </label>
              <p>
                {validSource
                  ? `将绑定当前已保存正文选区（${source!.end - source!.start} 字符）`
                  : "先回正文保存稿件并选择依据，再打开认知矩阵。草稿会保留。"}
              </p>
              <button
                data-dialog-save
                disabled={
                  busy ||
                  !validSource ||
                  !input.propositionId ||
                  !input.statement.trim() ||
                  (input.scope === "character" && !input.characterId)
                }
                onClick={() =>
                  perform(async () => {
                    const saved = await api<Event>(
                      legacyExpected
                        ? "knowledge.link-legacy"
                        : "knowledge.save",
                      {
                        bookId: book.id,
                        input,
                        expected,
                        source,
                        legacyExpected,
                      },
                    );
                    clearDraft();
                    setSelected(saved);
                    setHistory(null);
                    setRefresh((n) => n + 1);
                    setMessage("认知已保存，正文未改写。");
                  })
                }
              >
                保存并绑定当前选区
              </button>
              <button disabled={busy} onClick={() => navigate(onClose)}>
                回正文选择证据
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    clearDraft();
                    setMessage("本机认知草稿已明确放弃。");
                  })
                }
              >
                放弃认知草稿
              </button>
            </section>
          </details>
          {listing && (
            <section aria-label="认知记录列表">
              <h3>全部认知记录 · {listing.total} 条</h3>
              {listing.errors.map((text, i) => (
                <p key={i} role="alert">
                  {text}
                </p>
              ))}
              {listing.items.map((event) => (
                <article key={event.id}>
                  <b>{stateLabel(event.state)}</b> · {fresh(event.freshness)} ·{" "}
                  {event.status === "retired" ? "已停用" : "启用"}
                  <p>{event.statement}</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        setSelected(
                          await api<Event>("knowledge.read", {
                            bookId: book.id,
                            id: event.id,
                          }),
                        );
                        setHistory(null);
                      })
                    }
                  >
                    查看记录详情
                  </button>
                </article>
              ))}
              <button
                disabled={busy || !listing.offset}
                onClick={() =>
                  perform(() =>
                    showList(listFilter, Math.max(0, listing.offset - 40)),
                  )
                }
              >
                上一页记录
              </button>
              <button
                disabled={busy || listing.offset + 40 >= listing.total}
                onClick={() =>
                  perform(() => showList(listFilter, listing.offset + 40))
                }
              >
                下一页记录
              </button>
            </section>
          )}
          {selected && (
            <section aria-label="认知记录详情">
              {selected.origin && (
                <section aria-label="旧认知来源">
                  <h4>旧认知来源</h4>
                  {selected.origin.status === "unreadable" ? (
                    <p role="alert">{selected.origin.error}</p>
                  ) : (
                    <>
                      <p>
                        {selected.origin.source?.ownerTitle} ·{" "}
                        {selected.origin.status === "unchanged"
                          ? "原事件内容未改"
                          : selected.origin.status === "changed"
                            ? "原事件已改或停用"
                            : "原事件失联或资料已删除"}
                      </p>
                      {selected.origin.ownerChanged &&
                        selected.origin.status === "unchanged" && (
                          <p>旧资料有其他修改，原事件内容未变。</p>
                        )}
                      {selected.origin.targetChanged && (
                        <p>
                          新认知已修订；这里保留最初关联的版本{" "}
                          {selected.origin.target?.revision}。
                        </p>
                      )}
                      <p>{selected.origin.source?.event.statement}</p>
                      <blockquote>
                        {selected.origin.source?.event.anchor.quote}
                      </blockquote>
                      <button
                        disabled={busy || !selected.origin.source}
                        onClick={() =>
                          navigate(() =>
                            onEdit(selected.origin!.source!.ownerId),
                          )
                        }
                      >
                        打开旧资料
                      </button>
                      <button
                        disabled={busy || !selected.origin.source}
                        onClick={() =>
                          navigate(() => {
                            const old = selected.origin!.source!.event;
                            void onChapter(old.chapterId, old.anchor).catch(
                              (e) => setError(e.message),
                            );
                          })
                        }
                      >
                        查看旧引文位置
                      </button>
                    </>
                  )}
                </section>
              )}
              <h3>
                {stateLabel(selected.state)} · {fresh(selected.freshness)} ·
                版本 {selected.revision}
              </h3>
              <p>{selected.statement}</p>
              <p>
                {selected.chapterTitle} ·{" "}
                {selected.storyTime || "故事时间未标注"} ·{" "}
                {selected.status === "retired" ? "已停用" : "启用"}
              </p>
              <blockquote>{selected.anchor.quote}</blockquote>
              <p>
                原文：{fresh(selected.sourceFreshness)}；定义：
                {selected.references
                  .map((item) => `${item.title}（${fresh(item.freshness)}）`)
                  .join("、")}
              </p>
              <section
                aria-label="作者当前认知选择"
                className="knowledge-choice-detail"
              >
                <h4>
                  {choiceFor !== selected.id
                    ? "正在读取作者选择…"
                    : choice?.status === "active"
                      ? `作者当前选择 · ${stateLabel(choice.snapshot.state)} · ${fresh(choice.freshness)}`
                      : choice
                        ? "作者当前选择已清除"
                        : "作者尚未选择当前认知"}
                </h4>
                <p>
                  此选择由作者指定，不推断故事时刻；过期后保留当时记录，不会自动改选。
                </p>
                {choice && (
                  <details>
                    <summary>选择时冻结的记录与引文</summary>
                    <p>
                      {stateLabel(choice.snapshot.state)} · 事件版本{" "}
                      {choice.snapshot.revision}
                    </p>
                    <p>{choice.snapshot.statement}</p>
                    <blockquote>{choice.snapshot.anchor.quote}</blockquote>
                  </details>
                )}
                <button
                  disabled={
                    busy ||
                    choiceFor !== selected.id ||
                    selected.status !== "active" ||
                    selected.freshness !== "current" ||
                    (choice?.status === "active" &&
                      choice.freshness === "current" &&
                      choice.selected.id === selected.id &&
                      choice.selected.revision === selected.revision)
                  }
                  onClick={() =>
                    perform(async () => {
                      setChoice(
                        await api<Choice>("knowledge.choose", {
                          bookId: book.id,
                          eventExpected: selected,
                          choiceExpected: choice,
                        }),
                      );
                      setChoiceHistory(null);
                      setRefresh((n) => n + 1);
                      setMessage(
                        "已按此事件及其依据版本明确选择当前认知；其他记录保留。",
                      );
                    })
                  }
                >
                  明确采用为当前认知
                </button>
                <button
                  disabled={
                    busy ||
                    choiceFor !== selected.id ||
                    !choice ||
                    choice.status !== "active"
                  }
                  onClick={() =>
                    perform(async () => {
                      setChoice(
                        await api<Choice>("knowledge.clear-choice", {
                          bookId: book.id,
                          target: selected,
                          expected: choice,
                        }),
                      );
                      setChoiceHistory(null);
                      setRefresh((n) => n + 1);
                    })
                  }
                >
                  清除当前认知选择
                </button>
                <button
                  disabled={busy || choiceFor !== selected.id || !choice}
                  onClick={() =>
                    perform(async () =>
                      setChoiceHistory(
                        await api("knowledge.choice-history", {
                          bookId: book.id,
                          target: selected,
                        }),
                      ),
                    )
                  }
                >
                  查看选择历史
                </button>
                {choiceHistory && (
                  <div aria-label="作者选择历史">
                    <p>共 {choiceHistory.total} 个历史选择版本，只读。</p>
                    {choiceHistory.errors.map((text, i) => (
                      <p role="alert" key={i}>
                        {text}
                      </p>
                    ))}
                    {choiceHistory.items.map((item) => (
                      <article key={item.revision}>
                        <b>
                          选择版本 {item.revision} ·{" "}
                          {item.status === "cleared"
                            ? "已清除"
                            : stateLabel(item.snapshot.state)}
                        </b>
                        <p>{item.snapshot.statement}</p>
                        <blockquote>{item.snapshot.anchor.quote}</blockquote>
                      </article>
                    ))}
                    <button
                      disabled={busy || !choiceHistory.offset}
                      onClick={() =>
                        perform(async () =>
                          setChoiceHistory(
                            await api("knowledge.choice-history", {
                              bookId: book.id,
                              target: selected,
                              offset: Math.max(0, choiceHistory.offset - 40),
                            }),
                          ),
                        )
                      }
                    >
                      上一页选择历史
                    </button>
                    <button
                      disabled={
                        busy || choiceHistory.offset + 40 >= choiceHistory.total
                      }
                      onClick={() =>
                        perform(async () =>
                          setChoiceHistory(
                            await api("knowledge.choice-history", {
                              bookId: book.id,
                              target: selected,
                              offset: choiceHistory.offset + 40,
                            }),
                          ),
                        )
                      }
                    >
                      下一页选择历史
                    </button>
                  </div>
                )}
              </section>
              <button
                disabled={busy}
                onClick={() =>
                  navigate(() => {
                    void onChapter(selected.chapterId, selected.anchor).catch(
                      (e) => setError(e.message),
                    );
                  })
                }
              >
                查看正文依据
              </button>
              <button
                disabled={busy || draftPending || selected.status === "retired"}
                onClick={() =>
                  stash(
                    {
                      propositionId: selected.propositionId,
                      scope: selected.scope,
                      characterId: selected.characterId,
                      state: selected.state,
                      statement: selected.statement,
                      storyTime: selected.storyTime,
                    },
                    selected,
                  )
                }
              >
                修订并重新绑定依据
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    setSelected(
                      await api<Event>("knowledge.retire", {
                        bookId: book.id,
                        expected: selected,
                        retired: selected.status !== "retired",
                      }),
                    );
                    setRefresh((n) => n + 1);
                    setListing(null);
                    setHistory(null);
                  })
                }
              >
                {selected.status === "retired"
                  ? "恢复认知记录"
                  : "停用认知记录"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  perform(async () =>
                    setHistory(
                      await api("knowledge.history", {
                        bookId: book.id,
                        id: selected.id,
                      }),
                    ),
                  )
                }
              >
                查看认知历史
              </button>
              {history && (
                <div aria-label="认知历史">
                  <p>共 {history.total} 个历史版本；只读，不会重新确认事实。</p>
                  {history.errors.map((text, i) => (
                    <p key={i} role="alert">
                      {text}
                    </p>
                  ))}
                  {history.items.map((item) => (
                    <article key={item.revision}>
                      <b>
                        版本 {item.revision} · {stateLabel(item.state)}
                      </b>
                      <p>{item.statement}</p>
                      <blockquote>{item.anchor.quote}</blockquote>
                    </article>
                  ))}
                  <button
                    disabled={busy || !history.offset}
                    onClick={() =>
                      perform(async () =>
                        setHistory(
                          await api("knowledge.history", {
                            bookId: book.id,
                            id: selected.id,
                            offset: Math.max(0, history.offset - 40),
                          }),
                        ),
                      )
                    }
                  >
                    上一页历史
                  </button>
                  <button
                    disabled={busy || history.offset + 40 >= history.total}
                    onClick={() =>
                      perform(async () =>
                        setHistory(
                          await api("knowledge.history", {
                            bookId: book.id,
                            id: selected.id,
                            offset: history.offset + 40,
                          }),
                        ),
                      )
                    }
                  >
                    下一页历史
                  </button>
                </div>
              )}
            </section>
          )}
        </fieldset>
      </section>
    </div>
  );
}
