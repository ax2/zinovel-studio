import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Feather,
  PenLine,
  Plus,
  Search,
  FileText,
  CheckCircle2,
  History,
  Download,
  Moon,
  Sun,
  ChevronLeft,
  X,
  Maximize2,
  Save,
  AlertTriangle,
  Library,
  Sparkles,
  Activity,
} from "lucide-react";
import { api, type Book, type Chapter } from "./api";
import { BackupPanel } from "./backup-panel";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { orderedChapters } from "../../packages/novel-domain/structure.mjs";
import {
  ImportDialog,
  StructureDialog,
  SearchDialog,
  type SearchHit,
} from "./library-tools";
import "./style.css";
import { ChapterTree } from "./chapter-tree";
import { BookShelf } from "./book-shelf";
import { ReferencePanel } from "./reference-panel";
import { MaterialsPanel } from "./materials-panel";
import { ScenePlanner } from "./scene-planner";
import { PilotStudio } from "./pilot-studio";
import { NovelReader } from "./novel-reader";
import { PublicationPanel } from "./publication-panel";
import { AssetsPanel } from "./assets-panel";
import { ImageStudio } from "./image-studio";
import { MapsPanel } from "./maps-panel";
import { ContinuityWorkbench } from "./continuity-workbench";
import { KnowledgeMatrix } from "./knowledge-matrix";
import { canCloseEditors } from "./editor-close-guards";
import { TaskHistory } from "./task-history";
import { ReplaceDialog } from "./replace-dialog";
import { AnnotationsDialog } from "./annotations";
import { ConflictDialog } from "./conflict-dialog";
import { useModalAccessibility } from "./modal-accessibility";
import {
  ManuscriptEditor,
  type ManuscriptHandle,
  type RevealTarget,
} from "./manuscript-editor";
import {
  WritingAssistant,
  ModelSettingsDialog,
  type WritingSnapshot,
} from "./assistant";

