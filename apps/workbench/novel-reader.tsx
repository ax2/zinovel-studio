import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import {
  parseReadingState,
  resumeReading,
} from "../../packages/novel-domain/reading.mjs";
type Options = { status: string; volumeId: string | null };
type ChapterMeta = {
  id: string;
  title: string;
  revision: number;
  status: string;
  volumeId: string | null;
  volumeTitle: string;
};
type Catalog = {
  book: { id: string; title: string; author: string };
  hash: string;
  options: Options;
  chapters: ChapterMeta[];
  volumes: { id: string; title: string }[];
};
type ReadingChapter = ChapterMeta & {
  body: string;
  bodyHash: string;
  externalChange: boolean;
};
const lines = (body: string) => body.split(/\r\n|\r|\n/);
export function NovelReader({
  bookId,
  initialChapterId,
  onClose,
}: {
  bookId: string;
  initialChapterId?: string;
  onClose: () => void;
}) {
  const key = `zinovel.reading.${bookId}`;
  const [initial] = useState(() => {
    try {
      return {
        value: parseReadingState(localStorage.getItem(key), bookId),
        locked: false,
      };
    } catch {
      return { value: parseReadingState(null, bookId), locked: true };
    }
  });
  const state = useRef(initial.value),
    locked = useRef(initial.locked),
    active = useRef(true),
    sequence = useRef(0),
    restoring = useRef(false),
    position = useRef(0),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const area = useRef<HTMLDivElement>(null),
    paragraphNodes = useRef<HTMLElement[]>([]);
  const [preferences, setPreferences] = useState(initial.value.preferences),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [chapter, setChapter] = useState<ReadingChapter | null>(null),
    [options, setOptions] = useState<Options>({
      status: "all",
      volumeId: null,
    }),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [localError, setLocalError] = useState(
      initial.locked
        ? "本机阅读记录无法读取，原值已保留。可继续阅读，但暂不覆盖本机记录。"
        : "",
    ),
    [currentParagraph, setCurrentParagraph] = useState(0),
    [sourceChanged, setSourceChanged] = useState(false),
    [toc, setToc] = useState(true);
  function persist(force = false) {
    clearTimeout(saveTimer.current);
    if (locked.current && !force) return false;
    try {
      localStorage.setItem(key, JSON.stringify(state.current));
      locked.current = false;
      if (active.current) setLocalError("");
      return true;
    } catch {
      if (active.current)
        setLocalError(
          "本机阅读进度暂未保存，已有记录保留。可重试保存；正文未改变。",
        );
      return false;
    }
  }
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    active.current = true;
    const unsubscribe = window.novel.onClosing(() => {
      persistRef.current();
    });
    return () => {
      active.current = false;
      sequence.current++;
      clearTimeout(saveTimer.current);
      persistRef.current();
      unsubscribe();
    };
  }, []);
  async function openChapter(
    value: Catalog,
    id: string,
    token: number,
    explicit = false,
  ) {
    setBusy(true);
    setError("");
    setChapter(null);
    try {
      const result = await api<ReadingChapter>("reader.chapter", {
        bookId,
        chapterId: id,
        catalogHash: value.hash,
        options: value.options,
      });
      if (!active.current || token !== sequence.current) return;
      const resumed = resumeReading(
        state.current.progress,
        result,
        lines(result.body).length,
      );
      position.current = resumed.paragraph;
      setCurrentParagraph(resumed.paragraph);
      setSourceChanged(resumed.changed);
      if (resumed.changed)
        setNotice(
          "正文已改变，已定位到本章开头；原阅读位置保留，不猜测改稿后的位置。",
        );
      else if (state.current.progress?.chapterId === id)
        setNotice("已恢复本机阅读位置。");
      if (!state.current.progress || explicit) {
        state.current = {
          ...state.current,
          progress: {
            chapterId: id,
            bodyHash: result.bodyHash,
            paragraph: resumed.paragraph,
          },
        };
        persist();
        if (explicit) {
          setSourceChanged(false);
          setNotice("已打开所选章节。");
        }
      }
      setChapter(result);
    } catch (e) {
      if (active.current && token === sequence.current)
        setError((e as Error).message);
    } finally {
      if (active.current && token === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    const token = ++sequence.current;
    persistRef.current();
    setBusy(true);
    setError("");
    setNotice("");
    setChapter(null);
    void api<Catalog>("reader.catalog", { bookId, options })
      .then(async (value) => {
        if (!active.current || token !== sequence.current) return;
        setCatalog(value);
        const progressId = state.current.progress?.chapterId,
          remembered = value.chapters.find((item) => item.id === progressId),
          initialChapter = value.chapters.find(
            (item) => item.id === initialChapterId,
          ),
          first = remembered || initialChapter || value.chapters[0];
        if (progressId && !remembered)
          setNotice(
            "原阅读章节已删除或不在当前范围，原进度保留。请选择要读的章节。",
          );
        if (first) await openChapter(value, first.id, token);
        else setBusy(false);
      })
      .catch((e) => {
        if (active.current && token === sequence.current) {
          setCatalog(null);
          setError(e.message);
          setBusy(false);
        }
      });
    return () => {
      if (sequence.current === token) sequence.current++;
    };
  }, [bookId, options, refresh]);
  const paragraphs = useMemo(
    () => (chapter ? lines(chapter.body) : []),
    [chapter?.body],
  );
  const paragraphContent = useMemo(
    () =>
      paragraphs.map((text, index) => (
        <p data-reader-paragraph={index} key={index}>
          {text || "\u00a0"}
        </p>
      )),
    [paragraphs],
  );
  useLayoutEffect(() => {
    if (!chapter || !area.current) return;
    restoring.current = true;
    paragraphNodes.current = Array.from(
      area.current.querySelectorAll<HTMLElement>("[data-reader-paragraph]"),
    );
    const container = area.current,
      node = paragraphNodes.current[position.current];
    if (!position.current || !node) container.scrollTop = 0;
    else
      container.scrollTop +=
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        24;
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    chapter?.id,
    chapter?.bodyHash,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.width,
    toc,
  ]);
  function recordProgress(immediate = false) {
    if (!chapter || !area.current || restoring.current) return;
    const nodes = paragraphNodes.current,
      top = area.current.getBoundingClientRect().top + 24;
    let low = 0,
      high = nodes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (nodes[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const index = Math.min(low, Math.max(0, nodes.length - 1));
    position.current = index;
    setCurrentParagraph(index);
    state.current = {
      ...state.current,
      progress: {
        chapterId: chapter.id,
        bodyHash: chapter.bodyHash,
        paragraph: index,
      },
    };
    if (sourceChanged) {
      setSourceChanged(false);
      setNotice("已按当前正文重新记录阅读位置。");
    }
    clearTimeout(saveTimer.current);
    if (immediate) persist();
    else saveTimer.current = setTimeout(() => persistRef.current(), 200);
  }
  function changePreference(name: string, value: string | number) {
    const next = { ...preferences, [name]: value };
    state.current = { ...state.current, preferences: next };
    setPreferences(next);
    persist();
  }
  function navigate(id?: string) {
    if (!catalog || !id || busy) return;
    persist();
    void openChapter(catalog, id, ++sequence.current, true);
  }
  const index =
    catalog?.chapters.findIndex((item) => item.id === chapter?.id) ?? -1;
  return (
    <div
      className={`modal-backdrop reader-backdrop reader-theme-${preferences.theme}`}
    >
      <section
        className="novel-reader"
        role="dialog"
        aria-modal="true"
        aria-label="独立阅读预览"
        style={
          {
            "--reader-font": `${preferences.fontSize}px`,
            "--reader-leading": preferences.lineHeight,
          } as React.CSSProperties
        }
      >
        <header className="reader-header">
          <div>
            <h2>{catalog?.book.title || "独立阅读预览"}</h2>
            <p>
              {catalog?.book.author || "小说正文试读"} ·
              只读，不显示作者资料与任务
            </p>
          </div>
          <button
            aria-label="关闭独立阅读"
            onClick={() => {
              persist();
              onClose();
            }}
          >
            关闭
          </button>
        </header>
        <div className="reader-controls">
          <button aria-expanded={toc} onClick={() => setToc(!toc)}>
            阅读目录
          </button>
          <button
            onClick={() => {
              setToc(false);
              requestAnimationFrame(() => area.current?.focus());
            }}
          >
            跳到阅读正文
          </button>
          <label>
            章节范围
            <select
              aria-label="阅读章节范围"
              value={options.status}
              disabled={busy}
              onChange={(e) =>
                setOptions({ ...options, status: e.target.value })
              }
            >
              <option value="all">全部章节（不含回收站）</option>
              <option value="final">仅正式章节</option>
            </select>
          </label>
          <label>
            分卷
            <select
              aria-label="阅读分卷"
              value={options.volumeId || ""}
              disabled={busy}
              onChange={(e) =>
                setOptions({ ...options, volumeId: e.target.value || null })
              }
            >
              <option value="">全部分卷</option>
              {catalog?.volumes.map((volume) => (
                <option key={volume.id} value={volume.id}>
                  {volume.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            字体
            <select
              aria-label="阅读字体大小"
              value={preferences.fontSize}
              onChange={(e) =>
                changePreference("fontSize", Number(e.target.value))
              }
            >
              {[16, 18, 20, 24, 28, 32].map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
          <label>
            行距
            <select
              aria-label="阅读行距"
              value={preferences.lineHeight}
              onChange={(e) =>
                changePreference("lineHeight", Number(e.target.value))
              }
            >
              {[1.5, 1.8, 2.1, 2.4].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label>
            背景
            <select
              aria-label="阅读背景"
              value={preferences.theme}
              onChange={(e) => changePreference("theme", e.target.value)}
            >
              <option value="light">浅色</option>
              <option value="sepia">纸色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            版面
            <select
              aria-label="阅读版面"
              value={preferences.width}
              onChange={(e) => changePreference("width", e.target.value)}
            >
              <option value="desktop">桌面宽度</option>
              <option value="phone">390px手机宽度</option>
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新阅读目录
          </button>
        </div>
        <div className={`reader-layout ${toc ? "" : "reader-without-toc"}`}>
          {toc && (
            <nav className="reader-toc" aria-label="阅读章节目录">
              {catalog?.chapters.map((item, n, all) => (
                <React.Fragment key={item.id}>
                  {(!n || item.volumeId !== all[n - 1].volumeId) && (
                    <h3>{item.volumeTitle}</h3>
                  )}
                  <button
                    disabled={busy}
                    aria-current={item.id === chapter?.id ? "page" : undefined}
                    onClick={() => navigate(item.id)}
                  >
                    {item.title}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
          <div
            ref={area}
            className="reader-scroll"
            onScroll={() => recordProgress()}
            tabIndex={0}
            aria-label="小说阅读正文"
          >
            {busy && <p role="status">正在读取正文…</p>}
            {error && (
              <p role="alert" className="reader-message">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="reader-message">
                {notice}
                {sourceChanged && (
                  <button onClick={() => recordProgress(true)}>
                    按当前正文重新记录
                  </button>
                )}
              </p>
            )}
            {!busy && !chapter && !error && (
              <p role="status">
                没有符合当前范围的章节。可以调整范围；零章节作品可先试写。
              </p>
            )}
            {chapter && (
              <>
                {preferences.width === "phone" && (
                  <p className="reader-simulation">
                    手机宽度为桌面模拟，尚非真实手机验收。
                  </p>
                )}
                {chapter.externalChange && (
                  <p className="reader-message">
                    读取的是当前磁盘正文，内容与原保存版本不同。仅阅读，不自动确认或修改。
                  </p>
                )}
                <article
                  className={`reader-sheet reader-width-${preferences.width}`}
                  aria-label={`阅读章节：${chapter.title}`}
                >
                  <h1>{chapter.title}</h1>
                  {paragraphContent}
                </article>
              </>
            )}
          </div>
        </div>
        <footer className="reader-footer">
          <button
            disabled={busy || index <= 0}
            onClick={() => navigate(catalog?.chapters[index - 1]?.id)}
          >
            上一章
          </button>
          <span role="status" aria-label="阅读进度">
            {chapter
              ? `第 ${index + 1}/${catalog?.chapters.length} 章 · 第 ${currentParagraph + 1}/${paragraphs.length} 段`
              : "尚未打开章节"}
          </span>
          <button
            disabled={
              busy ||
              index < 0 ||
              !catalog ||
              index >= catalog.chapters.length - 1
            }
            onClick={() => navigate(catalog?.chapters[index + 1]?.id)}
          >
            下一章
          </button>
          <button
            disabled={!chapter || busy}
            onClick={() => recordProgress(true)}
          >
            记录本章当前位置
          </button>
          {localError && (
            <div className="reader-local-error">
              <p role="alert">{localError}</p>
              {!locked.current && (
                <button onClick={() => persist()}>重试保存阅读进度</button>
              )}
              {locked.current && (
                <button onClick={() => persist(true)}>重置本机阅读记录</button>
              )}
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}
