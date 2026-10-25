import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import type { Material } from "./materials-panel";
import type {
  AssetRecord,
  AssetExpected,
} from "../../packages/novel-domain/assets.mjs";
import { assetId } from "../../packages/novel-domain/assets.mjs";
import {
  characterLookFields,
  characterLookInput,
  characterLookExpected,
  type CharacterLookInput,
  type CharacterLookView,
  type CharacterLookEntry,
  type CharacterLookExpected,
} from "../../packages/novel-domain/character-looks.mjs";
import { registerEditorCloseGuard } from "./editor-close-guards";

type Draft = {
  schemaVersion: 1;
  bookId: string;
  character: AssetExpected;
  expected: CharacterLookExpected | null;
  entryId: string;
  input: CharacterLookInput;
  asset: AssetExpected | null;
};
const ref = (r: AssetExpected): AssetExpected => ({
  id: r.id,
  revision: r.revision,
  diskHash: r.diskHash,
});
const baseline = (s: CharacterLookView): CharacterLookExpected | null =>
  s.record
    ? { revision: s.record.revision, diskHash: s.record.diskHash }
    : null;
const empty = (): CharacterLookInput =>
  Object.fromEntries(
    characterLookFields.map(([key]) => [key, ""]),
  ) as CharacterLookInput;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
