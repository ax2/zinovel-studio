import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import {
  materialKinds,
  materialKind,
  validateMaterialInput,
} from "../../packages/novel-domain/materials.mjs";
type Input = {
  kind: string;
  title: string;
  status: string;
  notes: string;
  fields: Record<string, string>;
  chapterIds: string[];
};
type Expected = { id: string; revision: number; diskHash: string };
type Material = Input &
  Expected & {
    updatedAt: string;
    deletedAt?: string;
    chapters: { id: string; title: string; state: string }[];
  };
const fresh = (kind: string): Input => ({
  kind,
  title: "",
  status: "planned",
  notes: "",
  fields: {},
  chapterIds: [],
});
export function MaterialsPanel({
  book,
  openChapter,
}: {
  book: Book;
  openChapter: (id: string) => Promise<void>;
}) {
  const [kind, setKind] = useState(""),
    [query, setQuery] = useState(""),
    [deleted, setDeleted] = useState(false),
    [offset, setOffset] = useState(0);
  const [list, setList] = useState<{
    items: Material[];
    total: number;
    errors: string[];
  }>({ items: [], total: 0, errors: [] });
  const [current, setCurrent] = useState<Material | null>(null),
    [input, setInput] = useState<Input | null>(null),
    [expected, setExpected] = useState<Expected | null>(null);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [history, setHistory] = useState<Material[] | null>(null),
    [historical, setHistorical] = useState<Material | null>(null);
  const [createKind, setCreateKind] = useState("character");
  const listRequest = useRef(0),
    detailRequest = useRef(0);
  const draftKey = (id = current?.id || "new") =>
    `zinovel.material-draft.${book.id}.${id}`;
  async function refresh() {
    const request = ++listRequest.current;
    try {
      const value = await api<typeof list>("materials.list", {
        bookId: book.id,
        options: { kind, query, deleted, offset },
      });
      if (request === listRequest.current) setList(value);
    } catch (e) {
      if (request === listRequest.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      listRequest.current++;
    };
  }, [book.id, kind, query, deleted, offset]);
  useEffect(
    () => () => {
      detailRequest.current++;
    },
    [],
  );
  function restoreDraft(
    id: string,
    fallback: Input,
    baseline: Expected | null,
  ) {
    setDirty(false);
    setInput(fallback);
    setExpected(baseline);
    try {
      const raw = localStorage.getItem(draftKey(id));
      if (raw) {
        const draft = JSON.parse(raw);
        if (
          !draft.input ||
          typeof draft.input.title !== "string" ||
          !draft.input.fields ||
          !Array.isArray(draft.input.chapterIds)
        )
          throw new Error("资料本地草稿格式异常，原记录已保留");
        materialKind(draft.input.kind);
        validateMaterialInput({
          ...draft.input,
          title: draft.input.title || "未命名草稿",
        });
        if (
          id !== "new" &&
          (draft.expected?.id !== id ||
            !Number.isSafeInteger(draft.expected?.revision) ||
            typeof draft.expected?.diskHash !== "string")
        )
          throw new Error("资料草稿基线无效，原记录已保留");
        setInput(draft.input);
        setExpected(draft.expected);
        setDirty(true);
        setMessage("已找回本机未保存调整；保存时仍会检查原版本。");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function select(id: string, discard = false) {
    const token = ++detailRequest.current;
    setBusy(true);
    setError("");
    setMessage("");
    setHistory(null);
    setHistorical(null);
    try {
      const value = await api<Material>("materials.read", {
        bookId: book.id,
        id,
      });
      if (token !== detailRequest.current) return;
      if (discard) localStorage.removeItem(draftKey(id));
      setCurrent(value);
      restoreDraft(id, value, {
        id: value.id,
        revision: value.revision,
        diskHash: value.diskHash,
      });
    } catch (e) {
      if (token === detailRequest.current) setError((e as Error).message);
    } finally {
      if (token === detailRequest.current) setBusy(false);
    }
  }
  function edit(next: Input) {
    setInput(next);
    setDirty(true);
    setMessage("");
    try {
      localStorage.setItem(
        draftKey(),
        JSON.stringify({ input: next, expected }),
      );
    } catch {
      setError("本机草稿暂存失败，请保持窗口打开并点击保存资料。");
    }
  }
  function create() {
    detailRequest.current++;
    setCurrent(null);
    setHistory(null);
    setHistorical(null);
    setError("");
    setMessage("");
    restoreDraft("new", fresh(createKind), null);
  }
  async function save() {
    if (!input) return;
    setBusy(true);
    setError("");
    const key = draftKey();
    try {
      const value = await api<Material>("materials.save", {
        bookId: book.id,
        input,
        expected,
      });
      setCurrent(value);
      setInput(value);
      setExpected({
        id: value.id,
        revision: value.revision,
        diskHash: value.diskHash,
      });
      setDirty(false);
      localStorage.removeItem(key);
      setMessage(`已保存资料 · 版本 ${value.revision}`);
      setHistory(null);
      setHistorical(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function recycle() {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<Material>("materials.delete", {
        bookId: book.id,
        expected: current,
        deleted: !current.deletedAt,
      });
      setCurrent(value);
      setInput(value);
      setExpected(value);
      setDirty(false);
      setHistory(null);
      setHistorical(null);
      setMessage(value.deletedAt ? "已移入资料回收站，可恢复" : "资料已恢复");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="materials-panel" aria-label="创作资料">
      <h3>创作资料</h3>
      <p className="muted">
        独立保存人物、世界与计划。作者确认不代表正文已证实；伏笔卡当前记录计划。
      </p>
      <div className="material-filters">
        <label>
          资料类型
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部类型</option>
            {materialKinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          搜索资料
          <input
            value={query}
            maxLength={200}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
            placeholder="标题、别名或字段"
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={deleted}
            onChange={(e) => {
              setDeleted(e.target.checked);
              setOffset(0);
            }}
          />
          资料回收站
        </label>
      </div>
      {!!list.errors.length && (
        <p role="alert" className="inline-error">
          {list.errors.length} 份资料无法读取，原文件已保留。
        </p>
      )}
      <div className="material-list" aria-label="资料列表">
        {list.items.map((item) => (
          <button
            key={item.id}
            disabled={busy}
            aria-pressed={current?.id === item.id}
            onClick={() => select(item.id)}
          >
            <strong>{item.title}</strong>
            <span>
              {materialKind(item.kind).label} ·{" "}
              {item.status === "accepted" ? "作者已确认" : "作者计划"}
            </span>
          </button>
        ))}
        {!list.items.length && <p className="muted">此筛选下暂无资料。</p>}
      </div>
      <div className="material-actions">
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 40))}
        >
          上一页资料
        </button>
        <small>
          {list.total} 份 · 第 {Math.floor(offset / 40) + 1} 页
        </small>
        <button
          disabled={offset + 40 >= list.total}
          onClick={() => setOffset(offset + 40)}
        >
          下一页资料
        </button>
      </div>
      <div className="material-actions">
        <label>
          新建类型
          <select
            value={createKind}
            onChange={(e) => setCreateKind(e.target.value)}
          >
            {materialKinds.map((k) => (
              <option value={k.id} key={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={create}>
          新建资料
        </button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {input && (
        <>
          <h4>
            {materialKind(input.kind).label}
            {current ? ` · 版本 ${current.revision}` : " · 新建"}
          </h4>
          <p className="muted">
            {dirty
              ? "有未保存调整，本机暂存；点击保存资料后进入作品备份。"
              : current
                ? "以下为已保存资料。"
                : "填写后点击保存资料。"}
          </p>
          {current?.deletedAt && (
            <p role="status">此资料在回收站中，恢复后可编辑。</p>
          )}
          <fieldset
            disabled={busy || !!current?.deletedAt}
            className="material-form"
          >
            <label>
              资料标题
              <input
                aria-label="资料标题"
                value={input.title}
                maxLength={200}
                onChange={(e) => edit({ ...input, title: e.target.value })}
              />
            </label>
            <label>
              设定状态
              <select
                aria-label="设定状态"
                value={input.status}
                onChange={(e) => edit({ ...input, status: e.target.value })}
              >
                <option value="planned">作者计划</option>
                <option value="accepted">作者已确认设定</option>
              </select>
            </label>
            {materialKind(input.kind).fields.map((field) => (
              <label key={field.key}>
                {field.label}
                {field.options ? (
                  <select
                    aria-label={field.label}
                    value={input.fields[field.key] || ""}
                    onChange={(e) =>
                      edit({
                        ...input,
                        fields: {
                          ...input.fields,
                          [field.key]: e.target.value,
                        },
                      })
                    }
                  >
                    <option value="">未指定</option>
                    {field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    aria-label={field.label}
                    rows={2}
                    maxLength={10000}
                    value={input.fields[field.key] || ""}
                    onChange={(e) =>
                      edit({
                        ...input,
                        fields: {
                          ...input.fields,
                          [field.key]: e.target.value,
                        },
                      })
                    }
                  />
                )}
              </label>
            ))}
            <label>
              资料笔记
              <textarea
                aria-label="资料笔记"
                rows={5}
                maxLength={120000}
                value={input.notes}
                onChange={(e) => edit({ ...input, notes: e.target.value })}
              />
            </label>
            <details>
              <summary>关联章节（{input.chapterIds.length}）</summary>
              <div className="material-chapters">
                {book.chapters
                  .filter(
                    (ch) => !ch.deletedAt || input.chapterIds.includes(ch.id),
                  )
                  .map((ch) => (
                    <label className="inline-check" key={ch.id}>
                      <input
                        type="checkbox"
                        checked={input.chapterIds.includes(ch.id)}
                        onChange={(e) =>
                          edit({
                            ...input,
                            chapterIds: e.target.checked
                              ? [...input.chapterIds, ch.id]
                              : input.chapterIds.filter((id) => id !== ch.id),
                          })
                        }
                      />
                      {ch.title}
                      {ch.deletedAt ? " · 已删除" : ""}
                    </label>
                  ))}
                {input.chapterIds
                  .filter((id) => !book.chapters.some((ch) => ch.id === id))
                  .map((id) => (
                    <label className="inline-check" key={id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          edit({
                            ...input,
                            chapterIds: input.chapterIds.filter(
                              (value) => value !== id,
                            ),
                          })
                        }
                      />
                      章节不存在 · {id.slice(0, 8)}
                    </label>
                  ))}
              </div>
            </details>
          </fieldset>
          <div className="material-actions">
            <button
              className="primary"
              disabled={busy || !!current?.deletedAt || !input.title.trim()}
              onClick={save}
            >
              保存资料
            </button>
            {current && (
              <button disabled={busy} onClick={() => select(current.id, true)}>
                重新读取（放弃调整）
              </button>
            )}
            {!current && (
              <button
                disabled={busy}
                onClick={() => {
                  localStorage.removeItem(draftKey("new"));
                  setInput(fresh(createKind));
                  setExpected(null);
                  setDirty(false);
                  setMessage("已清空未保存的新建资料");
                }}
              >
                清空新建草稿
              </button>
            )}
          </div>
          {current && (
            <div className="material-actions">
              <button disabled={busy || dirty} onClick={recycle}>
                {current.deletedAt ? "恢复资料" : "移入资料回收站"}
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setHistory(
                      await api("materials.history", {
                        bookId: book.id,
                        id: current.id,
                      }),
                    );
                    setHistorical(null);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                查看资料历史
              </button>
              <button
                disabled={busy || dirty}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api("materials.export", {
                      bookId: book.id,
                      id: current.id,
                    });
                    if (!result.cancelled) setMessage("已导出已保存资料");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                导出资料
              </button>
            </div>
          )}
          {current && (
            <div className="material-actions" aria-label="已保存的章节引用">
              {current.chapters.map((ch) => (
                <button
                  key={ch.id}
                  disabled={busy || ch.state !== "active"}
                  onClick={() =>
                    openChapter(ch.id).catch((e) => setError(e.message))
                  }
                >
                  {ch.title}
                  {ch.state === "deleted"
                    ? " · 已删除"
                    : ch.state === "missing"
                      ? " · 不存在"
                      : " · 打开正文"}
                </button>
              ))}
            </div>
          )}
          {history && (
            <div>
              <p className="muted">
                最近 40 个历史版本；旧内容只读，载入后仍需手工保存。
              </p>
              {!history.length && <p>暂无历史版本</p>}
              {history.map((entry, index) => (
                <button key={index} onClick={() => setHistorical(entry)}>
                  查看版本 {entry.revision}
                </button>
              ))}
            </div>
          )}
          {historical && (
            <article className="material-history" aria-label="资料历史内容">
              <h4>
                {historical.title} · 版本 {historical.revision}
              </h4>
              {materialKind(historical.kind).fields.map((field) => (
                <p key={field.key}>
                  <strong>{field.label}：</strong>
                  {historical.fields[field.key]}
                </p>
              ))}
              <p>{historical.notes}</p>
              <button
                disabled={busy || !!current?.deletedAt}
                onClick={() => edit({ ...historical })}
              >
                载入历史为待保存草稿
              </button>
            </article>
          )}
        </>
      )}
    </section>
  );
}