function App() {
  useModalAccessibility();
  const editorRef = useRef<ManuscriptHandle>(null);
  const [referenceOpen, setReferenceOpen] = useState(false),
    [typewriter, setTypewriter] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [pilotsOpen, setPilotsOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [imageStudioOpen, setImageStudioOpen] = useState(false);
  const [mapsOpen, setMapsOpen] = useState(false);
  const [continuityOpen, setContinuityOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [requestedMaterial, setRequestedMaterial] = useState<{
    bookId: string;
    id: string;
    request: number;
  } | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [replaceSnapshot, setReplaceSnapshot] =
    useState<WritingSnapshot | null>(null);
  const [annotationSnapshot, setAnnotationSnapshot] = useState<
    (WritingSnapshot & { hash: string }) | null
  >(null);
  const [books, setBooks] = useState<Book[]>([]),
    [book, setBook] = useState<Book | null>(null),
    [chapter, setChapter] = useState<Chapter | null>(null);
  const [body, setBody] = useState(""),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [status, setStatus] = useState("已保存"),
    [query, setQuery] = useState(""),
    [reading, setReading] = useState(false),
    [focus, setFocus] = useState(false);
  const [dark, setDark] = useState(
    localStorage.getItem("zinovel.theme") === "dark",
  );
  const [dialog, setDialog] = useState<"book" | "chapter" | null>(null),
    [name, setName] = useState("");
  const [history, setHistory] = useState<
      { id: string; at: string; body: string; label?: string }[] | null
    >(null),
    [conflict, setConflict] = useState<Chapter | null>(null);
  const [conflictBase, setConflictBase] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [structureOpen, setStructureOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [tasksOpen, setTasksOpen] = useState(false),
    [panelOpen, setPanelOpen] = useState(false),
    [selection, setSelection] = useState({ start: 0, end: 0 });
  const latest = useRef({ book, chapter, body, title }),
    queue = useRef(Promise.resolve(true)),
    composing = useRef(false),
    [composition, setComposition] = useState(false);
  latest.current = { book, chapter, body, title };
  useEffect(() => {
    if (chapter && !reading) editorRef.current?.focus();
  }, [focus, typewriter]);
  const dirty = !!chapter && (body !== chapter.body || title !== chapter.title);
  const draftKey = (bookId: string, chapterId: string) =>
    `zinovel.draft.${bookId}.${chapterId}`;
  const refresh = async () => {
    const result = await api<{ books: Book[]; errors: { message: string }[] }>(
      "library.list",
    );
    setBooks(result.books);
    if (result.errors.length)
      setError(result.errors.map((e) => e.message).join("；"));
    return result.books;
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("zinovel.theme", dark ? "dark" : "light");
  }, [dark]);

  function save(): Promise<boolean> {
    const job = async () => {
      const current = latest.current;
      if (!current.chapter || !current.book || composing.current)
        return !composing.current;
      if (
        current.body === current.chapter.body &&
        current.title === current.chapter.title
      )
        return true;
      setStatus("正在保存");
      try {
        const result = await api("chapter.save", {
          bookId: current.book.id,
          chapterId: current.chapter.id,
          title: current.title,
          body: current.body,
          expectedRevision: current.chapter.revision,
          expectedHash: current.chapter.diskHash,
        });
        if (result.status === "conflict") {
          setConflictBase(current.chapter.body);
          setConflict(result.current);
          setStatus("存在冲突");
          return false;
        }
        if (
          latest.current.book?.id === current.book.id &&
          latest.current.chapter?.id === current.chapter.id
        ) {
          latest.current = {
            ...latest.current,
            chapter: result.chapter,
            book: result.book,
          };
          setChapter(result.chapter);
          setBook(result.book);
          setStatus(
            latest.current.body === current.body &&
              latest.current.title === current.title
              ? "已保存"
              : "编辑中",
          );
          if (
            latest.current.body === current.body &&
            latest.current.title === current.title
          )
            localStorage.removeItem(
              draftKey(current.book.id, current.chapter.id),
            );
        }
        setBooks((all) =>
          all.map((b) => (b.id === result.book.id ? result.book : b)),
        );
        return true;
      } catch (e) {
        setError((e as Error).message);
        setStatus("保存失败");
        return false;
      }
    };
    queue.current = queue.current.then(job, job);
    return queue.current;
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () =>
      window.novel.onClosing(() => {
        void (async () => {
          try {
            if (!canCloseEditors()) {
              await api("app.close-cancelled");
              return;
            }
            if (await saveRef.current()) await api("app.close-ready");
            else {
              await api("app.close-cancelled");
              setError("关闭前尚有未保存内容，请先处理保存问题。");
            }
          } catch (e) {
            await api("app.close-cancelled").catch(() => {});
            setError((e as Error).message);
          }
        })();
      }),
    [],
  );
  useEffect(() => {
    if (!dirty || !book || !chapter || composition || conflict) return;
    setStatus("编辑中");
    try {
      localStorage.setItem(
        draftKey(book.id, chapter.id),
        JSON.stringify({
          body,
          title,
          baseHash: chapter.diskHash,
          baseBody: chapter.body,
        }),
      );
    } catch {
      setError("本地恢复缓冲无法写入，请尽快保存正文。");
    }
    const timer = setTimeout(() => {
      saveRef.current();
    }, 650);
    return () => clearTimeout(timer);
  }, [body, title, chapter?.id, composition, conflict]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        saveRef.current();
      }
      if (event.key === "Escape") {
        setDialog(null);
        setHistory(null);
        setFocus(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  async function openChapter(selectedBook: Book, selectedId: string) {
    if (!(await save())) return;
    try {
      const next = await api<Chapter>("chapter.read", {
        bookId: selectedBook.id,
        chapterId: selectedId,
      });
      setSelection({ start: 0, end: 0 });
      setBook(selectedBook);
      setChapter(next);
      setTitle(next.title);
      setBody(next.body);
      setConflict(null);
      setHistory(null);
      setReading(false);
      setStatus("已保存");
      const raw = localStorage.getItem(draftKey(selectedBook.id, next.id));
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.baseHash === next.diskHash) {
          setBody(draft.body);
          setTitle(draft.title);
          setNotice("已恢复上次未保存的编辑内容");
        } else {
          setBody(draft.body);
          setTitle(draft.title);
          setConflict(next);
          setConflictBase(
            typeof draft.baseBody === "string" ? draft.baseBody : null,
          );
          setStatus("存在冲突");
        }
      }
      if (next.externalChange)
        setNotice("已读取外部编辑后的正文，下一次保存将建立新版本。");
      localStorage.setItem(`zinovel.lastChapter.${selectedBook.id}`, next.id);
      return next;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function openTaskChapter(id: string, bookId?: string) {
    const target = (await refresh()).find((item) => item.id === bookId);
    if (!target) throw new Error("作品已移除或暂时不可读，任务原文仍可查看");
    if (!(await openChapter(target, id)))
      throw new Error("章节未能打开，请保留任务并检查正文提示");
  }
  async function openBook(selected: Book) {
    if (!(await save())) return;
    setQuery("");
    setBook(selected);
    if (orderedChapters(selected).length)
      await openChapter(
        selected,
        orderedChapters(selected).find(
          (ch) =>
            ch.id ===
            localStorage.getItem(`zinovel.lastChapter.${selected.id}`),
        )?.id || orderedChapters(selected)[0].id,
      );
    else {
      setChapter(null);
      setBody("");
      setTitle("");
    }
  }
  async function create() {
    try {
      if (dialog === "book") {
        const created = await api<Book>("book.create", { title: name });
        await refresh();
        await openBook(created);
      } else if (book) {
        if (!(await save())) return;
        const result = await api("chapter.create", {
          bookId: book.id,
          title: name,
        });
        setBooks((all) =>
          all.map((b) => (b.id === result.book.id ? result.book : b)),
        );
        await openChapter(result.book, result.chapter.id);
      }
      setDialog(null);
      setName("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const begin = (type: "book" | "chapter") => {
    setName(
      type === "chapter" ? `第${(book?.chapters.length ?? 0) + 1}章` : "",
    );
    setDialog(type);
  };
  const treeActions = useRef({ openChapter, begin, save });
  treeActions.current = { openChapter, begin, save };
  const openTreeChapter = useCallback((id: string) => {
    const selected = latest.current.book;
    if (selected) void treeActions.current.openChapter(selected, id);
  }, []);
  const createTreeChapter = useCallback(
    () => treeActions.current.begin("chapter"),
    [],
  );
  const manageTreeBook = useCallback(async () => {
    if (await treeActions.current.save()) setStructureOpen(true);
  }, []);
  const count = Array.from(body.replace(/\s/g, "")).length;
  const statusLabel =
    chapter?.status === "final"
      ? "正式"
      : chapter?.status === "reviewed"
        ? "已审读"
        : "草稿";
  function updateBook(updated: Book) {
    setBook(updated);
    setBooks((all) =>
      all.map((item) => (item.id === updated.id ? updated : item)),
    );
    if (chapter) {
      const metadata = updated.chapters.find((item) => item.id === chapter.id);
      if (metadata?.deletedAt) {
        setChapter(null);
        setBody("");
        setTitle("");
      } else if (metadata) setChapter({ ...chapter, ...metadata });
    }
  }
  async function imported(created: Book) {
    setImportOpen(false);
    await refresh();
    await openBook(created);
  }
  async function openHit(hit: SearchHit) {
    if (!book) return;
    const next = await openChapter(book, hit.chapterId);
    if (!next) return;
    setSearchOpen(false);
    if (next.diskHash !== hit.hash) {
      setNotice("正文在检索后发生变化，请重新搜索以准确定位。");
      return;
    }
    setReading(false);
    setReveal({
      documentKey: `${book.id}.${hit.chapterId}`,
      start: hit.start,
      end: hit.end,
      request: Date.now(),
    });
  }

  async function applyCandidate(
    base: WritingSnapshot,
    candidate: string,
    taskId?: string,
  ) {
    if (
      latest.current.book?.id !== base.bookId ||
      latest.current.chapter?.id !== base.chapterId ||
      latest.current.body !== base.body
    ) {
      setError("生成期间正文已改变，请保留候选并重新选择范围，未替换正文。");
      return false;
    }
    if (!(await save())) return false;
    if (
      latest.current.book?.id !== base.bookId ||
      latest.current.chapter?.id !== base.chapterId ||
      latest.current.body !== base.body
    ) {
      setError("保存期间正文发生改变，未替换正文。");
      return false;
    }
    const accepted =
      base.body.slice(0, base.start) + candidate + base.body.slice(base.end);
    if (taskId) {
      const result = await api("ai.accept", { id: taskId, candidate });
      if (result.status === "conflict") {
        setConflictBase(base.body);
        setConflict(result.current);
        setStatus("存在冲突");
        return false;
      }
      if (
        latest.current.book?.id !== base.bookId ||
        latest.current.chapter?.id !== base.chapterId ||
        latest.current.body !== base.body
      ) {
        setError(
          "候选已保存到目标章节，但当前编辑已变化，请重新读取章节核对。",
        );
        return false;
      }
      latest.current = {
        ...latest.current,
        body: result.chapter.body,
        chapter: result.chapter,
        book: result.book,
      };
      setBody(result.chapter.body);
      setChapter(result.chapter);
      setBook(result.book);
      setBooks((all) =>
        all.map((book) => (book.id === result.book.id ? result.book : book)),
      );
      localStorage.removeItem(draftKey(base.bookId, base.chapterId));
      setStatus("已保存");
      setNotice(
        result.receiptPending
          ? "正文已保存，任务接受状态待核对；重启后自动核验，也可打开任务记录核对。"
          : "已接受候选，原稿保留在历史版本中",
      );
      return true;
    }
    latest.current = { ...latest.current, body: accepted };
    setBody(accepted);
    if (!(await save())) return false;
    setNotice("已接受候选，原稿保留在历史版本中");
    return true;
  }
  return (
    <div
      className={`app ${focus ? "focus" : ""} ${panelOpen ? "show-inspector" : ""} ${referenceOpen || materialsOpen ? "reference-mode" : ""}`}
    >
      <nav className="rail" aria-label="主导航">
        <div className="brand-mark">
          <Feather size={28} />
        </div>
        <button
          className={!book ? "active" : ""}
          onClick={async () => {
            if (await save()) {
              setBook(null);
              setChapter(null);
              await refresh();
            }
          }}
          title="书库"
        >
          <Library />
          <span>书库</span>
        </button>
        <button
          className={book ? "active" : ""}
          disabled={!book}
          title="写作"
          onClick={() => {
            setReading(false);
            editorRef.current?.focus();
          }}
        >
          <PenLine />
          <span>写作</span>
        </button>
        <div className="rail-bottom">
          <button title="故障诊断" onClick={() => setDiagnosticsOpen(true)}>
            <Activity size={20} />
          </button>
          <button title="写作任务" onClick={() => setTasksOpen(true)}>
            <History size={20} />
          </button>
          <button title="模型设置" onClick={() => setSettingsOpen(true)}>
            <Sparkles size={20} />
          </button>
          <button
            onClick={() => setDark(!dark)}
            title={dark ? "浅色主题" : "深色主题"}
          >
            {dark ? <Sun /> : <Moon />}
          </button>
        </div>
      </nav>
      <header className="top">
        <strong>ZiNovel Studio</strong>
        <span className="divider" />
        <span>{book?.title || "我的书库"}</span>
        <span className="top-spacer" />
        {book && (
          <div className="search">
            <Search size={16} />
            <input
              aria-label="搜索章节"
              placeholder="搜索章节标题…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      </header>
      {tasksOpen && (
        <TaskHistory
          onClose={() => setTasksOpen(false)}
          openChapter={openTaskChapter}
        />
      )}
      {planningOpen && book && (
        <ScenePlanner
          key={book.id}
          bookId={book.id}
          onClose={() => setPlanningOpen(false)}
          onChapter={(id) => openTaskChapter(id, book.id)}
          onEdit={(id) => {
            setPlanningOpen(false);
            setMaterialsOpen(true);
            setReferenceOpen(false);
            setPanelOpen(true);
            setRequestedMaterial({ bookId: book.id, id, request: Date.now() });
          }}
        />
      )}
      {readerOpen && book && (
        <NovelReader
          key={book.id}
          bookId={book.id}
          initialChapterId={chapter?.id}
          onClose={() => setReaderOpen(false)}
        />
      )}
      {publicationOpen && book && (
        <PublicationPanel
          key={book.id}
          book={book}
          onClose={() => setPublicationOpen(false)}
        />
      )}
      {backupOpen && book && (
        <BackupPanel
          key={book.id}
          book={book}
          onClose={() => setBackupOpen(false)}
          onRestored={async (restored) => {
            setBackupOpen(false);
            await refresh();
            await openBook(restored);
          }}
        />
      )}
      {imageStudioOpen && book && (
        <ImageStudio
          key={book.id}
          book={book}
          onClose={() => setImageStudioOpen(false)}
          onModels={() => {
            setImageStudioOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
      {assetsOpen && book && (
        <AssetsPanel
          key={book.id}
          book={book}
          onClose={() => setAssetsOpen(false)}
        />
      )}
      {mapsOpen && book && (
        <MapsPanel
          key={book.id}
          book={book}
          onClose={() => setMapsOpen(false)}
          onAssets={() => {
            setMapsOpen(false);
            setAssetsOpen(true);
          }}
          onEditLocation={(id) => {
            setMapsOpen(false);
            setMaterialsOpen(true);
            setReferenceOpen(false);
            setPanelOpen(true);
            setRequestedMaterial({ bookId: book.id, id, request: Date.now() });
          }}
        />
      )}
      {knowledgeOpen && book && (
        <KnowledgeMatrix
          key={book.id}
          book={book}
          source={
            chapter
              ? {
                  chapterId: chapter.id,
                  body,
                  hash: chapter.diskHash,
                  dirty,
                  start: selection.start,
                  end: selection.end,
                }
              : null
          }
          onClose={() => setKnowledgeOpen(false)}
          onEdit={(id) => {
            setKnowledgeOpen(false);
            setMaterialsOpen(true);
            setReferenceOpen(false);
            setPanelOpen(true);
            setRequestedMaterial({ bookId: book.id, id, request: Date.now() });
          }}
          onChapter={async (id, anchor) => {
            await openTaskChapter(id, book.id);
            setNotice("");
            setReveal({
              documentKey: `${book.id}.${id}`,
              start: anchor.start,
              end: anchor.end,
              request: Date.now(),
              anchor,
            });
            setKnowledgeOpen(false);
            setPanelOpen(false);
          }}
        />
      )}
      {continuityOpen && book && (
        <ContinuityWorkbench
          key={book.id}
          book={book}
          onClose={() => setContinuityOpen(false)}
          onEdit={(id) => {
            setContinuityOpen(false);
            setMaterialsOpen(true);
            setReferenceOpen(false);
            setPanelOpen(true);
            setRequestedMaterial({ bookId: book.id, id, request: Date.now() });
          }}
          onChapter={async (id, anchor) => {
            await openTaskChapter(id, book.id);
            setNotice("");
            setReveal({
              documentKey: `${book.id}.${id}`,
              start: anchor.start,
              end: anchor.end,
              request: Date.now(),
              anchor,
            });
            setContinuityOpen(false);
            setPanelOpen(false);
          }}
        />
      )}
      {pilotsOpen && book && (
        <PilotStudio
          key={book.id}
          bookId={book.id}
          onClose={() => setPilotsOpen(false)}
          onChapter={(id) => openTaskChapter(id, book.id)}
        />
      )}
      {error && (
        <div className="alert error" role="alert">
          <AlertTriangle size={18} />
          {error}
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <X size={18} />
          </button>
        </div>
      )}
      {notice && (
        <div className="alert notice" role="status">
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={18} />
          </button>
        </div>
      )}
      {!book ? (
        <BookShelf
          books={books}
          onOpen={openBook}
          onCreate={() => begin("book")}
          onImport={() => setImportOpen(true)}
          onRestore={async () => {
            try {
              const result = await api("library.restore");
              if (result.book) await imported(result.book);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          onArchive={async (selected, archived) => {
            await api("book.structure", {
              bookId: selected.id,
              expectedRevision: selected.revision,
              mutation: { type: "book-archive", archived },
            });
            await refresh();
          }}
        />
      ) : (
        <>
          <ChapterTree
            key={book.id}
            book={book}
            chapterId={chapter?.id}
            query={query}
            onOpen={openTreeChapter}
            onCreate={createTreeChapter}
            onManage={manageTreeBook}
          />
          <main className="workspace">
            <div className="toolbar">
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setBackupOpen(true);
                }}
              >
                增量备份
              </button>
              <button onClick={() => setPlanningOpen(true)}>场景编排</button>
              <button onClick={() => setPilotsOpen(true)}>试写实验室</button>
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setReaderOpen(true);
                }}
              >
                阅读预览
              </button>
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setPublicationOpen(true);
                }}
              >
                导出与发布
              </button>
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setAssetsOpen(true);
                }}
              >
                图像资源
              </button>
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setImageStudioOpen(true);
                }}
              >
                AI 图像
              </button>
              <button
                disabled={composition}
                onClick={async () => {
                  if (await save()) setMapsOpen(true);
                }}
              >
                世界地图
              </button>
              <button onClick={() => setContinuityOpen(true)}>全书证据</button>
              <button onClick={() => setKnowledgeOpen(true)}>认知矩阵</button>
              <button
                onClick={async () => {
                  if (await save()) {
                    setBook(null);
                    setChapter(null);
                    await refresh();
                  }
                }}
                title="返回书库"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="reference-toggle"
                title="打开创作参考"
                onClick={() => setPanelOpen(!panelOpen)}
              >
                <Sparkles size={16} />
              </button>
              <button
                title="书内全文搜索"
                onClick={async () => {
                  if (await save()) setSearchOpen(true);
                }}
              >
                <Search size={16} />
              </button>
              <button
                title="撤销（Ctrl+Z）"
                disabled={!chapter || reading}
                onClick={() => editorRef.current?.undo()}
              >
                撤销
              </button>
              <button
                title="重做（Ctrl+Y）"
                disabled={!chapter || reading}
                onClick={() => editorRef.current?.redo()}
              >
                重做
              </button>
              <button
                title="查找替换预览"
                disabled={!chapter || reading}
                onClick={() => {
                  if (book && chapter)
                    setReplaceSnapshot({
                      bookId: book.id,
                      chapterId: chapter.id,
                      body,
                      start: 0,
                      end: body.length,
                    });
                }}
              >
                替换
              </button>
              <span className="toolbar-label">
                {reading ? "阅读模式" : "正文"}
              </span>
              <button
                title="打字机模式"
                aria-pressed={typewriter}
                className={typewriter ? "pressed" : ""}
                disabled={!chapter || reading}
                onClick={() => setTypewriter(!typewriter)}
              >
                居中
              </button>
              <span className="top-spacer" />
              <button
                className={reading ? "pressed" : ""}
                onClick={() => setReading(!reading)}
                disabled={!chapter}
              >
                <BookOpen size={16} />
                阅读
              </button>
              <button
                className={focus ? "pressed" : ""}
                onClick={() => {
                  setFocus(!focus);
                  setPanelOpen(false);
                }}
              >
                <Maximize2 size={16} />
                {focus ? "退出专注" : "专注"}
              </button>
              <span className={`save-state ${dirty ? "pending" : ""}`}>
                <CheckCircle2 size={16} />
                {dirty && status === "已保存" ? "编辑中" : status}
              </span>
              <button
                title="保存（Ctrl+S）"
                disabled={!chapter}
                onClick={() => save()}
              >
                <Save size={17} />
              </button>
            </div>
            {chapter ? (
              <div className="paper">
                <input
                  className="chapter-title"
                  aria-label="章节标题"
                  value={title}
                  readOnly={reading}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {reading && (
                  <article className="reading">
                    {body.split("\n").map((p, i) => (
                      <p key={i}>{p || "\u00a0"}</p>
                    ))}
                  </article>
                )}
                <div className="editor-slot" hidden={reading}>
                  <ManuscriptEditor
                    ref={editorRef}
                    documentKey={`${book.id}.${chapter.id}`}
                    value={body}
                    typewriter={typewriter}
                    reveal={reveal}
                    onRevealIssue={setNotice}
                    onChange={setBody}
                    onSelection={setSelection}
                    onComposition={(active) => {
                      composing.current = active;
                      setComposition(active);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="empty-chapter">
                <FileText size={44} />
                <h2>故事，从一个想法开始</h2>
                <p>可以先整理创意、人物和大纲；独立试写不占正式章节。</p>
                <div className="empty-story-actions">
                  <button
                    onClick={() => {
                      setMaterialsOpen(true);
                      setReferenceOpen(false);
                      setPanelOpen(true);
                    }}
                  >
                    整理创作资料
                  </button>
                  <button onClick={() => setPilotsOpen(true)}>
                    先做一场试写
                  </button>
                </div>
                <button className="primary" onClick={() => begin("chapter")}>
                  <Plus size={18} />
                  新建章节
                </button>
              </div>
            )}
          </main>
          <aside className="inspector">
            <div className="inspector-title">
              创作参考
              <button
                className="reference-toggle"
                aria-label="关闭创作参考"
                onClick={() => setPanelOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div
              className="reference-tabs"
              role="group"
              aria-label="创作参考内容"
            >
              <button
                aria-pressed={!referenceOpen && !materialsOpen}
                onClick={() => {
                  setReferenceOpen(false);
                  setMaterialsOpen(false);
                }}
              >
                写作工具
              </button>
              <button
                aria-pressed={referenceOpen && !materialsOpen}
                onClick={() => {
                  setReferenceOpen(true);
                  setMaterialsOpen(false);
                }}
              >
                旧稿参考
              </button>
              <button
                aria-pressed={materialsOpen}
                onClick={() => {
                  setMaterialsOpen(true);
                  setReferenceOpen(false);
                }}
              >
                资料卡
              </button>
            </div>
            <div hidden={!materialsOpen}>
              <MaterialsPanel
                key={book.id}
                book={book}
                requested={
                  requestedMaterial?.bookId === book.id
                    ? requestedMaterial
                    : null
                }
                openChapter={async (id, anchor) => {
                  await openTaskChapter(id, book.id);
                  if (anchor) {
                    setNotice("");
                    setReveal({
                      documentKey: `${book.id}.${id}`,
                      start: anchor.start,
                      end: anchor.end,
                      request: Date.now(),
                      anchor,
                    });
                    setPanelOpen(false);
                  }
                }}
                source={
                  chapter
                    ? {
                        chapterId: chapter.id,
                        body,
                        hash: chapter.diskHash,
                        dirty,
                        start: selection.start,
                        end: selection.end,
                      }
                    : null
                }
              />
            </div>
            {referenceOpen && !materialsOpen && (
              <ReferencePanel
                key={book.id}
                book={book}
                chapterId={chapter?.id}
              />
            )}
            <div hidden={referenceOpen || materialsOpen}>
              <WritingAssistant
                key={book.id}
                bookId={book.id}
                snapshot={
                  chapter
                    ? {
                        bookId: book.id,
                        chapterId: chapter.id,
                        body,
                        baseHash: chapter.diskHash,
                        start: Math.min(selection.start, body.length),
                        end: Math.min(selection.end, body.length),
                      }
                    : null
                }
                apply={applyCandidate}
                openChapter={openTaskChapter}
                openSettings={() => setSettingsOpen(true)}
              />
              <section>
                <h3>当前章节</h3>
                <button
                  disabled={!chapter}
                  onClick={async () => {
                    if (await save()) {
                      const current = latest.current;
                      if (current.book && current.chapter)
                        setAnnotationSnapshot({
                          bookId: current.book.id,
                          chapterId: current.chapter.id,
                          body: current.body,
                          hash:
                            current.chapter.diskHash || current.chapter.hash,
                          start: Math.min(selection.start, current.body.length),
                          end: Math.min(selection.end, current.body.length),
                        });
                    }
                  }}
                >
                  批注与书签
                </button>
                <p className="muted">{chapter?.title || "尚未创建章节"}</p>
                <div className="metadata">
                  <span>正文</span>
                  <strong>{count.toLocaleString()} 字</strong>
                  <span>版本</span>
                  <strong>{chapter ? `第 ${chapter.revision} 版` : "—"}</strong>
                  <span>状态</span>
                  <strong>{statusLabel}</strong>
                </div>
              </section>
              <section>
                <h3>版本与导出</h3>
                <button
                  onClick={async () => {
                    if (await save()) {
                      try {
                        const result = await api("book.backup", {
                          bookId: book.id,
                        });
                        if (!result.cancelled)
                          setNotice(`备份完成：${result.files} 个文件`);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }
                  }}
                >
                  备份整部作品
                </button>
                <button
                  onClick={async () => {
                    if (await save()) {
                      try {
                        const result = await api("book.export", {
                          bookId: book.id,
                        });
                        if (!result.cancelled) setNotice("全书已导出");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }
                  }}
                >
                  导出全书 Markdown
                </button>
                <button
                  disabled={!chapter}
                  onClick={async () => {
                    if (await save())
                      setHistory(
                        await api("chapter.history", {
                          bookId: book.id,
                          chapterId: chapter!.id,
                        }),
                      );
                  }}
                >
                  <History size={17} />
                  查看历史版本
                </button>
                <button
                  disabled={!chapter}
                  onClick={async () => {
                    if (await save()) {
                      const result = await api("chapter.export", {
                        bookId: book.id,
                        chapterId: chapter!.id,
                      });
                      if (!result.cancelled) setNotice("章节已导出");
                    }
                  }}
                >
                  <Download size={17} />
                  导出 Markdown
                </button>
              </section>
            </div>
          </aside>
        </>
      )}
      <footer>
        <span>{book ? `正文 ${count.toLocaleString()} 字` : "本地书库"}</span>
        <span className="divider" />
        <span>{book ? statusLabel : "作品属于你"}</span>
        <span className="top-spacer" />
        <span role="status" aria-label="正文保存状态">
          {chapter?.updatedAt
            ? `${status} · 最近保存：${new Date(chapter.updatedAt).toLocaleTimeString("zh-CN")}`
            : "离线写作可用"}
        </span>
      </footer>
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={imported}
        />
      )}
      {annotationSnapshot && (
        <AnnotationsDialog
          snapshot={annotationSnapshot}
          onClose={() => setAnnotationSnapshot(null)}
          onLocate={(range) => {
            setReading(false);
            setReveal({
              documentKey: `${annotationSnapshot.bookId}.${annotationSnapshot.chapterId}`,
              ...range,
              request: Date.now(),
            });
            setAnnotationSnapshot(null);
          }}
        />
      )}
      {structureOpen && book && (
        <StructureDialog
          book={book}
          onChange={updateBook}
          onClose={() => setStructureOpen(false)}
        />
      )}
      {searchOpen && book && (
        <SearchDialog
          book={book}
          onClose={() => setSearchOpen(false)}
          onOpen={openHit}
        />
      )}
      {replaceSnapshot && (
        <ReplaceDialog
          snapshot={replaceSnapshot}
          onApply={applyCandidate}
          onClose={() => setReplaceSnapshot(null)}
        />
      )}
      {settingsOpen && (
        <ModelSettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {diagnosticsOpen && (
        <DiagnosticsPanel onClose={() => setDiagnosticsOpen(false)} />
      )}
      {dialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialog === "book" ? "新建作品" : "新建章节"}
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <h2>{dialog === "book" ? "新建作品" : "新建章节"}</h2>
            <label>
              标题
              <input
                autoFocus
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  dialog === "book" ? "给你的故事起一个名字" : "章节标题"
                }
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setDialog(null)}>
                取消
              </button>
              <button className="primary" disabled={!name.trim()}>
                创建
              </button>
            </div>
          </form>
        </div>
      )}
      {history && (
        <div className="modal-backdrop">
          <div
            className="modal history-modal"
            role="dialog"
            aria-modal="true"
            aria-label="历史版本"
          >
            <div className="modal-heading">
              <h2>历史版本</h2>
              <button title="关闭历史版本" onClick={() => setHistory(null)}>
                <X />
              </button>
            </div>
            <p className="muted">
              恢复会形成新的保存版本，当前正文仍保留在历史中。
            </p>
            {history.map((v) => (
              <div className="history-row" key={v.id}>
                <time>{new Date(v.at).toLocaleString("zh-CN")}</time>
                {v.label && <span className="muted"> · {v.label}</span>}
                <p>{v.body.slice(0, 120) || "空白初稿"}</p>
                <button
                  onClick={() => {
                    setBody(v.body);
                    setHistory(null);
                    setNotice("已载入历史正文，将保存为新版本");
                  }}
                >
                  恢复此版本
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {conflict && (
        <ConflictDialog
          key={`${book!.id}.${conflict.id}.${conflict.diskHash}`}
          base={conflictBase}
          local={body}
          remote={conflict.body}
          localTitle={title}
          remoteTitle={conflict.title}
          onReload={async () => {
            setConflict(
              await api<Chapter>("chapter.read", {
                bookId: book!.id,
                chapterId: conflict.id,
              }),
            );
          }}
          onResolve={async (merged, mergedTitle) => {
            if (new Blob([merged]).size > 8 * 1024 * 1024)
              throw new Error("合并稿超过单章 8 MiB，请缩小内容后重试。");
            const archived = await api("chapter.archive-conflict", {
              bookId: book!.id,
              chapterId: conflict.id,
              expectedRemoteHash: conflict.diskHash,
              expectedRemoteRevision: conflict.revision,
              localBody: body,
              localTitle: title,
              baseBody: conflictBase,
            });
            setChapter(archived.current);
            setBody(merged);
            setTitle(mergedTitle);
            setConflict(null);
            if (
              merged === archived.current.body &&
              mergedTitle === archived.current.title
            ) {
              localStorage.removeItem(draftKey(book!.id, conflict.id));
              setStatus("已保存");
            }
            setNotice("冲突两侧已保存在历史版本中；合并内容可继续编辑和撤销。");
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