function readDraft(raw: string, bookId: string, characterId: string): Draft {
  if (raw.length > 192 * 1024) throw new Error("本机形象草稿过大，已保留");
  const d = JSON.parse(raw);
  if (
    !d ||
    d.schemaVersion !== 1 ||
    d.bookId !== bookId ||
    Object.keys(d).sort().join(",") !==
      "asset,bookId,character,entryId,expected,input,schemaVersion"
  )
    throw new Error("本机形象草稿格式不支持，已保留");
  const character = characterLookExpected(d.character, true);
  if (character.id !== characterId)
    throw new Error("本机形象草稿人物不符，已保留");
  return {
    ...d,
    character,
    entryId: assetId(d.entryId),
    expected: d.expected === null ? null : characterLookExpected(d.expected),
    asset: d.asset === null ? null : characterLookExpected(d.asset, true),
    input: characterLookInput(d.input, { draft: true }),
  };
}
export function CharacterLooks({
  book,
  material,
  disabled,
  refreshMaterial,
}: {
  book: Book;
  material: Material;
  disabled: boolean;
  refreshMaterial: () => void;
}) {
  const [state, setState] = useState<CharacterLookView | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [blockedDraft, setBlockedDraft] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [lookQuery, setLookQuery] = useState(""),
    [showDeleted, setShowDeleted] = useState(false),
    [lookOffset, setLookOffset] = useState(0);
  const [assets, setAssets] = useState<AssetRecord[]>([]),
    [assetRefresh, setAssetRefresh] = useState(0),
    [assetOffset, setAssetOffset] = useState(0),
    [assetTotal, setAssetTotal] = useState(0),
    [assetQuery, setAssetQuery] = useState("");
  const [preview, setPreview] = useState<{
      id: string;
      revision: number;
      selected: boolean;
      url: string;
    } | null>(null),
    [ack, setAck] = useState(false),
    [rebaseAck, setRebaseAck] = useState(false);
  const alive = useRef(true),
    guard = useRef({ busy: false, saved: true });
  guard.current.busy = busy;
  const key = `zinovel.character-look-draft.${book.id}.${material.id}`;
  const parentCurrent =
    !!state &&
    JSON.stringify(state.character) === JSON.stringify(ref(material));
  const locked = busy || disabled || !parentCurrent || !!book.archivedAt;
  const stale =
    !!draft &&
    !!state &&
    (JSON.stringify(draft.character) !== JSON.stringify(state.character) ||
      JSON.stringify(draft.expected) !== JSON.stringify(baseline(state)));
  async function reload() {
    const next = await api<CharacterLookView>("looks.read", {
      bookId: book.id,
      characterId: material.id,
    });
    if (alive.current) {
      setState(next);
      setAssetRefresh((n) => n + 1);
      setPreview(null);
      setAck(false);
      setRebaseAck(false);
    }
    return next;
  }
  useEffect(() => {
    alive.current = true;
    void reload().catch((e) => {
      if (alive.current) setError(errorText(e));
    });
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        setDraft(readDraft(raw, book.id, material.id));
        setNotice("已找回本机形象草稿，保存仍检查原版本。");
      }
    } catch (e) {
      setBlockedDraft(true);
      setError(errorText(e));
    }
    const unregister = registerEditorCloseGuard(
      () => !guard.current.busy && guard.current.saved,
    );
    return () => {
      alive.current = false;
      unregister();
    };
  }, [key]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api<{ items: AssetRecord[]; total: number; errors: string[] }>(
        "assets.list",
        {
          bookId: book.id,
          options: {
            purpose: "portrait",
            query: assetQuery,
            offset: assetOffset,
          },
        },
      )
        .then((r) => {
          if (active) {
            setAssets(r.items.filter((a) => a.linkedIds.includes(material.id)));
            setAssetTotal(r.total);
            if (r.errors.length) setError(r.errors.join("；"));
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [book.id, material.id, assetOffset, assetQuery, assetRefresh]);
  function persist(next: Draft) {
    setDraft(next);
    setAck(false);
    setRebaseAck(false);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      guard.current.saved = true;
    } catch {
      guard.current.saved = false;
      setError("形象草稿暂存失败，请保持窗口打开并保存，或明确丢弃草稿。");
    }
  }
  function clearDraft() {
    try {
      localStorage.removeItem(key);
      setDraft(null);
      setBlockedDraft(false);
      guard.current.saved = true;
      setRebaseAck(false);
    } catch {
      setError("本机草稿无法清除，原件已保留");
    }
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    setAck(false);
    try {
      await operation();
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function edit(entry?: CharacterLookEntry) {
    if (!state || locked || blockedDraft || draft) return;
    setPreview(null);
    persist({
      schemaVersion: 1,
      bookId: book.id,
      character: state.character,
      expected: baseline(state),
      entryId: entry?.id ?? crypto.randomUUID(),
      input: entry ? { ...entry.input } : empty(),
      asset: null,
    });
  }
  async function save(rebase = false) {
    if (!draft || !state || (rebase && !rebaseAck)) return;
    const submitted = {
      ...draft,
      ...(rebase
        ? { character: state.character, expected: baseline(state) }
        : {}),
      input: characterLookInput(draft.input),
    };
    const oldRaw = localStorage.getItem(key);
    const value = await api<CharacterLookView>("looks.save", {
      bookId: book.id,
      character: submitted.character,
      expected: submitted.expected,
      entryId: submitted.entryId,
      input: submitted.input,
      asset: submitted.asset,
    });
    if (localStorage.getItem(key) === oldRaw) localStorage.removeItem(key);
    if (alive.current) {
      setState(value);
      setDraft(null);
      guard.current.saved = true;
      setPreview(null);
      setNotice("形象版本已保存；当前定妆未自动改变。");
    }
  }
  async function show(entryId: string, selected: boolean) {
    if (!state?.record) return;
    const value = await api<{ id: string; revision: number; dataUrl: string }>(
      "looks.preview",
      {
        bookId: book.id,
        characterId: material.id,
        expected: baseline(state),
        entryId,
        selected,
      },
    );
    if (alive.current)
      setPreview({
        id: value.id,
        revision: value.revision,
        selected,
        url: value.dataUrl,
      });
  }
  async function choose(entryId: string | null) {
    if (!state?.record || !ack) return;
    if (entryId && (!preview || preview.selected || preview.id !== entryId))
      return;
    const value = await api<CharacterLookView>("looks.choose", {
      bookId: book.id,
      character: state.character,
      expected: baseline(state),
      entryId,
      confirmation: "confirm-portrait-choice-v1",
    });
    if (alive.current) {
      setState(value);
      setPreview(null);
      setNotice(
        entryId
          ? "已明确选定此固定版本；未更改封面、正文或出版副本。"
          : "已取消当前定妆；形象版本与原图保留。",
      );
    }
  }
  const selected = state?.selectedEntry,
    entries = state?.record?.entries ?? [];
  const visibleEntries = entries.filter(
    (entry) =>
      !!entry.deletedAt === showDeleted &&
      Object.values(entry.input)
        .join("\n")
        .toLocaleLowerCase()
        .includes(lookQuery.toLocaleLowerCase()),
  );
  const pageOffset = Math.min(
    lookOffset,
    Math.max(0, Math.floor((visibleEntries.length - 1) / 20) * 20),
  );
  return (
    <details className="character-looks">
      <summary>形象版本与当前定妆</summary>
      <section aria-label="人物形象版本">
        <p>
          按年龄、衣装与剧情时期保存形象。保存或生成不会自动选为定妆；已选图固定当时版本。参考图生成尚未接入。
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {(!parentCurrent || disabled) && (
          <p>
            请先保存人物资料；若人物版本已变化，请重新打开人物卡后核对。
            <button disabled={busy || disabled} onClick={refreshMaterial}>
              重新打开人物资料
            </button>
          </p>
        )}
        <div className="material-actions">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await reload();
              })
            }
          >
            重新读取形象（保留草稿）
          </button>
          <button
            disabled={locked || !!draft || blockedDraft}
            onClick={() => edit()}
          >
            新建形象版本
          </button>
        </div>
        {state?.selectedError && (
          <p role="alert">
            当前定妆来源无法读取：{state.selectedError}
            。保留原件，可明确取消选择后修复。
          </p>
        )}
        {state?.characterChanged && (
          <p role="status">
            人物资料在选图后已变化，仍保留原定妆；请重新核对后明确选定。
          </p>
        )}
        <article aria-label="当前定妆">
          <h4>当前定妆</h4>
          {selected ? (
            <>
              <p>
                {selected.input.title} · 固定形象修订 {selected.revision} ·{" "}
                {selected.input.age} · {selected.input.outfit} ·{" "}
                {selected.input.period}
              </p>
              <button
                disabled={busy}
                onClick={() => void run(() => show(selected.id, true))}
              >
                预览当前定妆
              </button>
            </>
          ) : (
            <p>
              {!state
                ? "尚未读取，不能判断是否已选定"
                : state.record?.selected
                  ? "已记录选择，来源待修复"
                  : "尚未选定"}
            </p>
          )}
        </article>
        {preview && (
          <figure className="look-preview">
            <img
              src={preview.url}
              alt={`${preview.selected ? "当前定妆" : "形象候选"}固定版本预览`}
            />
            <figcaption>
              {preview.selected ? "当前定妆的固定历史版本" : "此形象已保存版本"}{" "}
              · 修订 {preview.revision}
            </figcaption>
          </figure>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={ack}
            disabled={locked || !!draft}
            onChange={(e) => setAck(e.target.checked)}
          />
          我已核对人物与固定版本，确认本次定妆选择
        </label>
        {state?.record?.selected && (
          <button
            disabled={locked || !!draft || !ack}
            onClick={() => void run(() => choose(null))}
          >
            明确取消当前定妆
          </button>
        )}
        <label>
          按名称、年龄、衣装或剧情时期筛选
          <input
            aria-label="筛选人物形象"
            value={lookQuery}
            maxLength={200}
            onChange={(e) => {
              setLookQuery(e.target.value);
              setLookOffset(0);
            }}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => {
              setShowDeleted(e.target.checked);
              setLookOffset(0);
            }}
          />
          查看形象回收站
        </label>
        <p>
          {visibleEntries.length} 个匹配形象 · 第{" "}
          {Math.floor(pageOffset / 20) + 1} 页
        </p>
        <div className="look-entries">
          {visibleEntries.slice(pageOffset, pageOffset + 20).map((entry) => (
            <article key={entry.id}>
              <h4>
                {entry.input.title} · 修订 {entry.revision}
                {entry.deletedAt ? " · 已回收" : ""}
              </h4>
              <p>
                {entry.input.age} · {entry.input.outfit} ·{" "}
                {entry.input.expression} · {entry.input.view} ·{" "}
                {entry.input.period}
              </p>
              <details>
                <summary>已保存说明与来源</summary>
                {characterLookFields.map(([key, label]) => (
                  <p key={key}>
                    {label}：{entry.input[key]}
                  </p>
                ))}
                <p>
                  固定资源：{entry.asset.record.title} · 版本
                  {entry.asset.record.revision} ·{" "}
                  {entry.asset.record.blob.sha256}
                </p>
                <p>
                  来源：{entry.asset.record.source}；权利：
                  {entry.asset.record.rights}
                </p>
              </details>
              <div className="material-actions">
                <button
                  disabled={busy || !!draft}
                  onClick={() => void run(() => show(entry.id, false))}
                >
                  预览此形象
                </button>
                <button
                  disabled={
                    locked || !!draft || !!entry.deletedAt || blockedDraft
                  }
                  onClick={() => edit(entry)}
                >
                  编辑形象版本
                </button>
                <button
                  disabled={
                    locked ||
                    !!draft ||
                    !!entry.deletedAt ||
                    !ack ||
                    !preview ||
                    preview.selected ||
                    preview.id !== entry.id
                  }
                  onClick={() => void run(() => choose(entry.id))}
                >
                  明确选此版本为当前定妆
                </button>
                <button
                  disabled={
                    locked ||
                    !!draft ||
                    state?.record?.selected?.entryId === entry.id
                  }
                  onClick={() =>
                    void run(async () => {
                      const next = await api<CharacterLookView>(
                        "looks.delete",
                        {
                          bookId: book.id,
                          characterId: material.id,
                          expected: baseline(state!),
                          entryId: entry.id,
                          deleted: !entry.deletedAt,
                        },
                      );
                      if (alive.current) {
                        setState(next);
                        setPreview(null);
                      }
                    })
                  }
                >
                  {entry.deletedAt ? "恢复形象" : "回收形象"}
                </button>
              </div>
            </article>
          ))}
        </div>
        {state && !visibleEntries.length && (
          <p>此筛选下暂无形象；当前定妆仍单独保留在上方。</p>
        )}
        <div className="material-actions">
          <button
            disabled={!pageOffset}
            onClick={() => setLookOffset(Math.max(0, pageOffset - 20))}
          >
            上一页形象
          </button>
          <button
            disabled={pageOffset + 20 >= visibleEntries.length}
            onClick={() => setLookOffset(pageOffset + 20)}
          >
            下一页形象
          </button>
        </div>
        {(draft || blockedDraft) && (
          <article aria-label="形象编辑草稿">
            <h4>形象编辑草稿</h4>
            <p>
              本机暂存；正式保存后才进入作品备份。丢弃草稿不修改已保存形象。
            </p>
            <button disabled={busy} onClick={clearDraft}>
              丢弃本机形象草稿
            </button>
            {draft && (
              <>
                <fieldset disabled={locked || blockedDraft}>
                  {characterLookFields.map(([key, label, max]) => (
                    <label key={key}>
                      {label}
                      <textarea
                        aria-label={label}
                        value={draft.input[key]}
                        maxLength={max}
                        rows={key === "notes" || key === "constraints" ? 3 : 2}
                        onChange={(e) =>
                          persist({
                            ...draft,
                            input: { ...draft.input, [key]: e.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    筛选定妆资源
                    <input
                      aria-label="筛选定妆资源"
                      value={assetQuery}
                      maxLength={200}
                      onChange={(e) => {
                        setAssetQuery(e.target.value);
                        setAssetOffset(0);
                      }}
                    />
                  </label>
                  <label>
                    此版本使用的固定图像
                    <select
                      aria-label="此版本使用的固定图像"
                      value={draft.asset?.id ?? ""}
                      onChange={(e) => {
                        const a = assets.find((a) => a.id === e.target.value);
                        persist({ ...draft, asset: a ? ref(a) : null });
                      }}
                    >
                      <option value="">
                        {entries.some((e) => e.id === draft.entryId)
                          ? "保留此形象原固定图像"
                          : "请选择关联此人物的定妆资源"}
                      </option>
                      {draft.asset &&
                        !assets.some((a) => a.id === draft.asset!.id) && (
                          <option value={draft.asset.id}>
                            草稿固定资源 · {draft.asset.id}
                          </option>
                        )}
                      {assets.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.title} · 资源版本{a.revision}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    仅列出本批与此人物关联的定妆资源。请在图像资源中导入/关联，或先采用AI候选，再重新读取本面板。
                  </p>
                  <div className="material-actions">
                    <button
                      disabled={!assetOffset}
                      onClick={() => setAssetOffset((n) => Math.max(0, n - 40))}
                    >
                      上一批定妆资源
                    </button>
                    <button
                      disabled={assetOffset + 40 >= assetTotal}
                      onClick={() => setAssetOffset((n) => n + 40)}
                    >
                      下一批定妆资源
                    </button>
                  </div>
                  {stale ? (
                    <>
                      <p role="status">
                        草稿基线已过期，原稿保留。请对照上方已保存说明与当前人物；确认后才以当前版本保存。
                      </p>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={rebaseAck}
                          onChange={(e) => setRebaseAck(e.target.checked)}
                        />
                        我已对照当前人物及形象，保留以下草稿内容
                      </label>
                      <button
                        disabled={!rebaseAck}
                        onClick={() => void run(() => save(true))}
                      >
                        确认以当前版本保存此草稿
                      </button>
                    </>
                  ) : (
                    <button onClick={() => void run(() => save())}>
                      保存形象版本（不自动选定）
                    </button>
                  )}
                </fieldset>
              </>
            )}
          </article>
        )}
      </section>
    </details>
  );
}
