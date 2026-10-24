import React, { useEffect, useState } from "react";
import { api } from "./api";
import type { AssetRecord } from "../../packages/novel-domain/assets.mjs";
import type {
  PublicationResourceSelection,
  PublicationResourceReference,
} from "../../packages/novel-domain/publication-resources.mjs";

export function PublicationResourceEditor({
  bookId,
  chapters,
  value,
  onChange,
}: {
  bookId: string;
  chapters: { id: string; title: string }[];
  value: readonly PublicationResourceSelection[];
  onChange: (next: PublicationResourceSelection[]) => void;
}) {
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<AssetRecord[]>([]),
    [total, setTotal] = useState(0),
    [candidateId, setCandidateId] = useState("");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [image, setImage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const candidate = items.find((item) => item.id === candidateId);
  useEffect(() => {
    if (!expanded) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api<{
        items: AssetRecord[];
        total: number;
        errors: { error: string }[];
      }>("assets.list", { bookId, options: { query, offset } })
        .then((result) => {
          if (!active) return;
          setItems(result.items);
          setTotal(result.total);
          setCandidateId((previous) =>
            result.items.some((item) => item.id === previous)
              ? previous
              : result.items[0]?.id || "",
          );
          if (result.errors.length)
            setError(result.errors.map((item) => item.error).join("；"));
        })
        .catch((e) => {
          if (active) {
            setItems([]);
            setError(e.message);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bookId, query, offset, refresh, expanded]);
  useEffect(() => {
    let active = true;
    setImage("");
    if (expanded && candidate)
      void api<{ dataUrl: string }>("assets.preview", {
        bookId,
        expected: {
          id: candidate.id,
          revision: candidate.revision,
          diskHash: candidate.diskHash,
        },
      })
        .then((result) => {
          if (active) setImage(result.dataUrl);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [
    bookId,
    candidate?.id,
    candidate?.revision,
    candidate?.diskHash,
    expanded,
  ]);
  const expected = () => ({
    id: candidate!.id,
    revision: candidate!.revision,
    diskHash: candidate!.diskHash,
  });
  function update(index: number, patch: Partial<PublicationResourceSelection>) {
    onChange(
      value.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }
  return (
    <details
      className="publication-resource-editor"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>封面与插图（已选{value.length}处）</summary>
      <p>
        先在“图像资源”导入图片，再明确选择本次出版使用的版本。发行图保留完整尺寸和显示方向、去除图片元数据；不会改写原图。含图副本当前导出HTML。
      </p>
      <label>
        查找出版图像
        <input
          aria-label="查找出版图像"
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>
        刷新出版图像列表
      </button>
      {loading && <p role="status">正在读取出版图像…</p>}
      {error && <p role="alert">{error}</p>}
      <label>
        本书图像
        <select
          aria-label="本书出版图像"
          value={candidateId}
          onChange={(event) => setCandidateId(event.target.value)}
        >
          <option value="">请选择图像</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} · 版本{item.revision}
            </option>
          ))}
        </select>
      </label>
      <div className="publication-actions">
        <button
          type="button"
          disabled={offset === 0 || loading}
          onClick={() => setOffset(Math.max(0, offset - 40))}
        >
          上一页图像
        </button>
        <span>
          {total
            ? `${offset + 1}–${Math.min(offset + 40, total)} / ${total}`
            : "没有可选图像"}
        </span>
        <button
          type="button"
          disabled={offset + 40 >= total || loading}
          onClick={() => setOffset(offset + 40)}
        >
          下一页图像
        </button>
      </div>
      {image && (
        <img
          className="publication-resource-thumbnail"
          src={image}
          alt="当前候选图像预览"
        />
      )}
      <button
        type="button"
        disabled={!candidate || value.length >= 32 || loading}
        onClick={() =>
          onChange([
            ...value,
            {
              asset: expected(),
              placement: value.some((item) => item.placement === "cover")
                ? "chapter-end"
                : "cover",
              chapterId: value.some((item) => item.placement === "cover")
                ? chapters[0]?.id || null
                : null,
              alt: candidate!.title,
              caption: "",
              credit: "",
            },
          ])
        }
      >
        加入本次发布图像
      </button>
      {value.map((item, index) => (
        <fieldset key={index} className="publication-resource-choice">
          <legend>
            图{index + 1} · 所选版本
            {item.asset.revision}
          </legend>
          <label>
            位置
            <select
              aria-label={`图${index + 1}位置`}
              value={item.placement}
              onChange={(event) => {
                const placement = event.target
                  .value as PublicationResourceSelection["placement"];
                update(index, {
                  placement,
                  chapterId:
                    placement === "cover"
                      ? null
                      : item.chapterId || chapters[0]?.id || null,
                });
              }}
            >
              <option value="cover">封面</option>
              <option value="chapter-start">章节开头</option>
              <option value="chapter-end">章节结尾</option>
            </select>
          </label>
          {item.placement !== "cover" && (
            <label>
              所属章
              <select
                aria-label={`图${index + 1}所属章`}
                value={item.chapterId || ""}
                onChange={(event) =>
                  update(index, { chapterId: event.target.value || null })
                }
              >
                <option value="">请选择发布章</option>
                {item.chapterId &&
                  !chapters.some(
                    (chapter) => chapter.id === item.chapterId,
                  ) && <option value={item.chapterId}>未选此章，请调整</option>}
                {chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            替代文字
            <input
              aria-label={`图${index + 1}替代文字`}
              maxLength={2000}
              value={item.alt}
              onChange={(event) => update(index, { alt: event.target.value })}
            />
          </label>
          <label>
            公开图注
            <textarea
              aria-label={`图${index + 1}公开图注`}
              maxLength={4000}
              value={item.caption}
              onChange={(event) =>
                update(index, { caption: event.target.value })
              }
            />
          </label>
          <label>
            公开署名
            <textarea
              aria-label={`图${index + 1}公开署名`}
              maxLength={4000}
              value={item.credit}
              onChange={(event) =>
                update(index, { credit: event.target.value })
              }
            />
          </label>
          <div className="publication-actions">
            <button
              type="button"
              disabled={!candidate}
              onClick={() => update(index, { asset: expected() })}
            >
              图{index + 1}改用上方所选图像版本
            </button>
            <button
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              移除图{index + 1}
            </button>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => {
                const next = [...value];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange(next);
              }}
            >
              上移图{index + 1}
            </button>
          </div>
        </fieldset>
      ))}
    </details>
  );
}

export function FrozenPublicationImages({
  bookId,
  snapshotId,
  hash,
  resources,
  chapterId,
  placement,
}: {
  bookId: string;
  snapshotId: string;
  hash: string;
  resources: readonly PublicationResourceReference[];
  chapterId: string;
  placement: PublicationResourceReference["placement"];
}) {
  const selected = resources
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.placement === placement &&
        (item.placement === "cover" || item.chapterId === chapterId),
    );
  return (
    <section aria-label="冻结出版图像">
      {selected.map(({ item, index }) => (
        <FrozenImage
          key={`${snapshotId}:${hash}:${index}`}
          bookId={bookId}
          snapshotId={snapshotId}
          hash={hash}
          item={item}
          index={index}
        />
      ))}
    </section>
  );
}
function FrozenImage({
  bookId,
  snapshotId,
  hash,
  item,
  index,
}: {
  bookId: string;
  snapshotId: string;
  hash: string;
  item: PublicationResourceReference;
  index: number;
}) {
  const [image, setImage] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ dataUrl: string }>("publication.image", {
      bookId,
      id: snapshotId,
      hash,
      index,
    })
      .then((result) => {
        if (active) setImage(result.dataUrl);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [bookId, snapshotId, hash, index]);
  return (
    <figure className="publication-frozen-image">
      {image ? (
        <img src={image} alt={item.alt} />
      ) : (
        <p role={error ? "alert" : "status"}>{error || "正在读取冻结图像…"}</p>
      )}
      <figcaption>
        {item.caption && <p>{item.caption}</p>}
        {item.credit && <p>{item.credit}</p>}
        <p className="muted">
          {item.placement === "cover"
            ? "封面"
            : item.placement === "chapter-start"
              ? "章首插图"
              : "章尾插图"}{" "}
          · 冻结来源版本{item.source.revision}
        </p>
      </figcaption>
    </figure>
  );
}
