import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import "./book-project.css";
import { registerEditorCloseGuard } from "./editor-close-guards";
type Document = {
  id: string;
  path: string;
  kind: string;
  revision: number;
  hash: string;
  diskHash: string;
  origin: string;
  text: string;
  externalChange?: boolean;
};
export function BookProjectPanel({
  book,
  onClose,
}: {
  book: Book;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<Document[]>([]),
    [initialized, setInitialized] = useState(false);
  const [current, setCurrent] = useState<Document | null>(null),
    [text, setText] = useState("");
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [path, setPath] = useState("worldbuilding/characters/new-character.md"),
    [historyRevision, setHistoryRevision] = useState(1);
  const dirty = current !== null && text !== current.text;
  const safety = useRef({ dirty, busy });
  safety.current = { dirty, busy };
  useEffect(
    () =>
      registerEditorCloseGuard(
        () => !safety.current.dirty && !safety.current.busy,
      ),
    [],
  );
  async function reload() {
    const result = await api("project.list", { bookId: book.id });
    setDocuments(result.documents);
    setInitialized(result.initialized);
  }
  useEffect(() => {
    let active = true;
    api("project.list", { bookId: book.id })
      .then((r) => {
        if (active) {
          setDocuments(r.documents);
          setInitialized(r.initialized);
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [book.id]);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function mayLeave() {
    if (dirty) {
      setError("有未保存的创作资产，请先保存，或明确放弃本次编辑。");
      return false;
    }
    return !busy;
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal wide-modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-label="创作工程"
      >
        <div className="modal-heading">
          <h2>创作工程 · {book.title}</h2>
          <button
            aria-label="关闭创作工程"
            disabled={busy}
            onClick={() => {
              if (mayLeave()) onClose();
            }}
          >
            关闭
          </button>
        </div>
        <p>
          按小说写作技能保存的 Markdown / YAML
          资产。正文在卷章目录编辑；模板不代表已生成或已审定。
        </p>
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {!initialized ? (
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("project.initialize", { bookId: book.id });
                await reload();
                setMessage("已建立待填写的工程模板。");
              })
            }
          >
            建立创作工程模板
          </button>
        ) : (
          <>
            <label>
              创作资产
              <select
                aria-label="创作资产"
                disabled={busy}
                value={current?.id || ""}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id || !mayLeave()) return;
                  void run(async () => {
                    const d = await api<Document>("project.read", {
                      bookId: book.id,
                      id,
                    });
                    setCurrent(d);
                    setText(d.text);
                    setHistoryRevision(d.revision);
                  });
                }}
              >
                <option value="">选择总纲、细纲、世界、人物或状态…</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.path} · v{d.revision}
                    {d.origin === "scaffold" ? " · 模板" : ""}
                  </option>
                ))}
              </select>
            </label>
            {current && (
              <>
                <p>
                  {current.path} · v{current.revision} ·{" "}
                  {dirty ? "编辑未保存" : "已读取磁盘"}
                  {current.externalChange
                    ? " · 检测到外部修改；保存将保留该外部版本的历史"
                    : ""}
                </p>
                <label>
                  资产正文
                  <textarea
                    aria-label="资产正文"
                    disabled={busy}
                    rows={18}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <div className="modal-actions">
                  <button
                    disabled={busy || !dirty}
                    onClick={() =>
                      run(async () => {
                        const saved = await api<Document>("project.save", {
                          bookId: book.id,
                          input: {
                            id: current.id,
                            revision: current.revision,
                            diskHash: current.diskHash,
                            text,
                          },
                        });
                        setCurrent(saved);
                        setText(saved.text);
                        setHistoryRevision(saved.revision);
                        await reload();
                        setMessage("创作资产已保存，历史版本已保留。");
                      })
                    }
                  >
                    保存创作资产
                  </button>
                  <button
                    disabled={busy || !dirty}
                    onClick={() => {
                      setText(current.text);
                      setError("");
                    }}
                  >
                    放弃本次资产编辑
                  </button>
                </div>
                <div className="project-history">
                  <label>
                    历史版本
                    <input
                      aria-label="资产历史版本"
                      type="number"
                      min={1}
                      max={current.revision}
                      value={historyRevision}
                      onChange={(e) =>
                        setHistoryRevision(Number(e.target.value))
                      }
                    />
                  </label>
                  <button
                    disabled={busy || dirty}
                    onClick={() =>
                      run(async () => {
                        const h = await api("project.history", {
                          bookId: book.id,
                          id: current.id,
                          revision: historyRevision,
                        });
                        setText(h.text);
                        setMessage(
                          `已载入 v${historyRevision} 到编辑区；保存后才成为新版本。`,
                        );
                      })
                    }
                  >
                    载入历史到编辑区
                  </button>
                </div>
              </>
            )}
            <details>
              <summary>新建人物、分卷或其他资产</summary>
              <label>
                资产相对路径
                <input
                  aria-label="新资产相对路径"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
              <p>
                支持
                worldbuilding/、outline/、production/state/、production/reviews/、production/publish/
                和 assets/images/README.md。
              </p>
              <button
                disabled={busy || dirty}
                onClick={() =>
                  run(async () => {
                    const d = await api<Document>("project.create", {
                      bookId: book.id,
                      input: { path, text: "" },
                    });
                    await reload();
                    setCurrent(d);
                    setText(d.text);
                    setHistoryRevision(1);
                  })
                }
              >
                新建空白资产
              </button>
            </details>
          </>
        )}
      </section>
    </div>
  );
}

