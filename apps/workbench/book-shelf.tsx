import React, { useEffect, useState } from "react";
import { BookOpen, Feather, Plus } from "lucide-react";
import type { Book } from "./api";
import { selectBooks } from "../../packages/novel-domain/library.mjs";
const defaults = {
  query: "",
  genre: "",
  series: "",
  archived: "active",
  sort: "recent",
};
function savedFilters() {
  try {
    const value = JSON.parse(
      localStorage.getItem("zinovel.shelfFilters") || "{}",
    );
    return Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        typeof value[key] === "string" ? value[key] : fallback,
      ]),
    ) as typeof defaults;
  } catch {
    return defaults;
  }
}
export function BookShelf({
  books,
  onOpen,
  onCreate,
  onImport,
  onBatch,
  onRestore,
  onArchive,
}: {
  books: Book[];
  onOpen: (book: Book) => void;
  onCreate: () => void;
  onImport: () => void;
  onBatch: () => void;
  onRestore: () => void;
  onArchive: (book: Book, archived: boolean) => Promise<void>;
}) {
  const [filters, setFilters] = useState(savedFilters),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem("zinovel.shelfFilters", JSON.stringify(filters));
    } catch {
      /* Nonessential preference; manuscripts still use the save/error flow. */
    }
  }, [filters]);
  const visible: Book[] = selectBooks(books, filters);
  const options = (key: "genre" | "series") =>
    Array.from(new Set(books.map((book) => book[key]).filter(Boolean))).sort(
      (a, b) => a!.localeCompare(b!, "zh-CN"),
    );
  return (
    <main className="library">
      <div className="library-heading">
        <div>
          <h1>把故事写下来</h1>
          <p>每一个世界，都从第一句话开始。</p>
        </div>
        <div className="button-row">
          <button onClick={onBatch}>灵感批量创作</button>
          <button onClick={onImport}>导入作品</button>
          <button onClick={onRestore}>恢复备份</button>
          <button className="primary" onClick={onCreate}>
            <Plus size={18} />
            新建作品
          </button>
        </div>
      </div>
      {books.length > 0 && (
        <>
          <div className="shelf-filters">
            <label>
              查找作品
              <input
                aria-label="查找书名或作者"
                placeholder="书名或作者"
                value={filters.query}
                onChange={(e) =>
                  setFilters({ ...filters, query: e.target.value })
                }
              />
            </label>
            <label>
              类型
              <select
                aria-label="筛选作品类型"
                value={filters.genre}
                onChange={(e) =>
                  setFilters({ ...filters, genre: e.target.value })
                }
              >
                <option value="">全部类型</option>
                {options("genre").map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              系列
              <select
                aria-label="筛选作品系列"
                value={filters.series}
                onChange={(e) =>
                  setFilters({ ...filters, series: e.target.value })
                }
              >
                <option value="">全部系列</option>
                {options("series").map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              范围
              <select
                aria-label="书库归档范围"
                value={filters.archived}
                onChange={(e) =>
                  setFilters({ ...filters, archived: e.target.value })
                }
              >
                <option value="active">正在创作</option>
                <option value="archived">已归档</option>
                <option value="all">全部作品</option>
              </select>
            </label>
            <label>
              排序
              <select
                aria-label="书库排序"
                value={filters.sort}
                onChange={(e) =>
                  setFilters({ ...filters, sort: e.target.value })
                }
              >
                <option value="recent">最近编辑</option>
                <option value="title">作品名称</option>
              </select>
            </label>
            <button onClick={() => setFilters(defaults)}>重置筛选</button>
          </div>
          <p className="muted">
            显示 {visible.length} / {books.length}{" "}
            部作品。归档保留正文、设定与历史，可随时恢复。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {visible.length > 0 ? (
        <div className="book-grid">
          {visible.map((book) => (
            <article className="shelf-book" key={book.id}>
              <button className="book-card" onClick={() => onOpen(book)}>
                <div className="book-cover">
                  <BookOpen size={34} />
                  <h2>{book.title}</h2>
                </div>
                <div className="book-card-detail">
                  <strong>{book.title}</strong>
                  <span>
                    {
                      book.chapters.filter((chapter) => !chapter.deletedAt)
                        .length
                    }{" "}
                    章 · {new Date(book.updatedAt).toLocaleDateString("zh-CN")}
                  </span>
                  <span>
                    {[book.genre, book.series, book.archivedAt ? "已归档" : ""]
                      .filter(Boolean)
                      .join(" · ") || "尚未分类"}
                  </span>
                </div>
              </button>
              <button
                className="shelf-archive"
                disabled={busy !== null}
                aria-label={`${book.archivedAt ? "取消归档" : "归档作品"} ${book.title}`}
                onClick={async () => {
                  setBusy(book.id);
                  setError("");
                  try {
                    await onArchive(book, !book.archivedAt);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {book.archivedAt ? "取消归档" : "归档作品"}
              </button>
            </article>
          ))}
        </div>
      ) : books.length ? (
        <div className="empty-library">
          <h2>没有符合筛选条件的作品</h2>
          <button onClick={() => setFilters(defaults)}>
            查看正在创作的作品
          </button>
        </div>
      ) : (
        <section className="empty-library">
          <Feather size={50} />
          <h2>为你的第一部作品留个位置</h2>
          <p>作品以本地文件保存。没有网络，也可以安心写作。</p>
          <button onClick={onCreate}>
            <Plus size={18} />
            创建第一部作品
          </button>
        </section>
      )}
    </main>
  );
}
