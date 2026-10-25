import React, { useState } from "react";
import { api } from "./api";
type Origin = {
  importedAt: string;
  applicationVersion: string | null;
  encoding: string;
  automaticSplit: boolean;
  originalChapterCount: number;
  manualAdjustmentCount: number;
  sources: { name: string; bytes: number; sha256: string }[];
  chapters: { id: string; title: string; volume: string; sha256: string }[];
};
export function ImportOriginPanel({ bookId }: { bookId: string }) {
  const [result, setResult] = useState<{
    origin: Origin | null;
    restoredCopy: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(0);
  const [chapterPage, setChapterPage] = useState(0);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setResult(await api("book.import-origin", { bookId }));
      setPage(0);
      setChapterPage(0);
    } catch (error) {
      setResult(null);
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const origin = result?.origin,
    total = origin?.sources.length || 0;
  return (
    <details
      className="import-origin"
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !busy && !error) void load();
      }}
    >
      <summary>导入来源与确认记录</summary>
      <section aria-label="导入来源说明">
        <button disabled={busy} onClick={load}>
          重新读取导入来源
        </button>
        {busy && <p role="status">正在读取来源说明…</p>}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {result && !origin && (
          <p>
            此作品没有保留导入来源说明。旧版本导入或直接新建的作品都可能出现这种情况。
          </p>
        )}
        {origin && (
          <>
            <p>
              {new Date(origin.importedAt).toLocaleString()} · {origin.encoding}{" "}
              · 程序版本 {origin.applicationVersion || "未记录"}
            </p>
            <p>
              自动分章：{origin.automaticSplit ? "开启" : "关闭"}；初始{" "}
              {origin.originalChapterCount} 章 → 确认 {origin.chapters.length}{" "}
              章；手工调整 {origin.manualAdjustmentCount} 次。
            </p>
            {result?.restoredCopy && (
              <p role="status">
                这份说明来自恢复前的原作品，保留原始导入记录。
              </p>
            )}
            <p className="muted">
              以下为导入时的来源与结构，后续改稿保留这份确认记录。来源仅保存文件名和内容指纹。
            </p>
            <ul className="import-origin-files">
              {origin.sources
                .slice(page * 20, page * 20 + 20)
                .map((source, index) => (
                  <li key={page * 20 + index}>
                    <strong>{source.name}</strong> ·{" "}
                    {source.bytes.toLocaleString()} 字节
                    <details>
                      <summary>源文件 SHA-256</summary>
                      <code>{source.sha256}</code>
                    </details>
                  </li>
                ))}
            </ul>
            {total > 20 && (
              <div className="button-row">
                <button
                  disabled={busy || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  上一页来源
                </button>
                <span>
                  {page * 20 + 1}–{Math.min(total, (page + 1) * 20)} / {total}
                </span>
                <button
                  disabled={busy || (page + 1) * 20 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页来源
                </button>
              </div>
            )}
            <details>
              <summary>
                导入时的章节与内容指纹（{origin.chapters.length}）
              </summary>
              <p className="muted">
                章节名称、卷名和指纹对应导入当时，不代表当前正文版本。
              </p>
              {origin.chapters
                .slice(chapterPage * 20, chapterPage * 20 + 20)
                .map((chapter) => (
                  <p key={chapter.id}>
                    {chapter.volume && `${chapter.volume} · `}
                    {chapter.title}
                    <br />
                    <code>{chapter.sha256}</code>
                  </p>
                ))}
              {origin.chapters.length > 20 && (
                <div className="button-row">
                  <button
                    disabled={busy || chapterPage === 0}
                    onClick={() => setChapterPage(chapterPage - 1)}
                  >
                    上一页导入章节
                  </button>
                  <span>
                    {chapterPage * 20 + 1}–
                    {Math.min(origin.chapters.length, (chapterPage + 1) * 20)} /{" "}
                    {origin.chapters.length}
                  </span>
                  <button
                    disabled={
                      busy || (chapterPage + 1) * 20 >= origin.chapters.length
                    }
                    onClick={() => setChapterPage(chapterPage + 1)}
                  >
                    下一页导入章节
                  </button>
                </div>
              )}
            </details>
          </>
        )}
      </section>
    </details>
  );
}
