import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import {
  assetInput,
  assetDraftInput,
  assetId,
  assetHash,
  type AssetInput,
  type AssetRecord,
  type AssetExpected,
  type AssetPurpose,
} from "../../packages/novel-domain/assets.mjs";
import { registerEditorCloseGuard } from "./editor-close-guards";
const purposes: Record<AssetPurpose, string> = {
  cover: "封面候选",
  portrait: "人物定妆",
  map: "地图底图",
  illustration: "场景插图",
  reference: "参考图",
};
const expected = (record: AssetRecord): AssetExpected => ({
  id: record.id,
  revision: record.revision,
  diskHash: record.diskHash,
});
const fields = (record: AssetRecord): AssetInput => ({
  title: record.title,
  purpose: record.purpose,
  source: record.source,
  rights: record.rights,
  notes: record.notes,
  linkedIds: [...record.linkedIds],
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
type Card = { id: string; title: string; kind: string };
type Draft = {
  schemaVersion: 1;
  bookId: string;
  id: string;
  expected: AssetExpected;
  input: AssetInput;
};
function draftValue(raw: string, bookId: string, id: string): Draft {
  if (raw.length > 192 * 1024) throw Error("本机图像草稿过大，已保留");
  const value = JSON.parse(raw);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.bookId !== bookId ||
    value.id !== id ||
    Object.keys(value).sort().join(",") !==
      "bookId,expected,id,input,schemaVersion"
  )
    throw Error("本机图像草稿无法识别，已保留");
  const base = value.expected;
  if (
    !base ||
    assetId(base.id) !== id ||
    !Number.isSafeInteger(base.revision) ||
    base.revision < 1 ||
    Object.keys(base).sort().join(",") !== "diskHash,id,revision"
  )
    throw Error("本机图像草稿版本无法识别，已保留");
  assetHash(base.diskHash);
  return { ...value, input: assetDraftInput(value.input) };
}
export function AssetsPanel({
  book,
  onClose,
}: {
  book: Book;
  onClose: () => void;
}) {
  const [items, setItems] = useState<AssetRecord[]>([]),
    [total, setTotal] = useState(0),
    [listErrors, setListErrors] = useState<string[]>([]);
  const [query, setQuery] = useState(""),
    [purpose, setPurpose] = useState(""),
    [deleted, setDeleted] = useState(false),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [record, setRecord] = useState<AssetRecord | null>(null),
    [form, setForm] = useState<AssetInput | null>(null),
    [base, setBase] = useState<AssetExpected | null>(null);
  const [dirty, setDirty] = useState(false),
    [locked, setLocked] = useState(false),
    [cleanup, setCleanup] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [previewTarget, setPreviewTarget] = useState<AssetRecord | null>(null),
    [historical, setHistorical] = useState(false),
    [preview, setPreview] = useState(""),
    [previewError, setPreviewError] = useState("");
  const [history, setHistory] = useState<AssetRecord[]>([]),
    [historyError, setHistoryError] = useState("");
  const [cardQuery, setCardQuery] = useState(""),
    [cards, setCards] = useState<Card[]>([]),
    [cardTotal, setCardTotal] = useState(0),
    [cardOffset, setCardOffset] = useState(0),
    [cardError, setCardError] = useState(""),
    [linkedCards, setLinkedCards] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null),
    [unknownIntent, setUnknownIntent] = useState(false);
  const alive = useRef(true),
    viewSeq = useRef(0),
    listSeq = useRef(0),
    state = useRef({ record, form, base, dirty, locked, cleanup, busy });
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const importKey = `zinovel.asset-import.${book.id}`;
  state.current = { record, form, base, dirty, locked, cleanup, busy };
  const key = (id: string) => `zinovel.asset-draft.${book.id}.${id}`;
  function clearDraft(id: string) {
    try {
      localStorage.removeItem(key(id));
      setCleanup(false);
      state.current.cleanup = false;
      return true;
    } catch {
      setError("说明已保存，但本机草稿未能清理。请重试清理，避免重复保存。");
      setCleanup(true);
      state.current.cleanup = true;
      return false;
    }
  }
  function persist() {
    const current = state.current;
    if (current.busy) {
      setError("正在处理图像，请等待完成后再关闭。");
      return false;
    }
    if (current.cleanup && current.record) return clearDraft(current.record.id);
    if (
      !current.dirty ||
      !current.record ||
      !current.form ||
      !current.base ||
      current.locked
    )
      return true;
    try {
      localStorage.setItem(
        key(current.record.id),
        JSON.stringify({
          schemaVersion: 1,
          bookId: book.id,
          id: current.record.id,
          expected: current.base,
          input: current.form,
        }),
      );
      return true;
    } catch {
      setError(
        "本机图像草稿暂不能保存，输入仍在窗口中。请重试，或明确放弃调整后关闭。",
      );
      return false;
    }
  }
  function applyRecord(next: AssetRecord) {
    let value = fields(next),
      baseline = expected(next),
      restored = false,
      unreadable = false;
    try {
      const raw = localStorage.getItem(key(next.id));
      if (raw !== null) {
        const draft = draftValue(raw, book.id, next.id);
        value = draft.input;
        baseline = draft.expected;
        restored = true;
      }
    } catch {
      unreadable = true;
      setError(
        "本机图像草稿无法识别或不能读取，已保留。可查看磁盘图像，明确放弃本机草稿后再编辑。",
      );
    }
    state.current = {
      ...state.current,
      record: next,
      form: value,
      base: baseline,
      dirty: restored,
      locked: unreadable,
      cleanup: false,
    };
    setRecord(next);
    setForm(value);
    setBase(baseline);
    setDirty(restored);
    setLocked(unreadable);
    setCleanup(false);
    setPreviewTarget(next);
    setHistorical(false);
    setHistory([]);
    setHistoryError("");
    if (restored) setNotice("已恢复本机图像说明草稿；保存前请核对磁盘版本。");
  }
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(importKey);
      if (raw !== null) {
        const value = JSON.parse(raw);
        if (
          value.schemaVersion !== 1 ||
          value.bookId !== book.id ||
          Object.keys(value).sort().join(",") !== "bookId,id,schemaVersion"
        )
          throw Error();
        setPending(assetId(value.id));
      }
    } catch {
      setUnknownIntent(true);
      setError(
        "本机待确认导入记录无法识别或不能读取，已保留。请先核对资源列表。",
      );
    }
    return () => {
      alive.current = false;
      viewSeq.current++;
    };
  }, [book.id]);
  useEffect(() => registerEditorCloseGuard(persist), [book.id]);
  useEffect(() => {
    if (!dirty || locked || busy) return;
    const timer = setTimeout(persist, 160);
    return () => clearTimeout(timer);
  }, [form, dirty, locked, busy]);
  useEffect(() => {
    const token = ++listSeq.current;
    api<{ items: AssetRecord[]; total: number; errors: string[] }>(
      "assets.list",
      { bookId: book.id, options: { query, purpose, deleted, offset } },
    )
      .then((result) => {
        if (alive.current && token === listSeq.current) {
          setItems(result.items);
          setTotal(result.total);
          setListErrors(result.errors);
        }
      })
      .catch((e) => {
        if (alive.current && token === listSeq.current)
          setListErrors([message(e)]);
      });
  }, [book.id, query, purpose, deleted, offset, refresh]);
  useEffect(() => {
    let current = true;
    setPreview("");
    setPreviewError("");
    if (!previewTarget) return;
    api<{ dataUrl: string }>("assets.preview", {
      bookId: book.id,
      expected: expected(previewTarget),
      historical,
    })
      .then((result) => {
        if (current && alive.current) setPreview(result.dataUrl);
      })
      .catch((e) => {
        if (current && alive.current) setPreviewError(message(e));
      });
    return () => {
      current = false;
    };
  }, [
    book.id,
    previewTarget?.id,
    previewTarget?.diskHash,
    historical,
    refresh,
  ]);
  useEffect(() => {
    if (previewTarget) {
      previewHeading.current?.focus({ preventScroll: true });
      previewHeading.current?.scrollIntoView({ block: "nearest" });
    }
  }, [previewTarget?.id, previewTarget?.diskHash, historical]);
  useEffect(() => {
    let current = true;
    setHistory([]);
    setHistoryError("");
    if (!record) return;
    api<AssetRecord[]>("assets.history", { bookId: book.id, id: record.id })
      .then((value) => {
        if (current && alive.current) setHistory(value);
      })
      .catch((e) => {
        if (current && alive.current) setHistoryError(message(e));
      });
    return () => {
      current = false;
    };
  }, [record?.id, record?.diskHash, refresh]);
  useEffect(() => {
    let current = true;
    api<{ items: Card[]; total: number; errors: string[] }>("materials.list", {
      bookId: book.id,
      options: { query: cardQuery, offset: cardOffset },
    })
      .then((result) => {
        if (current && alive.current) {
          setCards(result.items);
          setCardTotal(result.total);
          setCardError(result.errors.join("；"));
        }
      })
      .catch((e) => {
        if (current && alive.current) setCardError(message(e));
      });
    return () => {
      current = false;
    };
  }, [book.id, cardQuery, cardOffset, refresh]);
  const linkedKey = form?.linkedIds.join(",") || "";
  useEffect(() => {
    let current = true;
    setLinkedCards({});
    api<{ id: string; title: string; state: string }[]>("assets.link-options", {
      bookId: book.id,
      ids: form?.linkedIds || [],
    })
      .then((items) => {
        if (current && alive.current)
          setLinkedCards(
            Object.fromEntries(
              items.map((item) => [
                item.id,
                item.title + (item.state === "deleted" ? "（已删除）" : ""),
              ]),
            ),
          );
      })
      .catch(() => {
        if (current && alive.current)
          setLinkedCards(
            Object.fromEntries(
              (form?.linkedIds || []).map((id) => [id, "关联资料暂不能读取"]),
            ),
          );
      });
    return () => {
      current = false;
    };
  }, [book.id, linkedKey, refresh]);
  function edit(patch: Partial<AssetInput>) {
    if (!state.current.form) return;
    const next = { ...state.current.form, ...patch };
    state.current = { ...state.current, form: next, dirty: true };
    setForm(next);
    setDirty(true);
    setNotice("");
  }
  function start() {
    state.current.busy = true;
    setBusy(true);
    setError("");
    setNotice("");
  }
  function finish() {
    state.current.busy = false;
    if (alive.current) setBusy(false);
  }
  async function open(id: string) {
    if (!persist()) return;
    const token = ++viewSeq.current;
    start();
    try {
      const next = await api<AssetRecord>("assets.read", {
        bookId: book.id,
        id,
      });
      if (alive.current && token === viewSeq.current) applyRecord(next);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      finish();
    }
  }
  function clearIntent() {
    try {
      localStorage.removeItem(importKey);
      setPending(null);
      setUnknownIntent(false);
      return true;
    } catch {
      setError("图像操作已结束，但待确认导入记录未能清理，请重试核对。");
      return false;
    }
  }
  async function importImage(id?: string) {
    if (!persist()) return;
    const intent = id || crypto.randomUUID();
    try {
      localStorage.setItem(
        importKey,
        JSON.stringify({ schemaVersion: 1, bookId: book.id, id: intent }),
      );
      setPending(intent);
    } catch {
      setError("本机不能记录导入身份，尚未打开文件选择器。请恢复存储后重试。");
      return;
    }
    start();
    try {
      const result = await api<{ cancelled: boolean; record?: AssetRecord }>(
        "assets.import",
        { bookId: book.id, creationId: intent },
      );
      if (!alive.current) return;
      if (result.cancelled) {
        clearIntent();
        setNotice("已取消导入，未创建新的图像记录。");
      } else if (result.record) {
        applyRecord(result.record);
        clearIntent();
        setNotice("原图已保存在当前作品中；尚未选作出版封面或人物定妆。");
        setRefresh((n) => n + 1);
      }
    } catch (e) {
      if (alive.current) {
        setError(message(e) + "；导入结果请先核对，不要重复创建。");
        setRefresh((n) => n + 1);
      }
    } finally {
      finish();
    }
  }
  async function reconcile() {
    if (!pending || !persist()) return;
    start();
    try {
      const found = await api<AssetRecord | null>("assets.creation", {
        bookId: book.id,
        id: pending,
      });
      if (found) {
        applyRecord(found);
        clearIntent();
        setNotice("已找到该次导入的保存记录，没有重复创建。");
        setRefresh((n) => n + 1);
      } else
        setNotice(
          "尚未找到该次导入的保存记录，可继续选择原图，或明确放弃这次导入。",
        );
    } catch (e) {
      setError(message(e));
    } finally {
      finish();
    }
  }
  async function save() {
    const current = state.current;
    if (
      current.busy ||
      current.locked ||
      current.cleanup ||
      !current.record ||
      !current.form ||
      !current.base
    )
      return;
    try {
      assetInput(current.form);
    } catch (e) {
      setError(message(e));
      return;
    }
    start();
    try {
      const saved = await api<AssetRecord>("assets.save", {
        bookId: book.id,
        input: current.form,
        expected: current.base,
      });
      if (!alive.current) return;
      state.current = {
        ...state.current,
        record: saved,
        form: fields(saved),
        base: expected(saved),
        dirty: false,
      };
      setRecord(saved);
      setForm(fields(saved));
      setBase(expected(saved));
      setDirty(false);
      setPreviewTarget(saved);
      setHistorical(false);
      if (clearDraft(saved.id)) setNotice("图像说明已保存。");
      setRefresh((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function mutate(action: "replace" | "delete", isDeleted = false) {
    const current = state.current;
    if (current.dirty || current.cleanup || !current.record || !persist())
      return;
    start();
    try {
      if (action === "replace") {
        const result = await api<{ cancelled: boolean; record?: AssetRecord }>(
          "assets.replace",
          { bookId: book.id, expected: expected(current.record) },
        );
        if (!result.cancelled && result.record) applyRecord(result.record);
        setNotice(
          result.cancelled
            ? "已取消替换，旧原图保留。"
            : "已替换为新图，旧原图和说明保留在历史中。",
        );
      } else {
        applyRecord(
          await api<AssetRecord>("assets.delete", {
            bookId: book.id,
            expected: expected(current.record),
            deleted: isDeleted,
          }),
        );
        setNotice(
          isDeleted ? "已移入回收站，原图和历史仍保留。" : "图像资源已恢复。",
        );
      }
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      finish();
    }
  }
  async function adoptHistory() {
    const current = state.current;
    if (
      !current.record ||
      !previewTarget ||
      !historical ||
      current.dirty ||
      current.cleanup ||
      current.locked ||
      current.busy
    )
      return;
    start();
    try {
      const next = await api<AssetRecord>("assets.restore-version", {
        bookId: book.id,
        expected: expected(current.record),
        historical: expected(previewTarget),
      });
      if (alive.current) {
        applyRecord(next);
        setNotice("已将历史图像及当时说明保存为新版本，原有版本继续保留。");
        setRefresh((n) => n + 1);
      }
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function discard() {
    if (!record || busy) return;
    try {
      localStorage.removeItem(key(record.id));
      const fresh = await api<AssetRecord>("assets.read", {
        bookId: book.id,
        id: record.id,
      });
      setError("");
      applyRecord(fresh);
      setNotice("已明确放弃本机调整，读取当前磁盘说明。");
    } catch (e) {
      setError(message(e));
    }
  }
  const stale =
    !!record &&
    !!base &&
    (base.diskHash !== record.diskHash || base.revision !== record.revision);
  const same =
    !!form &&
    !!record &&
    JSON.stringify(form) === JSON.stringify(fields(record));
  const disabled = busy || locked || cleanup || !!record?.deletedAt;
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="小说图像资源"
        className="assets-dialog"
      >
        <header className="assets-header">
          <div>
            <h2>小说图像资源</h2>
            <p>
              保存原图、用途与来源。封面候选、定妆和地图底图由作者管理，不会自动进入出版物。
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              if (persist()) onClose();
            }}
          >
            关闭图像资源
          </button>
        </header>
        <div className="assets-notices">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {cleanup && (
            <button onClick={() => record && clearDraft(record.id)}>
              重试清理图像草稿
            </button>
          )}
          {unknownIntent && (
            <button onClick={clearIntent}>明确清理无法识别的导入记录</button>
          )}
          {pending && (
            <div className="asset-pending">
              <p>
                有一项待确认导入。先核对已保存记录，继续时沿用同一导入身份。
              </p>
              <button disabled={busy} onClick={reconcile}>
                检查这次导入
              </button>
              <button disabled={busy} onClick={() => importImage(pending)}>
                继续选择原图
              </button>
              <button disabled={busy} onClick={clearIntent}>
                放弃这次待确认导入
              </button>
            </div>
          )}
        </div>
        <div className="assets-layout">
          <aside className="assets-catalog" aria-label="图像资源列表">
            <div className="asset-filters">
              <button
                disabled={busy || !!pending || unknownIntent}
                onClick={() => importImage()}
              >
                导入原图
              </button>
              <button disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
                刷新资源
              </button>
              <label>
                搜索图像
                <input
                  aria-label="搜索图像"
                  maxLength={200}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <label>
                筛选用途
                <select
                  value={purpose}
                  onChange={(e) => {
                    setPurpose(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">全部用途</option>
                  {Object.entries(purposes).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="asset-checkbox">
                <input
                  type="checkbox"
                  checked={deleted}
                  onChange={(e) => {
                    setDeleted(e.target.checked);
                    setOffset(0);
                  }}
                />
                查看回收站
              </label>
            </div>
            {listErrors.map((text, i) => (
              <p role="alert" key={i}>
                {text}
              </p>
            ))}
            <p>{total} 份资源 · 每页最多40份</p>
            <div className="asset-list">
              {items.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={record?.id === item.id}
                  disabled={busy}
                  onClick={() => open(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {purposes[item.purpose]} · {item.blob.displayWidth} ×{" "}
                    {item.blob.displayHeight} · 第{item.revision}版
                  </span>
                </button>
              ))}
            </div>
            <nav aria-label="图像列表分页">
              <button
                disabled={busy || offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - 40))}
              >
                上一页图像
              </button>
              <button
                disabled={busy || offset + 40 >= total}
                onClick={() => setOffset((n) => n + 40)}
              >
                下一页图像
              </button>
            </nav>
            <p className="muted">
              支持静态
              PNG/JPEG/WebP，单张20MiB、2000万像素以内。原图在打开预览时重新核验。
            </p>
          </aside>
          <main className="asset-detail">
            {!record || !form ? (
              <p>
                导入一张原图，或从列表选择资源。图像服务和网络不是本地管理的前提。
              </p>
            ) : (
              <>
                <div className="asset-image">
                  <h3 ref={previewHeading} tabIndex={-1}>
                    {historical
                      ? `历史图像 · 第${previewTarget?.revision}版`
                      : "当前原图预览"}
                  </h3>
                  {previewError ? (
                    <p role="alert">{previewError}</p>
                  ) : preview ? (
                    <img
                      src={preview}
                      alt={(previewTarget?.title || record.title) + " 图像预览"}
                      onError={() =>
                        setPreviewError("预览无法显示，原图未被修改。")
                      }
                    />
                  ) : (
                    <p>正在核对原图与生成预览…</p>
                  )}
                  <p>
                    {previewTarget?.blob.displayWidth} ×{" "}
                    {previewTarget?.blob.displayHeight} ·{" "}
                    {previewTarget?.blob.mime} ·{" "}
                    {Math.ceil((previewTarget?.blob.bytes || 0) / 1024)} KiB
                  </p>
                  {historical && (
                    <button
                      onClick={() => {
                        setPreviewTarget(record);
                        setHistorical(false);
                      }}
                    >
                      查看当前版本图像
                    </button>
                  )}
                  {historical && (
                    <button disabled={disabled || dirty} onClick={adoptHistory}>
                      采用此历史图像与说明为新版本
                    </button>
                  )}
                </div>
                {locked && (
                  <p role="alert">未知本机草稿已保留，明确放弃后才能编辑。</p>
                )}
                {stale && (
                  <div role="alert">
                    <p>
                      本机调整的磁盘版本已改变。可以查看磁盘说明供对照，或明确保留调整并采用当前磁盘版本为基线。
                    </p>
                    <button
                      disabled={busy || locked}
                      onClick={() => {
                        const next = expected(record);
                        state.current.base = next;
                        setBase(next);
                        setNotice("已采用当前磁盘基线，请核对调整并明确保存。");
                      }}
                    >
                      保留调整并采用当前磁盘基线
                    </button>
                  </div>
                )}
                {dirty && same && (
                  <p>
                    当前调整与磁盘说明相同，可明确放弃本机草稿，不必重复保存。
                  </p>
                )}
                <div className="asset-form">
                  <label>
                    图像标题
                    <input
                      aria-label="图像标题"
                      disabled={disabled}
                      maxLength={200}
                      value={form.title}
                      onChange={(e) => edit({ title: e.target.value })}
                    />
                  </label>
                  <label>
                    图像用途
                    <select
                      aria-label="图像用途"
                      disabled={disabled}
                      value={form.purpose}
                      onChange={(e) =>
                        edit({ purpose: e.target.value as AssetPurpose })
                      }
                    >
                      {Object.entries(purposes).map(([id, title]) => (
                        <option value={id} key={id}>
                          {title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    来源说明
                    <textarea
                      aria-label="来源说明"
                      disabled={disabled}
                      maxLength={4000}
                      value={form.source}
                      onChange={(e) => edit({ source: e.target.value })}
                    />
                  </label>
                  <label>
                    权利与使用范围
                    <textarea
                      aria-label="权利与使用范围"
                      disabled={disabled}
                      maxLength={4000}
                      value={form.rights}
                      onChange={(e) => edit({ rights: e.target.value })}
                    />
                  </label>
                  <label>
                    图像笔记
                    <textarea
                      aria-label="图像笔记"
                      disabled={disabled}
                      maxLength={16000}
                      value={form.notes}
                      onChange={(e) => edit({ notes: e.target.value })}
                    />
                  </label>
                </div>
                <details className="asset-links">
                  <summary>
                    关联人物、地点或其他创作资料（{form.linkedIds.length}/32）
                  </summary>
                  <ul>
                    {form.linkedIds.map((id) => (
                      <li key={id}>
                        {linkedCards[id] || "正在读取关联资料…"}
                        <button
                          disabled={disabled}
                          onClick={() =>
                            edit({
                              linkedIds: form.linkedIds.filter(
                                (value) => value !== id,
                              ),
                            })
                          }
                        >
                          移除关联
                        </button>
                      </li>
                    ))}
                  </ul>
                  <label>
                    查找关联资料
                    <input
                      disabled={disabled}
                      value={cardQuery}
                      maxLength={200}
                      onChange={(e) => {
                        setCardQuery(e.target.value);
                        setCardOffset(0);
                      }}
                    />
                  </label>
                  {cardError && <p role="alert">{cardError}</p>}
                  <div className="asset-link-options">
                    {cards.map((card) => (
                      <label className="asset-checkbox" key={card.id}>
                        <input
                          type="checkbox"
                          disabled={
                            disabled ||
                            (!form.linkedIds.includes(card.id) &&
                              form.linkedIds.length >= 32)
                          }
                          checked={form.linkedIds.includes(card.id)}
                          onChange={(e) =>
                            edit({
                              linkedIds: e.target.checked
                                ? [...form.linkedIds, card.id]
                                : form.linkedIds.filter((id) => id !== card.id),
                            })
                          }
                        />
                        {card.title}
                      </label>
                    ))}
                  </div>
                  <button
                    disabled={disabled || !cardOffset}
                    onClick={() => setCardOffset((n) => Math.max(0, n - 40))}
                  >
                    上一页关联资料
                  </button>
                  <button
                    disabled={disabled || cardOffset + 40 >= cardTotal}
                    onClick={() => setCardOffset((n) => n + 40)}
                  >
                    下一页关联资料
                  </button>
                </details>
                <div className="asset-actions">
                  <button
                    disabled={busy}
                    onClick={() => record && open(record.id)}
                  >
                    读取磁盘版本供对照
                  </button>
                  <button
                    data-dialog-save
                    disabled={disabled || !dirty || same || stale}
                    onClick={save}
                  >
                    保存图像说明
                  </button>
                  <button disabled={busy} onClick={discard}>
                    放弃本机调整并重新读取
                  </button>
                  <button
                    disabled={disabled || dirty}
                    onClick={() => mutate("replace")}
                  >
                    替换原图并保留历史
                  </button>
                  {record.deletedAt ? (
                    <button
                      disabled={busy || dirty || locked || cleanup}
                      onClick={() => mutate("delete", false)}
                    >
                      恢复图像资源
                    </button>
                  ) : (
                    <button
                      disabled={disabled || dirty}
                      onClick={() => mutate("delete", true)}
                    >
                      移入图像回收站
                    </button>
                  )}
                </div>
                <details>
                  <summary>磁盘说明供对照 · 第{record.revision}版</summary>
                  <p>
                    {record.title} · {purposes[record.purpose]}
                  </p>
                  <pre>
                    {[record.source, record.rights, record.notes]
                      .filter(Boolean)
                      .join("\n\n")}
                  </pre>
                </details>
                <section className="asset-history" aria-label="图像历史">
                  <h3>历史版本</h3>
                  <p>
                    最多显示最近40个历史版本。查看历史不会替换当前原图或说明。
                  </p>
                  {historyError && <p role="alert">{historyError}</p>}
                  {history.map((item) => (
                    <button
                      key={item.revision}
                      disabled={busy}
                      onClick={() => {
                        setPreviewTarget(item);
                        setHistorical(true);
                      }}
                    >
                      查看第{item.revision}版图像 · {item.title}
                    </button>
                  ))}
                </section>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
