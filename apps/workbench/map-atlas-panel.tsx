import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type Book } from "./api";
import { registerEditorCloseGuard } from "./editor-close-guards";
import {
  mapAtlasInput,
  mapAtlasDraftInput,
  parseMapAtlasDraft,
  type MapAtlasInput,
  type MapAtlasRecord,
  type MapAtlasReference,
  type MapAtlasEntry,
  type MapEpoch,
} from "../../packages/novel-domain/map-atlas.mjs";
import type {
  MapRecord,
  MapSummary,
} from "../../packages/novel-domain/maps.mjs";

const blank = (): MapAtlasInput => ({ notes: "", epochs: [], entries: [] });
const fields = (record: MapAtlasRecord | null): MapAtlasInput =>
  record
    ? { notes: record.notes, epochs: record.epochs, entries: record.entries }
    : blank();
const reference = (record: MapAtlasRecord | null): MapAtlasReference | null =>
  record ? { revision: record.revision, diskHash: record.diskHash } : null;
const same = (a: MapAtlasReference | null, b: MapAtlasReference | null) =>
  a === null
    ? b === null
    : !!b && a.revision === b.revision && a.diskHash === b.diskHash;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const newEntry = (id: string): MapAtlasEntry => ({
  mapId: id,
  parentId: null,
  anchorId: null,
  epochId: null,
  notes: "",
});
interface Row {
  entry: MapAtlasEntry;
  title: string | null;
  state: string;
  error: string | null;
  parentTitle: string | null;
  parentState: string | null;
  parentError: string | null;
  anchorTitle: string | null;
  anchorState: string | null;
}
interface Inspection {
  record: MapAtlasRecord | null;
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
  mapNames: "current";
}
interface Editor {
  record: MapAtlasRecord | null;
  expected: MapAtlasReference | null;
  input: MapAtlasInput;
  selected: string | null;
  dirty: boolean;
  ready: boolean;
  busy: boolean;
  composing: boolean;
  blocked: "unknown" | "competing" | null;
  cleanup: boolean;
}
const initial = (): Editor => ({
  record: null,
  expected: null,
  input: blank(),
  selected: null,
  dirty: false,
  ready: false,
  busy: false,
  composing: false,
  blocked: null,
  cleanup: false,
});

function MapPicker({
  bookId,
  label,
  excluded,
  disabled,
  onSelect,
}: {
  bookId: string;
  label: string;
  excluded?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<{
      items: MapSummary[];
      total: number;
      errors: string[];
    }>({ items: [], total: 0, errors: [] }),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () =>
        api<typeof result>("maps.list", { bookId, options: { query, offset } })
          .then((next) => {
            if (active) {
              setResult(next);
              setError("");
            }
          })
          .catch((error) => {
            if (active) setError(errorText(error));
          }),
      120,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bookId, query, offset]);
  return (
    <details className="atlas-map-picker" aria-label={label}>
      <summary>{label}</summary>
      <label>
        {label}搜索
        <input
          aria-label={`${label}搜索`}
          maxLength={200}
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {result.errors.map((text, index) => (
        <p role="alert" key={index}>
          {text}
        </p>
      ))}
      <p>{result.total}张有效地图 · 每页40张</p>
      <div className="map-choice-list">
        {result.items
          .filter((item) => item.id !== excluded)
          .map((item) => (
            <button
              type="button"
              disabled={disabled}
              key={item.id}
              onClick={() => onSelect(item.id)}
            >
              {item.title} · {item.era || "未填写年代标签"}
            </button>
          ))}
      </div>
      <nav>
        <button
          type="button"
          disabled={disabled || !offset}
          onClick={() => setOffset(Math.max(0, offset - 40))}
        >
          上一页{label}
        </button>
        <button
          type="button"
          disabled={disabled || offset + 40 >= result.total}
          onClick={() => setOffset(offset + 40)}
        >
          下一页{label}
        </button>
      </nav>
    </details>
  );
}

