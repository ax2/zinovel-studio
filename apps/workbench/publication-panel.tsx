import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import type {
  PublicationMetadata,
  PublicationChapter,
} from "../../packages/novel-domain/publication.mjs";
import { registerEditorCloseGuard } from "./editor-close-guards";

type Catalog = {
  hash: string;
  bookRevision: number;
  chapters: {
    id: string;
    title: string;
    status: string;
    volumeTitle: string;
  }[];
};
type Saved = {
  id: string;
  hash: string;
  createdAt: string;
  metadata: PublicationMetadata;
  chapterCount: number;
  externalChapterIds: string[];
};
type Preview = {
  id: string;
  hash: string;
  createdAt: string;
  content: {
    metadata: PublicationMetadata;
    bookRevision: number;
    chapters: Omit<PublicationChapter, "body">[];
  };
};
type Job = {
  id: string;
  status: string;
  progress: { completed: number; total: number } | null;
  result: { id: string; hash: string } | null;
  error: string | null;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const fields: [keyof PublicationMetadata, string][] = [
  ["title", "公开书名"],
  ["author", "署名"],
  ["synopsis", "公开简介"],
  ["rights", "版权说明"],
  ["aiDisclosure", "AI 辅助说明"],
];
const defaults = (book: Book): PublicationMetadata => ({
  title: book.title,
  author: book.author || "",
  synopsis: "",
  rights: "",
  aiDisclosure: "",
});
function wellFormed(text: string) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
      return false;
  }
  return true;
}
function initialForm(book: Book, key: string) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw)
      return { metadata: defaults(book), ids: [] as string[], locked: false };
    const value = JSON.parse(raw);
    if (
      value.schemaVersion !== 1 ||
      Object.keys(value).length !== 4 ||
      Object.keys(value).some(
        (name) =>
          !["schemaVersion", "bookId", "metadata", "ids"].includes(name),
      ) ||
      value.bookId !== book.id ||
      !Array.isArray(value.ids) ||
      value.ids.length > 10000 ||
      value.ids.some((id: unknown) => !uuid(id)) ||
      new Set(value.ids).size !== value.ids.length ||
      !value.metadata ||
      Object.keys(value.metadata).length !== fields.length ||
      fields.some(
        ([name]) =>
          typeof value.metadata[name] !== "string" ||
          value.metadata[name].length > 16000 ||
          !wellFormed(value.metadata[name]),
      )
    )
      throw new Error("Unsupported form");
    return {
      metadata: value.metadata as PublicationMetadata,
      ids: value.ids as string[],
      locked: false,
    };
  } catch {
    return { metadata: defaults(book), ids: [] as string[], locked: true };
  }
}