type Preview = {
  token: string;
  fingerprint: string;
  title: string;
  kind: string;
  chapterCount: number;
  documents: { path: string; bytes: number }[];
  missing: string[];
  ignored: string[];
};
export function ProjectImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (book: Book) => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const safety = useRef(false);
  safety.current = busy;
  useEffect(() => registerEditorCloseGuard(() => !safety.current), []);
  async function choose(kind: string) {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      setPreview(await api("project.import-preview", { kind }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal wide-modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入小说工程"
      >
        <div className="modal-heading">
          <h2>导入小说工程</h2>
          <button disabled={busy} aria-label="关闭工程导入" onClick={onClose}>
            关闭
          </button>
        </div>
        <p>
          选择 books/&lt;slug&gt; 单本创作目录，或小说站 src/content/novels
          下的单本索引 Markdown。确认后新建独立作品，源工程保持原样。
        </p>
        <div className="modal-actions">
          <button disabled={busy} onClick={() => choose("project")}>
            选择写作工程目录
          </button>
          <button disabled={busy} onClick={() => choose("site")}>
            选择小说站索引文件
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {preview && (
          <>
            <h3>{preview.title}</h3>
            <p>
              {preview.chapterCount} 章正文 · {preview.documents.length}{" "}
              份创作资产
            </p>
            <ul>
              {preview.documents.map((d) => (
                <li key={d.path}>
                  {d.path}（{d.bytes} 字节）
                </li>
              ))}
            </ul>
            <details>
              <summary>
                源工程缺少的模板位置（{preview.missing.length}）
              </summary>
              <p>这些资产没有来源内容，导入不会伪造；可在创作工程中新建。</p>
              <ul>
                {preview.missing.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
            <details>
              <summary>未导入文件（{preview.ignored.length}）</summary>
              <p>二进制图像需另从图像资产导入；程序配置、缓存等不作为正文。</p>
              <ul>
                {preview.ignored.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const book = await api<Book>("project.import-confirm", {
                    token: preview.token,
                    fingerprint: preview.fingerprint,
                  });
                  setBusy(false);
                  safety.current = false;
                  await onImported(book);
                } catch (e) {
                  setError((e as Error).message);
                  setPreview(null);
                  setBusy(false);
                }
              }}
            >
              确认新建小说工程
            </button>
          </>
        )}
      </section>
    </div>
  );
}