export function MapAtlasPanel({
  book,
  initialMapId,
  onClose,
  onOpenMap,
}: {
  book: Book;
  initialMapId: string | null;
  onClose: () => void;
  onOpenMap: (id: string) => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<Editor>(initial),
    state = useRef(editor),
    seen = useRef<string | null>(null),
    alive = useRef(true);
  const [directoryExpanded, setDirectoryExpanded] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [epochFilter, setEpochFilter] = useState("all"),
    [scope, setScope] = useState("all"),
    [offset, setOffset] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null),
    [inspectError, setInspectError] = useState("");
  const [history, setHistory] = useState<MapAtlasRecord[]>([]),
    [historyErrors, setHistoryErrors] = useState<string[]>([]),
    [historical, setHistorical] = useState<MapAtlasRecord | null>(null);
  const [comparison, setComparison] = useState<{
    record: MapAtlasRecord | null;
  } | null>(null);
  const [selectedMap, setSelectedMap] = useState<MapRecord | null>(null),
    [selectedError, setSelectedError] = useState(""),
    [parentMap, setParentMap] = useState<MapRecord | null>(null),
    [parentError, setParentError] = useState("");
  const cacheKey = `zinovel.atlas-draft.${book.id}`;
  const selectedEntry =
    editor.input.entries.find((entry) => entry.mapId === editor.selected) ??
    null;
  const parentEntry = editor.input.entries.find(
    (entry) => entry.mapId === selectedEntry?.parentId,
  );
  function patch(value: Partial<Editor>) {
    const next = { ...state.current, ...value };
    state.current = next;
    if (alive.current) setEditor(next);
  }
  function change(input: MapAtlasInput) {
    const current = state.current;
    if (
      !current.ready ||
      current.busy ||
      current.cleanup ||
      current.blocked === "unknown" ||
      historical
    )
      return;
    try {
      patch({ input: mapAtlasDraftInput(input), dirty: true });
      setError("");
      setNotice("");
    } catch (error) {
      setError(errorText(error));
    }
  }
  function updateEntry(value: MapAtlasEntry) {
    change({
      ...state.current.input,
      entries: state.current.input.entries.map((entry) =>
        entry.mapId === value.mapId ? value : entry,
      ),
    });
  }
  function clearCache() {
    try {
      const current = localStorage.getItem(cacheKey);
      if (current !== seen.current) {
        patch({ cleanup: false, blocked: "competing" });
        setNotice("作品已保存；本机另一份草稿仍保留，重新打开时请对照。");
        return false;
      }
      localStorage.removeItem(cacheKey);
      seen.current = null;
      patch({ cleanup: false, blocked: null });
      return true;
    } catch {
      patch({ cleanup: true });
      setError("地图册已保存，本机草稿尚未清理；请重试清理，勿重复保存。");
      return false;
    }
  }
  function persist(closing = false) {
    const current = state.current;
    if (
      !current.ready ||
      current.busy ||
      current.composing ||
      current.cleanup
    ) {
      if (closing)
        setError(
          current.cleanup
            ? "地图册已保存，请先重试清理草稿。"
            : "正在处理地图册或输入法组合，请稍后关闭。",
        );
      return false;
    }
    if (!current.dirty) return true;
    if (current.blocked === "unknown") return false;
    try {
      if (localStorage.getItem(cacheKey) !== seen.current) {
        patch({ blocked: "competing" });
        setError(
          "本机地图册草稿已被另一窗口改变，已保留。当前输入仍可保存到作品，或明确放弃后重读。",
        );
        return false;
      }
      const raw = JSON.stringify({
        schemaVersion: 1,
        bookId: book.id,
        expected: current.expected,
        input: current.input,
        selectedMapId: current.selected,
      });
      parseMapAtlasDraft(raw, book.id);
      localStorage.setItem(cacheKey, raw);
      seen.current = raw;
      return true;
    } catch {
      setError(
        "本机地图册草稿暂不能保存，输入仍在窗口。可完成后保存到作品，或明确放弃调整；关闭已阻止。",
      );
      return false;
    }
  }
  function load(record: MapAtlasRecord | null, restore = true) {
    let next: Editor = {
      ...initial(),
      ready: true,
      record,
      expected: reference(record),
      input: fields(record),
      selected: initialMapId,
    };
    try {
      const raw = localStorage.getItem(cacheKey);
      seen.current = raw;
      if (restore && raw !== null) {
        const draft = parseMapAtlasDraft(raw, book.id);
        next = {
          ...next,
          input: draft.input,
          expected: draft.expected,
          selected: draft.selectedMapId,
          dirty:
            JSON.stringify(draft.input) !== JSON.stringify(fields(record)) ||
            !same(draft.expected, reference(record)),
        };
        setNotice("已恢复本机地图册草稿，正式保存前核对当前存档。");
      }
    } catch {
      next.blocked = "unknown";
      setError(
        "本机地图册草稿无法识别或读取，原记录保留。明确放弃后才能编辑。",
      );
    }
    state.current = next;
    setEditor(next);
    setHistorical(null);
    setComparison(null);
    setRefresh((n) => n + 1);
  }
  useEffect(() => {
    alive.current = true;
    api<MapAtlasRecord | null>("atlas.read", { bookId: book.id })
      .then((record) => {
        if (alive.current) load(record);
      })
      .catch((error) => {
        if (alive.current) {
          patch({ ready: true, blocked: "unknown" });
          setError(errorText(error));
        }
      });
    return () => {
      alive.current = false;
    };
  }, [book.id]);
  useEffect(() => registerEditorCloseGuard(() => persist(true)), [book.id]);
  useEffect(() => {
    if (!editor.ready || !editor.dirty || editor.busy || editor.cleanup) return;
    const timer = setTimeout(() => persist(), 160);
    return () => clearTimeout(timer);
  }, [
    editor.input,
    editor.selected,
    editor.expected,
    editor.dirty,
    editor.ready,
    editor.busy,
    editor.cleanup,
    editor.composing,
  ]);
  useEffect(() => {
    if (!editor.ready) return;
    let active = true;
    const options: Record<string, unknown> = { offset };
    if (epochFilter !== "all")
      options.epochId = epochFilter === "none" ? null : epochFilter;
    if (scope === "root") options.parentId = null;
    else if (scope === "children" && editor.selected)
      options.parentId = editor.selected;
    if (historical) options.historical = reference(historical);
    setInspectError("");
    setInspection(null);
    api<Inspection>("atlas.inspect", { bookId: book.id, options })
      .then((result) => {
        if (active) setInspection(result);
      })
      .catch((error) => {
        if (active) setInspectError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [
    book.id,
    editor.ready,
    editor.record?.diskHash,
    editor.selected,
    epochFilter,
    scope,
    offset,
    historical?.diskHash,
    refresh,
  ]);
  useEffect(() => {
    if (!editor.ready) return;
    let active = true;
    api<{ items: MapAtlasRecord[]; errors: string[] }>("atlas.history", {
      bookId: book.id,
    })
      .then((result) => {
        if (active) {
          setHistory(result.items);
          setHistoryErrors(result.errors);
        }
      })
      .catch((error) => {
        if (active) setHistoryErrors([errorText(error)]);
      });
    return () => {
      active = false;
    };
  }, [book.id, editor.ready, editor.record?.diskHash, refresh]);
  useEffect(() => {
    let active = true;
    setSelectedMap(null);
    setSelectedError("");
    if (editor.selected)
      api<MapRecord>("maps.read", { bookId: book.id, id: editor.selected })
        .then((record) => {
          if (active) setSelectedMap(record);
        })
        .catch((error) => {
          if (active) setSelectedError(errorText(error));
        });
    return () => {
      active = false;
    };
  }, [book.id, editor.selected, refresh]);
  useEffect(() => {
    let active = true;
    setParentMap(null);
    setParentError("");
    if (selectedEntry?.parentId)
      api<MapRecord>("maps.read", {
        bookId: book.id,
        id: selectedEntry.parentId,
      })
        .then((record) => {
          if (active) setParentMap(record);
        })
        .catch((error) => {
          if (active) setParentError(errorText(error));
        });
    return () => {
      active = false;
    };
  }, [book.id, selectedEntry?.parentId, refresh]);
  async function save() {
    const current = state.current;
    if (
      !current.ready ||
      !current.dirty ||
      current.busy ||
      current.composing ||
      current.cleanup ||
      current.blocked === "unknown" ||
      historical
    )
      return;
    try {
      const input = mapAtlasInput(current.input);
      if (
        !same(current.expected, reference(current.record)) &&
        current.record &&
        JSON.stringify(input) === JSON.stringify(fields(current.record))
      ) {
        patch({ busy: true });
        const disk = await api<MapAtlasRecord | null>("atlas.read", {
          bookId: book.id,
        });
        if (!alive.current) return;
        if (!disk || disk.diskHash !== current.record.diskHash)
          throw Error("磁盘地图册又有变化，当前草稿已保留，请重新对照。");
        patch({ expected: reference(current.record), dirty: false });
        if (clearCache())
          setNotice("内容已在当前地图册存档中，未创建重复修订。");
        return;
      }
      if (!same(current.expected, reference(current.record)))
        throw Error("本机地图册基线已过期，请读取磁盘目录供对照。");
      persist();
      patch({ busy: true });
      setError("");
      setNotice("");
      const record = await api<MapAtlasRecord>("atlas.save", {
        bookId: book.id,
        input,
        expected: current.expected,
      });
      if (!alive.current) return;
      patch({
        record,
        expected: reference(record),
        input: fields(record),
        dirty: false,
        busy: false,
      });
      setComparison(null);
      setHistorical(null);
      setRefresh((n) => n + 1);
      if (clearCache())
        setNotice("地图册已保存；原目录仍在历史中，地图图形没有改动。");
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      if (alive.current) patch({ busy: false });
    }
  }
  async function discard() {
    if (state.current.busy || state.current.composing) return;
    patch({ busy: true });
    setError("");
    try {
      const record = await api<MapAtlasRecord | null>("atlas.read", {
        bookId: book.id,
      });
      if (!alive.current) return;
      localStorage.removeItem(cacheKey);
      seen.current = null;
      load(record, false);
      setNotice("已明确放弃本机地图册草稿，重新读取当前目录。");
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      if (alive.current) patch({ busy: false });
    }
  }
  async function compare() {
    if (state.current.busy) return;
    setError("");
    try {
      const record = await api<MapAtlasRecord | null>("atlas.read", {
        bookId: book.id,
      });
      if (alive.current) {
        setComparison({ record });
        setNotice("磁盘目录仅供对照，当前输入没有改变。");
      }
    } catch (error) {
      if (alive.current) setError(errorText(error));
    }
  }
  async function adopt() {
    const current = state.current;
    if (
      !historical ||
      !current.record ||
      current.busy ||
      current.dirty ||
      current.blocked ||
      current.composing ||
      current.cleanup
    )
      return;
    patch({ busy: true });
    setError("");
    try {
      const record = await api<MapAtlasRecord>("atlas.restore-version", {
        bookId: book.id,
        expected: reference(current.record),
        historical: reference(historical),
      });
      if (!alive.current) return;
      patch({
        record,
        input: fields(record),
        expected: reference(record),
        dirty: false,
        busy: false,
      });
      setHistorical(null);
      setRefresh((n) => n + 1);
      if (clearCache())
        setNotice("历史目录已采用为新版本，后续版本和地图原件仍保留。");
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      if (alive.current) patch({ busy: false });
    }
  }
  async function navigate(id: string) {
    if (!persist(true)) return;
    try {
      if (await onOpenMap(id)) onClose();
    } catch (error) {
      setError(errorText(error));
    }
  }
  function select(id: string) {
    if (state.current.busy || state.current.composing) return;
    patch({ selected: id });
    setDirectoryExpanded(false);
    setScope("all");
    setOffset(0);
  }
  function chooseParent(id: string) {
    const current = state.current,
      entry = current.input.entries.find(
        (item) => item.mapId === current.selected,
      );
    if (!entry || id === entry.mapId) return;
    let entries = current.input.entries.map((item) =>
      item.mapId === entry.mapId
        ? { ...item, parentId: id, anchorId: null }
        : item,
    );
    if (!entries.some((item) => item.mapId === id)) {
      entries = [...entries, newEntry(id)];
      setNotice("父图同时加入顶层目录；选择锚点并明确保存后生效。");
    }
    change({ ...current.input, entries });
  }
  function epochChange(epoch: MapEpoch) {
    change({
      ...state.current.input,
      epochs: state.current.input.epochs.map((item) =>
        item.id === epoch.id ? epoch : item,
      ),
    });
  }
  function epochMove(index: number, delta: number) {
    const epochs = [...state.current.input.epochs],
      target = index + delta;
    if (target < 0 || target >= epochs.length) return;
    [epochs[index], epochs[target]] = [epochs[target], epochs[index]];
    change({ ...state.current.input, epochs });
  }
  const names = useMemo(() => {
    const result = new Map<string, string>();
    for (const row of inspection?.rows || []) {
      if (row.title) result.set(row.entry.mapId, row.title);
      if (row.parentTitle && row.entry.parentId)
        result.set(row.entry.parentId, row.parentTitle);
    }
    if (selectedMap) result.set(selectedMap.id, selectedMap.title);
    if (parentMap) result.set(parentMap.id, parentMap.title);
    return result;
  }, [inspection, selectedMap, parentMap]);
  const label = (id: string | null) =>
    id ? names.get(id) || `地图编号 ${id.slice(0, 8)}` : "顶层";
  const writable =
    editor.ready &&
    !editor.busy &&
    !editor.cleanup &&
    editor.blocked !== "unknown" &&
    !historical;
  const shown = historical ?? editor.record;
  const anchors =
    parentMap?.elements.filter(
      (element) =>
        !element.deletedAt && ["place", "region"].includes(element.kind),
    ) || [];
  return (
    <div className="modal-backdrop atlas-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="地图年代与层级"
        className="assets-dialog atlas-dialog"
        onCompositionStart={() => patch({ composing: true })}
        onCompositionEnd={() => patch({ composing: false })}
      >
        <header className="assets-header">
          <div>
            <h2>地图年代与层级</h2>
            <p>作者手工分组与父子图。每张地图保持独立坐标、底图与比例尺。</p>
          </div>
          <div className="map-header-actions">
            <button
              type="button"
              data-dialog-save
              className="primary"
              disabled={!editor.dirty || !writable || editor.composing}
              onClick={save}
            >
              保存地图册
            </button>
            <button
              type="button"
              onClick={() => {
                if (persist(true)) onClose();
              }}
            >
              关闭地图册
            </button>
            <button
              type="button"
              disabled={editor.busy}
              onClick={() => {
                setRefresh((n) => n + 1);
                setNotice("重新核对已保存目录和地图状态，当前输入保留。");
              }}
            >
              重新核对地图册
            </button>
          </div>
        </header>
        <div className="assets-notices atlas-notices">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {editor.dirty && <p>有未保存的目录调整；正式保存后进入作品备份。</p>}
          {!editor.ready && <p role="status">正在读取地图册…</p>}
          {editor.busy && <p role="status">正在处理地图册…</p>}
          {editor.cleanup && (
            <button type="button" onClick={clearCache}>
              重试清理地图册草稿
            </button>
          )}
        </div>
        <button
          type="button"
          className="atlas-catalog-toggle"
          aria-expanded={directoryExpanded}
          aria-controls="world-atlas-directory"
          onClick={() => setDirectoryExpanded(!directoryExpanded)}
        >
          {directoryExpanded ? "收起地图目录" : "展开地图目录"}
        </button>
        <div
          className={`atlas-layout${directoryExpanded ? " atlas-directory-expanded" : ""}`}
        >
          <aside className="atlas-directory" id="world-atlas-directory">
            <h3>
              {historical
                ? `历史目录 · 第${historical.revision}版`
                : `已保存目录 · ${editor.record ? `第${editor.record.revision}版` : "尚未创建"}`}
            </h3>
            <p>切换只打开地图，不合并图形；未加入目录的地图仍在全部地图中。</p>
            <label>
              年代组筛选
              <select
                aria-label="目录年代组筛选"
                value={epochFilter}
                onChange={(event) => {
                  setEpochFilter(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="all">全部年代组</option>
                <option value="none">未分组</option>
                {shown?.epochs.map((epoch) => (
                  <option key={epoch.id} value={epoch.id}>
                    {epoch.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              层级筛选
              <select
                aria-label="目录层级筛选"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="all">全部目录</option>
                <option value="root">顶层地图</option>
                <option value="children" disabled={!editor.selected}>
                  当前所选地图的子图
                </option>
              </select>
            </label>
            {inspectError && <p role="alert">{inspectError}</p>}
            {inspection && <p>{inspection.total}项 · 每页40项</p>}
            <div className="atlas-node-list">
              {inspection?.rows.map((row) => (
                <article
                  key={row.entry.mapId}
                  className={
                    row.entry.mapId === editor.selected ? "selected" : ""
                  }
                >
                  <button
                    type="button"
                    disabled={editor.busy}
                    onClick={() => select(row.entry.mapId)}
                  >
                    {row.title ||
                      `无法读取的地图 ${row.entry.mapId.slice(0, 8)}`}
                  </button>
                  <p>
                    {row.entry.parentId
                      ? `${row.parentTitle || "失联父图"} → ${row.anchorTitle || "失联锚点"}`
                      : "顶层地图"}
                  </p>
                  {row.state !== "ready" && (
                    <p role="alert">
                      {row.state === "retired"
                        ? "地图已回收"
                        : row.error || "地图不可用"}
                      ；引用保留。
                    </p>
                  )}
                  {row.anchorState && row.anchorState !== "ready" && (
                    <p role="alert">父图或锚点不可用，未自动改接。</p>
                  )}
                  <p>{row.entry.notes}</p>
                  <button
                    type="button"
                    disabled={editor.busy || row.state !== "ready"}
                    onClick={() => navigate(row.entry.mapId)}
                  >
                    打开地图 · {row.title || "不可用"}
                  </button>
                </article>
              ))}
            </div>
            <nav>
              <button
                type="button"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 40))}
              >
                上一页目录
              </button>
              <button
                type="button"
                disabled={!inspection || offset + 40 >= inspection.total}
                onClick={() => setOffset(offset + 40)}
              >
                下一页目录
              </button>
            </nav>
            <p>
              名称来自当前地图；历史只保留当时的目录关系与分组，不是地图图形快照。
            </p>
          </aside>
          <main className="atlas-editor">
            {historical ? (
              <div className="map-warning">
                <p>当前只读查看历史目录，未改当前输入或地图。</p>
                <button
                  type="button"
                  onClick={() => {
                    setHistorical(null);
                    setOffset(0);
                  }}
                >
                  返回当前地图册
                </button>
                <button
                  type="button"
                  disabled={
                    editor.busy ||
                    editor.dirty ||
                    !!editor.blocked ||
                    editor.cleanup ||
                    editor.composing
                  }
                  onClick={adopt}
                >
                  采用此历史目录为新版本
                </button>
              </div>
            ) : (
              <>
                <fieldset disabled={!writable}>
                  <label>
                    地图册说明
                    <textarea
                      aria-label="地图册说明"
                      maxLength={12000}
                      value={editor.input.notes}
                      onChange={(event) =>
                        change({ ...editor.input, notes: event.target.value })
                      }
                    />
                  </label>
                  <details className="atlas-epochs">
                    <summary>
                      编辑年代组 · {editor.input.epochs.length}组
                    </summary>
                    <p>
                      顺序由作者明确调整，不按名称或年号猜测。删除前先解除地图关联。
                    </p>
                    <button
                      type="button"
                      disabled={editor.input.epochs.length >= 128}
                      onClick={() =>
                        change({
                          ...editor.input,
                          epochs: [
                            ...editor.input.epochs,
                            {
                              id: crypto.randomUUID(),
                              title: "新年代组",
                              notes: "",
                            },
                          ],
                        })
                      }
                    >
                      新建年代组
                    </button>
                    {editor.input.epochs.map((epoch, index) => {
                      const linked = editor.input.entries.filter(
                        (entry) => entry.epochId === epoch.id,
                      ).length;
                      return (
                        <section
                          key={epoch.id}
                          className="atlas-epoch"
                          aria-label={`年代组 ${index + 1}`}
                        >
                          <label>
                            年代组名称
                            <input
                              aria-label={`年代组名称 ${index + 1}`}
                              maxLength={200}
                              value={epoch.title}
                              onChange={(event) =>
                                epochChange({
                                  ...epoch,
                                  title: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            年代组说明
                            <textarea
                              aria-label={`年代组说明 ${index + 1}`}
                              maxLength={4000}
                              value={epoch.notes}
                              onChange={(event) =>
                                epochChange({
                                  ...epoch,
                                  notes: event.target.value,
                                })
                              }
                            />
                          </label>
                          <p>{linked}张地图关联</p>
                          <div className="map-inline-actions">
                            <button
                              type="button"
                              disabled={!index}
                              onClick={() => epochMove(index, -1)}
                            >
                              上移年代组 {index + 1}
                            </button>
                            <button
                              type="button"
                              disabled={
                                index === editor.input.epochs.length - 1
                              }
                              onClick={() => epochMove(index, 1)}
                            >
                              下移年代组 {index + 1}
                            </button>
                            <button
                              type="button"
                              disabled={!!linked}
                              onClick={() =>
                                change({
                                  ...editor.input,
                                  epochs: editor.input.epochs.filter(
                                    (item) => item.id !== epoch.id,
                                  ),
                                })
                              }
                            >
                              删除年代组 {index + 1}
                            </button>
                          </div>
                        </section>
                      );
                    })}
                  </details>
                </fieldset>
                <MapPicker
                  bookId={book.id}
                  label="选择目录地图"
                  disabled={!writable || editor.composing}
                  onSelect={select}
                />
                {editor.selected && (
                  <section className="atlas-map-form">
                    <h3>
                      {selectedMap?.title ||
                        `地图编号 ${editor.selected.slice(0, 8)}`}
                    </h3>
                    {selectedError && <p role="alert">{selectedError}</p>}
                    {selectedMap?.deletedAt && (
                      <p role="alert">
                        地图已回收，可保留目录说明或解除旧关联；新关联须使用有效地图。
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={
                        editor.busy || !selectedMap || !!selectedMap.deletedAt
                      }
                      onClick={() => navigate(editor.selected!)}
                    >
                      打开当前所选地图
                    </button>
                    {selectedEntry ? (
                      <fieldset disabled={!writable}>
                        <label>
                          目录位置说明
                          <textarea
                            aria-label="目录位置说明"
                            maxLength={4000}
                            value={selectedEntry.notes}
                            onChange={(event) =>
                              updateEntry({
                                ...selectedEntry,
                                notes: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          所属年代组
                          <select
                            aria-label="目录地图年代组"
                            value={selectedEntry.epochId || ""}
                            onChange={(event) =>
                              updateEntry({
                                ...selectedEntry,
                                epochId: event.target.value || null,
                              })
                            }
                          >
                            <option value="">未分组</option>
                            {editor.input.epochs.map((epoch) => (
                              <option key={epoch.id} value={epoch.id}>
                                {epoch.title || "未命名年代组"}
                              </option>
                            ))}
                            {selectedEntry.epochId &&
                              !editor.input.epochs.some(
                                (epoch) => epoch.id === selectedEntry.epochId,
                              ) && (
                                <option value={selectedEntry.epochId}>
                                  失联年代组 · 请明确重新指定
                                </option>
                              )}
                          </select>
                        </label>
                        <p>父图：{label(selectedEntry.parentId)}</p>
                        {selectedEntry.epochId &&
                          parentEntry?.epochId &&
                          selectedEntry.epochId !== parentEntry.epochId && (
                            <p className="map-warning">
                              父图与当前地图属于不同年代组，请核对关联；程序不会自动同步历史状态。
                            </p>
                          )}
                        {parentError && (
                          <p role="alert">{parentError}；旧关系保留。</p>
                        )}
                        {parentMap?.deletedAt && (
                          <p role="alert">父图已回收，旧关系保留。</p>
                        )}
                        <MapPicker
                          bookId={book.id}
                          label="选择父图"
                          excluded={editor.selected}
                          disabled={!writable || editor.composing}
                          onSelect={chooseParent}
                        />
                        {selectedEntry.parentId && (
                          <>
                            <label>
                              父图锚点
                              <select
                                aria-label="父图锚点"
                                value={selectedEntry.anchorId || ""}
                                onChange={(event) =>
                                  updateEntry({
                                    ...selectedEntry,
                                    anchorId: event.target.value || null,
                                  })
                                }
                              >
                                <option value="">请选择父图的地点或区域</option>
                                {anchors.map((anchor) => (
                                  <option value={anchor.id} key={anchor.id}>
                                    {anchor.kind === "place" ? "地点" : "区域"}{" "}
                                    · {anchor.title}
                                  </option>
                                ))}
                                {selectedEntry.anchorId &&
                                  !anchors.some(
                                    (anchor) =>
                                      anchor.id === selectedEntry.anchorId,
                                  ) && (
                                    <option value={selectedEntry.anchorId}>
                                      原锚点已失联 · 请明确重新指定
                                    </option>
                                  )}
                              </select>
                            </label>
                            <div className="map-inline-actions">
                              <button
                                type="button"
                                disabled={!parentMap || !!parentMap.deletedAt}
                                onClick={() =>
                                  navigate(selectedEntry.parentId!)
                                }
                              >
                                打开父图
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  updateEntry({
                                    ...selectedEntry,
                                    parentId: null,
                                    anchorId: null,
                                  })
                                }
                              >
                                解除父图关系
                              </button>
                            </div>
                          </>
                        )}
                        <button
                          type="button"
                          disabled={editor.input.entries.some(
                            (entry) => entry.parentId === selectedEntry.mapId,
                          )}
                          onClick={() =>
                            change({
                              ...editor.input,
                              entries: editor.input.entries.filter(
                                (entry) => entry.mapId !== selectedEntry.mapId,
                              ),
                            })
                          }
                        >
                          从目录移除此地图
                        </button>
                        <p>
                          移除只解除目录位置，不回收地图；有子图时请先调整它们的父图关系。
                        </p>
                      </fieldset>
                    ) : (
                      <>
                        <p>这张地图尚未加入地图册。</p>
                        <button
                          type="button"
                          disabled={
                            !writable || !selectedMap || !!selectedMap.deletedAt
                          }
                          onClick={() =>
                            change({
                              ...editor.input,
                              entries: [
                                ...editor.input.entries,
                                newEntry(editor.selected!),
                              ],
                            })
                          }
                        >
                          加入地图册
                        </button>
                      </>
                    )}
                  </section>
                )}
                <div className="asset-actions">
                  <button
                    type="button"
                    disabled={editor.busy}
                    onClick={compare}
                  >
                    读取磁盘目录供对照
                  </button>
                  <button
                    type="button"
                    disabled={editor.busy || editor.composing}
                    onClick={discard}
                  >
                    放弃本机地图册草稿并重读
                  </button>
                </div>
                {comparison && (
                  <details open className="atlas-comparison">
                    <summary>
                      磁盘地图册供对照 ·{" "}
                      {comparison.record
                        ? `第${comparison.record.revision}版`
                        : "当前不存在"}
                    </summary>
                    <p>
                      采用基线会保留当前全部文字、分组和关系调整；未自动合并磁盘新增内容，请先核对，再明确保存。
                    </p>
                    <p>{comparison.record?.notes || "无目录说明"}</p>
                    <ol>
                      {comparison.record?.epochs.map((epoch) => (
                        <li key={epoch.id}>
                          {epoch.title} · {epoch.notes}
                        </li>
                      ))}
                    </ol>
                    <ul>
                      {comparison.record?.entries.map((entry) => (
                        <li key={entry.mapId}>
                          {label(entry.mapId)}；父图：{label(entry.parentId)}
                          ；锚点：{entry.anchorId?.slice(0, 8) || "无"}
                          ；年代组：
                          {comparison.record?.epochs.find(
                            (epoch) => epoch.id === entry.epochId,
                          )?.title || "未分组"}
                          ；{entry.notes}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={
                        editor.busy ||
                        editor.blocked === "unknown" ||
                        editor.cleanup
                      }
                      onClick={() => {
                        patch({
                          record: comparison.record,
                          expected: reference(comparison.record),
                          dirty: true,
                        });
                        setComparison(null);
                        setHistorical(null);
                        setError("");
                        setNotice(
                          "已明确采用磁盘基线并保留当前目录调整，尚未保存。",
                        );
                      }}
                    >
                      保留调整并采用磁盘目录基线
                    </button>
                  </details>
                )}
              </>
            )}
            <details className="atlas-history">
              <summary>地图册历史 · 最近40版</summary>
              <p>查看不改当前输入；采用历史仅改变目录关系，不回退地图图形。</p>
              {historyErrors.map((text, index) => (
                <p role="alert" key={index}>
                  {text}
                </p>
              ))}
              {history.map((record) => (
                <button
                  type="button"
                  key={record.diskHash}
                  disabled={
                    editor.busy ||
                    editor.dirty ||
                    editor.cleanup ||
                    !!editor.blocked ||
                    editor.composing
                  }
                  onClick={() => {
                    setHistorical(record);
                    setEpochFilter("all");
                    setScope("all");
                    setOffset(0);
                  }}
                >
                  查看地图册第{record.revision}版 · {record.epochs.length}年代组
                  / {record.entries.length}地图
                </button>
              ))}
              {!history.length && !historyErrors.length && (
                <p>暂无已保存历史。</p>
              )}
            </details>
          </main>
        </div>
      </section>
    </div>
  );
}