export function PublicationPanel({
  book,
  onClose,
}: {
  book: Book;
  onClose: () => void;
}) {
  const key = `zinovel.publication-form.${book.id}`;
  const [initial] = useState(() => initialForm(book, key));
  const [metadata, setMetadata] = useState(initial.metadata),
    [ids, setIds] = useState(initial.ids);
  const [locked, setLocked] = useState(initial.locked),
    [cacheError, setCacheError] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [saved, setSaved] = useState<Saved[]>([]),
    [damaged, setDamaged] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null),
    [chapterId, setChapterId] = useState(""),
    [chapter, setChapter] = useState<PublicationChapter | null>(null);
  const [jobId, setJobId] = useState<string | null>(null),
    [job, setJob] = useState<Job | null>(null),
    [capturing, setCapturing] = useState(false),
    [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState("html"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true),
    [historyReady, setHistoryReady] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const form = useRef({ metadata, ids }),
    dirty = useRef(false),
    alive = useRef(true),
    busy = useRef(false),
    previewSequence = useRef(0);
  const titleById = new Map(
    catalog?.chapters.map((item) => [item.id, item.title]),
  );
  const missing = ids.some((id) => !titleById.has(id));
  function persist() {
    if (!dirty.current) return true;
    if (locked) return false;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ schemaVersion: 1, bookId: book.id, ...form.current }),
      );
      dirty.current = false;
      setCacheError("");
      return true;
    } catch {
      setCacheError(
        "发布表单尚未保存到本机缓存；输入仍在当前窗口，请重试或明确丢弃。",
      );
      return false;
    }
  }
  const closeGuard = useRef(persist);
  closeGuard.current = persist;
  useEffect(() => registerEditorCloseGuard(() => closeGuard.current()), []);
  useEffect(() => {
    const timer = setTimeout(() => persist(), 120);
    return () => clearTimeout(timer);
  }, [metadata, ids, locked]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function change(nextMetadata: PublicationMetadata, nextIds: string[]) {
    form.current = { metadata: nextMetadata, ids: nextIds };
    dirty.current = true;
    setMetadata(nextMetadata);
    setIds(nextIds);
  }
  async function refresh() {
    setError("");
    setLoading(true);
    const [source, history] = await Promise.allSettled([
      api<Catalog>("publication.catalog", { bookId: book.id }),
      api<{
        snapshots: Saved[];
        errors: { id?: string; file?: string; error: string }[];
      }>("publication.list", { bookId: book.id }),
    ]);
    if (!alive.current) return;
    setLoading(false);
    if (source.status === "fulfilled") {
      setCatalog(source.value);
      setPage(0);
    } else {
      setCatalog(null);
      setError(source.reason.message);
    }
    if (history.status === "fulfilled") {
      setHistoryReady(true);
      setSaved(history.value.snapshots);
      setDamaged(
        history.value.errors.map(
          (item) =>
            `${item.id?.slice(0, 8) || item.file || "未知条目"}：${item.error}`,
        ),
      );
    } else {
      setHistoryReady(false);
      setError(history.reason.message);
    }
  }
  useEffect(() => {
    void refresh();
  }, [book.id]);
  async function openSnapshot(selected: { id: string; hash: string }) {
    const sequence = ++previewSequence.current;
    setPreview(null);
    setChapter(null);
    setError("");
    try {
      const value = await api<Preview>("publication.preview", {
        bookId: book.id,
        ...selected,
      });
      if (!alive.current || sequence !== previewSequence.current) return;
      setPreview(value);
      setChapterId(value.content.chapters[0]?.id || "");
    } catch (e) {
      if (alive.current && sequence === previewSequence.current)
        setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    setChapter(null);
    if (preview && chapterId)
      void api<PublicationChapter>("publication.chapter", {
        bookId: book.id,
        id: preview.id,
        hash: preview.hash,
        chapterId,
      })
        .then((value) => {
          if (active) setChapter(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [preview?.id, chapterId]);
  useEffect(() => {
    if (preview) {
      previewHeading.current?.focus({ preventScroll: true });
      previewHeading.current?.scrollIntoView({ block: "start" });
    }
  }, [preview?.id]);
  useEffect(() => {
    if (!jobId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<Job>("publication.capture-status", {
          bookId: book.id,
          id: jobId,
        });
        if (!active) return;
        setJob(value);
        if (["completed", "cancelled", "failed"].includes(value.status)) {
          busy.current = false;
          setCapturing(false);
          setJobId(null);
          if (value.status === "completed" && value.result) {
            dirty.current = false;
            setCacheError((previous) =>
              previous ? "表单缓存未写入；本次发布副本已保存在作品中。" : "",
            );
            setNotice("发布副本已保存在作品中，后续改稿不会更改它。");
            await refresh();
            await openSnapshot(value.result);
          } else if (value.status === "failed")
            setError(value.error || "捕获失败，原稿已保留");
          else setNotice("已取消捕获，未创建发布副本。");
          return;
        }
        timer = setTimeout(poll, 80);
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          busy.current = false;
          setCapturing(false);
          setJobId(null);
        }
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId]);
  async function capture() {
    if (busy.current || !catalog || locked || !ids.length || missing) return;
    busy.current = true;
    setCapturing(true);
    setError("");
    setNotice("");
    setJob(null);
    try {
      const value = await api<{ id: string }>("publication.capture", {
        bookId: book.id,
        input: {
          catalogHash: catalog.hash,
          chapterIds: [...ids],
          metadata: { ...metadata },
        },
      });
      setJobId(value.id);
    } catch (e) {
      setError((e as Error).message);
      busy.current = false;
      setCapturing(false);
    }
  }
  async function cancel() {
    if (!jobId) return;
    try {
      const result = await api<{ cancelled: boolean }>("publication.cancel", {
        bookId: book.id,
        id: jobId,
      });
      if (!result.cancelled) setNotice("副本正在保存，完成后即可查看。");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportSelected() {
    if (!preview || exporting || busy.current) return;
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ cancelled: boolean; path?: string }>(
        "publication.export",
        { bookId: book.id, id: preview.id, hash: preview.hash, format },
      );
      if (alive.current)
        setNotice(
          result.cancelled
            ? "已取消导出，未创建文件。"
            : `本地导出完成：${result.path}`,
        );
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setExporting(false);
    }
  }
  function close() {
    if (busy.current || exporting) {
      setError("当前操作尚未结束，请等待完成或先取消捕获。");
      return;
    }
    if (persist()) onClose();
  }
  const metadataField = ([name, label]: [
    keyof PublicationMetadata,
    string,
  ]) => (
    <label key={name}>
      {label}
      {name === "synopsis" || name === "rights" || name === "aiDisclosure" ? (
        <textarea
          aria-label={label}
          value={metadata[name]}
          maxLength={name === "synopsis" ? 8000 : 4000}
          onChange={(event) =>
            change({ ...metadata, [name]: event.target.value }, ids)
          }
        />
      ) : (
        <input
          aria-label={label}
          value={metadata[name]}
          maxLength={200}
          onChange={(event) =>
            change({ ...metadata, [name]: event.target.value }, ids)
          }
        />
      )}
    </label>
  );
  return (
    <div className="modal-backdrop">
      <section
        className="modal publication-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导出发布副本"
      >
        <header className="modal-heading">
          <div>
            <h2>导出发布副本</h2>
            <p className="muted">
              选择章节与公开信息，保存独立副本，再导出本地 TXT、Markdown 或
              HTML。
            </p>
          </div>
          <button
            aria-label="关闭发布副本"
            disabled={capturing || exporting}
            onClick={close}
          >
            关闭
          </button>
        </header>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="publication-notice">
            {notice}
          </p>
        )}
        {locked && (
          <p role="alert">
            本机发布表单缓存无法识别，原值已保留。
            <button
              onClick={() => {
                try {
                  localStorage.removeItem(key);
                  setLocked(false);
                  change(defaults(book), []);
                } catch {
                  setCacheError("缓存重置失败，原值已保留。");
                }
              }}
            >
              明确重置发布表单
            </button>
          </p>
        )}
        {cacheError && (
          <div role="alert">
            <p>{cacheError}</p>
            <button
              onClick={() => {
                dirty.current = true;
                persist();
              }}
            >
              重试保存表单
            </button>
            <button
              disabled={capturing || exporting}
              onClick={() => {
                dirty.current = false;
                onClose();
              }}
            >
              丢弃未保存更改并关闭
            </button>
          </div>
        )}
        <div className="publication-columns">
          <section className="publication-compose" aria-label="创建发布副本">
            <h3>创建副本</h3>
            <fieldset disabled={capturing || exporting || locked}>
              <div className="publication-fields">
                {fields.slice(0, 2).map(metadataField)}
              </div>
              <details className="publication-more">
                <summary>简介、版权与 AI 说明</summary>
                <div className="publication-fields">
                  {fields.slice(2).map(metadataField)}
                </div>
              </details>
              <div className="publication-actions">
                <button
                  onClick={() =>
                    catalog &&
                    change(
                      metadata,
                      catalog.chapters.map((item) => item.id),
                    )
                  }
                >
                  选全部有效章
                </button>
                <button
                  onClick={() =>
                    catalog &&
                    change(
                      metadata,
                      catalog.chapters
                        .filter((item) => item.status === "final")
                        .map((item) => item.id),
                    )
                  }
                >
                  仅选定稿
                </button>
                <button onClick={() => change(metadata, [])}>清空选择</button>
              </div>
              <div className="publication-source" aria-label="发布章节选择">
                {catalog?.chapters
                  .slice(page * 40, page * 40 + 40)
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={ids.includes(item.id)}
                        onChange={(event) =>
                          change(
                            metadata,
                            event.target.checked
                              ? [...ids, item.id]
                              : ids.filter((id) => id !== item.id),
                          )
                        }
                      />
                      {item.title}
                      <small>
                        {item.status === "final"
                          ? "定稿"
                          : item.status === "reviewed"
                            ? "已审读"
                            : "草稿"}
                      </small>
                    </label>
                  ))}
              </div>
              {loading ? (
                <p className="muted">正在读取目录与副本…</p>
              ) : (
                !catalog?.chapters.length && (
                  <p className="muted">
                    当前没有有效章节，已有发布副本仍可查看。
                  </p>
                )
              )}
              <div className="publication-actions">
                <button
                  disabled={!page}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页章节
                </button>
                <span>第 {page + 1} 页</span>
                <button
                  disabled={
                    !catalog || (page + 1) * 40 >= catalog.chapters.length
                  }
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页章节
                </button>
              </div>
              <h4>已选 {ids.length} 章 · 按此顺序</h4>
              <ol className="publication-order">
                {ids.map((id, index) => (
                  <li key={id}>
                    <span>
                      {titleById.get(id) || "来源失联：请移除此选择后重新核对"}
                    </span>
                    <button
                      aria-label={`上移第${index + 1}个选章`}
                      disabled={!index}
                      onClick={() => {
                        const next = [...ids];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        change(metadata, next);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`下移第${index + 1}个选章`}
                      disabled={index === ids.length - 1}
                      onClick={() => {
                        const next = [...ids];
                        [next[index + 1], next[index]] = [
                          next[index],
                          next[index + 1],
                        ];
                        change(metadata, next);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      aria-label={`移除第${index + 1}个选章`}
                      onClick={() =>
                        change(
                          metadata,
                          ids.filter((value) => value !== id),
                        )
                      }
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ol>
              {missing && (
                <p role="alert">
                  所选章节存在失联来源，不能捕获半本内容。请刷新目录并明确调整选择。
                </p>
              )}
              <div className="publication-actions">
                <button
                  data-dialog-save
                  onClick={() => {
                    dirty.current = true;
                    if (persist()) setNotice("发布表单已保存在本机。");
                  }}
                >
                  保存表单
                </button>
                <button onClick={() => void refresh()}>刷新目录与副本</button>
              </div>
            </fieldset>
            <button
              className="primary"
              disabled={
                capturing ||
                exporting ||
                locked ||
                !catalog ||
                !ids.length ||
                missing ||
                !metadata.title.trim()
              }
              onClick={() => void capture()}
            >
              创建发布副本
            </button>
            {capturing && (
              <div role="status">
                <p>
                  {job?.status === "committing"
                    ? "正在保存副本…"
                    : job?.status === "verifying"
                      ? "正在核对来源…"
                      : job?.status === "cancelling"
                        ? "正在取消…"
                        : "正在捕获正文…"}
                  {job?.progress
                    ? ` ${job.progress.completed}/${job.progress.total}`
                    : ""}
                </p>
                <button
                  disabled={
                    job?.status === "committing" || job?.status === "cancelling"
                  }
                  onClick={() => void cancel()}
                >
                  取消捕获
                </button>
              </div>
            )}
          </section>
          <section className="publication-preview" aria-label="已保存发布副本">
            <h3>已保存副本</h3>
            {damaged.map((text, index) => (
              <p role="alert" key={index}>
                {text}
              </p>
            ))}
            <div className="publication-history">
              {saved.map((item) => (
                <button
                  key={item.id}
                  className={preview?.id === item.id ? "selected" : ""}
                  disabled={exporting}
                  onClick={() => void openSnapshot(item)}
                >
                  <strong>{item.metadata.title}</strong>
                  <small>
                    {new Date(item.createdAt).toLocaleString()} ·{" "}
                    {item.chapterCount} 章
                    {item.externalChapterIds.length
                      ? " · 含外部改稿，请核对"
                      : ""}
                  </small>
                </button>
              ))}
            </div>
            {!saved.length && historyReady && !damaged.length && (
              <p className="muted">尚无副本。先从左侧选择章节并保存。</p>
            )}
            {preview && (
              <>
                <h3 ref={previewHeading} tabIndex={-1}>
                  {preview.content.metadata.title}
                </h3>
                <p className="muted">
                  {preview.content.metadata.author} · 冻结于{" "}
                  {new Date(preview.createdAt).toLocaleString()} · 来源版本{" "}
                  {preview.content.bookRevision}
                </p>
                {preview.content.chapters.some(
                  (item) => item.bodyHash !== item.savedHash,
                ) && (
                  <p role="alert">
                    此副本含当时磁盘上的外部改稿，内容与原保存版本不同。请逐章核对后再导出。
                  </p>
                )}
                {(["synopsis", "rights", "aiDisclosure"] as const).map(
                  (name) =>
                    preview.content.metadata[name] && (
                      <p className="publication-meta" key={name}>
                        {preview.content.metadata[name]}
                      </p>
                    ),
                )}
                <label>
                  副本章节
                  <select
                    aria-label="副本章节"
                    value={chapterId}
                    onChange={(event) => setChapterId(event.target.value)}
                  >
                    {preview.content.chapters.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.volumeTitle ? `${item.volumeTitle} · ` : ""}
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <article
                  className="publication-body"
                  aria-label={
                    chapter
                      ? `发布副本章节：${chapter.title}`
                      : "正在读取副本章节"
                  }
                >
                  {chapter ? (
                    <>
                      <h4>{chapter.title}</h4>
                      <div>{chapter.body}</div>
                    </>
                  ) : (
                    "正在读取副本章节…"
                  )}
                </article>
                <div className="publication-actions">
                  <label>
                    导出格式
                    <select
                      aria-label="发布副本导出格式"
                      value={format}
                      disabled={exporting}
                      onChange={(event) => setFormat(event.target.value)}
                    >
                      <option value="html">HTML 阅读目录</option>
                      <option value="md">Markdown</option>
                      <option value="txt">TXT（UTF-8）</option>
                    </select>
                  </label>
                  <button
                    className="primary"
                    disabled={exporting || capturing || !chapter}
                    onClick={() => void exportSelected()}
                  >
                    {exporting ? "正在导出…" : "导出此副本"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
