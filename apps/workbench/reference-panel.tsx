import React, { useEffect, useRef, useState } from "react";
import { api, type Book, type Chapter } from "./api";
import { orderedChapters } from "../../packages/novel-domain/structure.mjs";
type Version = { id: string; at: string; body: string; label?: string };

/** Reference content is a captured read-only snapshot, never an editable second source. */
export function ReferencePanel({
  book,
  chapterId,
}: {
  book: Book;
  chapterId?: string;
}) {
  const [selected, setSelected] = useState(() => {
    try {
      const saved = localStorage.getItem(`zinovel.reference.${book.id}`);
      return book.chapters.some(
        (chapter) => chapter.id === saved && !chapter.deletedAt,
      )
        ? saved!
        : chapterId || "";
    } catch {
      return chapterId || "";
    }
  });
  const [versions, setVersions] = useState<Version[]>([]),
    [captured, setCaptured] = useState<Chapter | null>(null);
  const [versionId, setVersionId] = useState("current"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const request = useRef(0);
  async function load(id: string) {
    const token = ++request.current;
    setLoading(true);
    setError("");
    setCaptured(null);
    setVersions([]);
    setVersionId("current");
    try {
      if (!id) return;
      const [chapter, history] = await Promise.all([
        api<Chapter>("chapter.read", { bookId: book.id, chapterId: id }),
        api<Version[]>("chapter.history", { bookId: book.id, chapterId: id }),
      ]);
      if (token !== request.current) return;
      setCaptured(chapter);
      setVersions(history);
      try {
        localStorage.setItem(`zinovel.reference.${book.id}`, id);
      } catch {}
    } catch (e) {
      if (token === request.current) setError((e as Error).message);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load(selected);
    return () => {
      request.current++;
    };
  }, [selected]);
  const reference =
    versionId === "current"
      ? captured?.body
      : versions.find((version) => version.id === versionId)?.body;
  return (
    <section className="reference-reader">
      <h3>旧稿参考</h3>
      <p className="muted">
        参考内容固定在读取时的版本，不随正文输入变化。只读查看，不会覆盖编辑稿。
      </p>
      <label>
        参考章节
        <select
          aria-label="参考章节"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">选择本书章节</option>
          {orderedChapters(book).map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              {chapter.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        参考版本
        <select
          aria-label="参考版本"
          disabled={!captured || loading}
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
        >
          <option value="current">本次读取的磁盘稿</option>
          {versions.map((version, index) => (
            <option key={version.id} value={version.id}>
              {version.label || `历史版本 ${index + 1}`} ·{" "}
              {new Date(version.at).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
      </label>
      <button disabled={loading || !selected} onClick={() => load(selected)}>
        {loading ? "正在读取" : "重新读取参考稿"}
      </button>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {captured && (
        <>
          <h4>{captured.title}</h4>
          <p className="muted">
            {versionId === "current"
              ? `磁盘快照 · ${captured.diskHash.slice(0, 10)}`
              : "历史快照"}
          </p>
          <article className="reference-prose" aria-label="只读参考正文">
            {reference || "（空白稿）"}
          </article>
        </>
      )}
    </section>
  );
}
