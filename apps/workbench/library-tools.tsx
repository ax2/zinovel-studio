import React, { useEffect, useState } from "react";
import {
  X,
  ArrowUp,
  Trash2,
  RotateCcw,
  Search,
  FolderOpen,
} from "lucide-react";
import { api, type Book } from "./api";
import { orderedChapters } from "../../packages/novel-domain/structure.mjs";
import {
  ImportPreviewEditor,
  type ImportPreview,
} from "./import-preview-editor";
export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (book: Book) => void;
}) {
  const [id, setId] = useState(""),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [revision, setRevision] = useState(""),
    [title, setTitle] = useState("导入的小说");
  const [encoding, setEncoding] = useState("utf-8"),
    [split, setSplit] = useState(true),
    [selected, setSelected] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function choose(directory: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api("import.choose", { directory });
      if (!result.cancelled) {
        setEncoding("utf-8");
        setSplit(true);
        setId(result.id);
        setPreview(result.preview || null);
        setRevision(result.revision || "");
        setError(result.error || "");
        setSelected(0);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await api("import.preview", { id, encoding, split });
      setPreview(result.preview);
      setRevision(result.revision);
      setSelected(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review(operation: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await api("import.review", { id, revision, operation });
      setPreview(result.preview);
      setRevision(result.revision);
      setSelected(
        Math.max(
          0,
          result.preview.chapters.findIndex(
            (item: { id: string }) => item.id === operation.chapterId,
          ),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入作品"
      >
        <div className="modal-heading">
          <h2>导入作品</h2>
          <button aria-label="关闭导入" onClick={onClose} disabled={busy}>
            <X />
          </button>
        </div>
        <p className="muted">
          先检查编码、分卷和章节边界；确认后新建作品，原文件保持不变。导入以本次预览为准，源稿后续修改需重新预览。自动拆分时将标题行移为章节标题，并统一换行符。
        </p>
        <div className="button-row">
          <button disabled={busy} onClick={() => choose(false)}>
            <FolderOpen size={16} />
            选择 TXT / Markdown
          </button>
          <button disabled={busy} onClick={() => choose(true)}>
            选择稿件目录
          </button>
        </div>
        {id && (
          <>
            <div className="import-options">
              <label>
                编码
                <select
                  aria-label="导入编码"
                  disabled={busy}
                  value={encoding}
                  onChange={(e) => {
                    setEncoding(e.target.value);
                    setPreview(null);
                  }}
                >
                  {["utf-8", "gb18030", "utf-16le", "utf-16be"].map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={split}
                  onChange={(e) => {
                    setSplit(e.target.checked);
                    setPreview(null);
                  }}
                />
                按章卷标题自动拆分
              </label>
              <button disabled={busy} onClick={reload}>
                重新预览
              </button>
            </div>
            {preview && (
              <>
                <p className="muted">
                  {preview.sources.length} 个源文件 · {preview.chapters.length}{" "}
                  章 · {preview.totalCharacters.toLocaleString()} 字符
                </p>
                <ImportPreviewEditor
                  preview={preview}
                  selected={selected}
                  onSelected={setSelected}
                  busy={busy}
                  onEdit={review}
                />
                <label className="stacked-label">
                  新作品名称
                  <input
                    aria-label="导入作品名称"
                    disabled={busy}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                  />
                </label>
              </>
            )}
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={!preview || busy || !title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                onImported(await api("import.commit", { id, revision, title }));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "处理中…" : "确认导入为新作品"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StructureDialog({
  book,
  onChange,
  onClose,
}: {
  book: Book;
  onChange: (book: Book) => void;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(book),
    [error, setError] = useState(""),
    [volumeTitle, setVolumeTitle] = useState(""),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(book.title),
    [genre, setGenre] = useState(book.genre || ""),
    [series, setSeries] = useState(book.series || ""),
    [author, setAuthor] = useState(book.author || "");
  async function mutate(mutation: object) {
    setBusy(true);
    setError("");
    try {
      const updated = await api<Book>("book.structure", {
        bookId: current.id,
        expectedRevision: current.revision,
        mutation,
      });
      setCurrent(updated);
      onChange(updated);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal structure-modal"
        role="dialog"
        aria-modal="true"
        aria-label="管理作品"
      >
        <div className="modal-heading">
          <h2>管理作品</h2>
          <button aria-label="关闭作品管理" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="book-fields">
          <label>
            书名
            <input
              aria-label="作品书名"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            作者
            <input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label>
            类型
            <input value={genre} onChange={(e) => setGenre(e.target.value)} />
          </label>
          <label>
            系列
            <input value={series} onChange={(e) => setSeries(e.target.value)} />
          </label>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            mutate({ type: "book-metadata", title, genre, series, author })
          }
        >
          保存作品信息
        </button>
        <div className="button-row volume-create">
          <input
            aria-label="新分卷名称"
            value={volumeTitle}
            onChange={(e) => setVolumeTitle(e.target.value)}
            placeholder="例如：第一卷 雾中的灯"
          />
          <button
            disabled={busy || !volumeTitle.trim()}
            onClick={async () => {
              if (await mutate({ type: "volume-create", title: volumeTitle }))
                setVolumeTitle("");
            }}
          >
            新建分卷
          </button>
        </div>
        <p className="muted">
          章节 ID 和正文文件保持稳定；删除进入回收站，恢复后保留正文与历史。
        </p>
        <div className="structure-list">
          {!!current.volumes?.length && (
            <div className="volume-order">
              <h3>分卷顺序</h3>
              {current.volumes.map((volume, index) => (
                <div className="volume-order-row" key={volume.id}>
                  <span>{volume.title}</span>
                  <button
                    title={`上移分卷 ${volume.title}`}
                    disabled={busy || index === 0}
                    onClick={() =>
                      mutate({
                        type: "volume-move",
                        volumeId: volume.id,
                        beforeId: current.volumes![index - 1].id,
                      })
                    }
                  >
                    <ArrowUp size={16} />
                    上移
                  </button>
                </div>
              ))}
            </div>
          )}
          {orderedChapters(current, { includeDeleted: true }).map(
            (chapter, index) => (
              <div
                className={`structure-row ${chapter.deletedAt ? "trashed" : ""}`}
                key={chapter.id}
              >
                <strong>{chapter.title}</strong>
                {chapter.deletedAt ? (
                  <>
                    <span>回收站</span>
                    <button
                      disabled={busy}
                      title={`恢复 ${chapter.title}`}
                      onClick={() =>
                        mutate({
                          type: "chapter-restore",
                          chapterId: chapter.id,
                        })
                      }
                    >
                      <RotateCcw size={16} />
                      恢复
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      aria-label={`${chapter.title} 所属分卷`}
                      disabled={busy}
                      value={chapter.volumeId || ""}
                      onChange={(e) =>
                        mutate({
                          type: "chapter-move",
                          chapterId: chapter.id,
                          volumeId: e.target.value || null,
                          beforeId: orderedChapters(current, {
                            includeDeleted: true,
                          })[index + 1]?.id,
                        })
                      }
                    >
                      <option value="">未分卷</option>
                      {current.volumes?.map((volume) => (
                        <option key={volume.id} value={volume.id}>
                          {volume.title}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${chapter.title} 状态`}
                      disabled={busy}
                      value={chapter.status}
                      onChange={(e) =>
                        mutate({
                          type: "chapter-status",
                          chapterId: chapter.id,
                          status: e.target.value,
                        })
                      }
                    >
                      <option value="draft">草稿</option>
                      <option value="reviewed">已审读</option>
                      <option value="final">正式</option>
                    </select>
                    <button
                      disabled={
                        busy ||
                        index === 0 ||
                        orderedChapters(current, { includeDeleted: true })[
                          index - 1
                        ].volumeId !== chapter.volumeId
                      }
                      title={`上移 ${chapter.title}`}
                      onClick={() =>
                        mutate({
                          type: "chapter-move",
                          chapterId: chapter.id,
                          volumeId: chapter.volumeId || null,
                          beforeId: orderedChapters(current, {
                            includeDeleted: true,
                          })[index - 1].id,
                        })
                      }
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      disabled={busy}
                      title={`移入回收站 ${chapter.title}`}
                      onClick={() =>
                        mutate({ type: "chapter-trash", chapterId: chapter.id })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            ),
          )}
        </div>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export type SearchHit = {
  chapterId: string;
  title: string;
  kind: string;
  start: number;
  end: number;
  excerpt: string;
  hash: string;
};
export function SearchDialog({
  book,
  onClose,
  onOpen,
}: {
  book: Book;
  onClose: () => void;
  onOpen: (hit: SearchHit) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<SearchHit[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [searched, setSearched] = useState(false),
    [truncated, setTruncated] = useState(false);
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide-modal"
        role="dialog"
        aria-modal="true"
        aria-label="书内全文搜索"
      >
        <div className="modal-heading">
          <h2>书内全文搜索</h2>
          <button aria-label="关闭全文搜索" onClick={onClose}>
            <X />
          </button>
        </div>
        <form
          className="button-row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const result = await api("book.search", {
                bookId: book.id,
                query,
              });
              setHits(result.hits);
              setTruncated(result.truncated);
              setSearched(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            autoFocus
            aria-label="全文检索词"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题与正文…"
          />
          <button className="primary" disabled={busy || !query.trim()}>
            <Search size={17} />
            搜索
          </button>
        </form>
        <p className="muted">当前作品：{book.title}。回收站内容不参与检索。</p>
        <div className="search-results">
          {hits.map((hit, index) => (
            <button key={index} onClick={() => onOpen(hit)}>
              <strong>
                {hit.title} · {hit.kind === "body" ? "正文" : "标题"}
              </strong>
              <p>{hit.excerpt}</p>
            </button>
          ))}
        </div>
        {searched && !hits.length && <p>没有找到匹配内容。</p>}
        {truncated && (
          <p className="muted">结果超过 200 条，请缩小检索范围。</p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
