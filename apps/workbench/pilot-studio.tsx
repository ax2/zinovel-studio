import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ManuscriptEditor, type ManuscriptHandle } from "./manuscript-editor";
import {
  pilotFields,
  pilotInput,
} from "../../packages/novel-domain/pilots.mjs";
import { materialKinds } from "../../packages/novel-domain/materials.mjs";
import { registerEditorCloseGuard } from "./editor-close-guards";
import { PilotAssistant } from "./pilot-assistant";
type Input = {
  title: string;
  body: string;
  pov: string;
  voice: string;
  action: string;
  obstacle: string;
  promise: string;
};
export type Pilot = Input & {
  id: string;
  groupId: string;
  revision: number;
  diskHash: string;
  bodyHash: string;
  deletedAt?: string;
  externalChange?: boolean;
  parent?: { id: string; revision: number };
};
type Frozen = { id: string; revision: number; data: Pilot; body: string };
type Group = {
  id: string;
  title: string;
  scene: string;
  revision: number;
  diskHash: string;
  sources: {
    id: string;
    revision: number;
    freshness: string;
    data: { title: string; fields: Record<string, string>; notes: string };
  }[];
  selection: { snapshot: Frozen; reason: string } | null;
  selectionState: string;
};
type Feedback = {
  id: string;
  at: string;
  source: string;
  comment: string;
  snapshot: Frozen;
};
const clean = (value: Input) =>
  ({
    title: value.title,
    body: value.body,
    ...Object.fromEntries(
      pilotFields.map(([key]) => [key, value[key as keyof Input]]),
    ),
  }) as Input;
const blank = (title: string): Input => ({
  title,
  body: "",
  pov: "",
  voice: "",
  action: "",
  obstacle: "",
  promise: "",
});
const states: Record<string, string> = {
  current: "版本一致",
  stale: "版本已变化，需重新核对",
  deleted: "已删除",
  missing: "无法读取",
  none: "尚未选定",
};
export function PilotStudio({
  bookId,
  onClose,
  onChapter,
}: {
  bookId: string;
  onClose: () => void;
  onChapter: (id: string) => Promise<void>;
}) {
  const [groups, setGroups] = useState<Group[]>([]),
    [group, setGroup] = useState<Group | null>(null),
    [items, setItems] = useState<Pilot[]>([]),
    [current, setCurrent] = useState<Pilot | null>(null),
    [input, setInput] = useState<Input | null>(null),
    [comparison, setComparison] = useState<Pilot | null>(null),
    [disk, setDisk] = useState<Pilot | null>(null),
    [history, setHistory] = useState<Frozen[]>([]),
    [feedback, setFeedback] = useState<Feedback[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [listErrors, setListErrors] = useState(0),
    [creating, setCreating] = useState(false),
    [reason, setReason] = useState(""),
    [feedbackSource, setFeedbackSource] = useState(""),
    [feedbackText, setFeedbackText] = useState(""),
    [chapterTitle, setChapterTitle] = useState(""),
    [composing, setComposing] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const locked = useRef(false),
    mounted = useRef(true),
    editor = useRef<ManuscriptHandle>(null),
    inputRef = useRef(input),
    currentRef = useRef(current);
  inputRef.current = input;
  currentRef.current = current;
  const key = (id: string) => `zinovel.pilot-draft.${bookId}.${id}`;
  const navKey = `zinovel.pilot-nav.${bookId}`;
  const dirty =
    !!current &&
    !!input &&
    JSON.stringify(clean(current)) !== JSON.stringify(clean(input));
  function stash(next: Input, base = currentRef.current) {
    if (!base) return;
    try {
      if (JSON.stringify(clean(next)) === JSON.stringify(clean(base))) {
        localStorage.removeItem(key(base.id));
        setDraftFailed(false);
        return;
      }
      localStorage.setItem(
        key(base.id),
        JSON.stringify({ input: next, expected: base }),
      );
      setDraftFailed(false);
    } catch {
      setDraftFailed(true);
      setError("本机草稿空间不足，调整尚在窗口中。请保存试写后再关闭。");
    }
  }
  useEffect(
    () =>
      registerEditorCloseGuard(() => {
        if (busy || composing || draftFailed) {
          setError(
            draftFailed
              ? "草稿未能落盘，关闭已取消。请保存试写后再关闭。"
              : "试写操作尚未结束，请稍后再关闭。",
          );
          return false;
        }
        return true;
      }),
    [busy, composing, draftFailed],
  );
  function edit(next: Input) {
    inputRef.current = next;
    setInput(next);
    stash(next);
  }
  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refreshGroups() {
    const result = await api("pilots.groups", { bookId });
    if (mounted.current) {
      setGroups(result.items);
      setListErrors(result.errors.length);
    }
    return result.items as Group[];
  }
  async function refreshGroup(id: string) {
    const [next, list] = await Promise.all([
      api<Group>("pilots.group", { bookId, groupId: id }),
      api("pilots.list", { bookId, groupId: id }),
    ]);
    if (mounted.current) {
      setGroup(next);
      setItems(list.items);
      setListErrors(list.errors.length);
    }
    return { next, list: list.items as Pilot[] };
  }
  async function loadPilot(id: string, discard = false) {
    const [next, versions, responses] = await Promise.all([
      api<Pilot>("pilots.read", { bookId, id }),
      api<Frozen[]>("pilots.versions", { bookId, id }),
      api<Feedback[]>("pilots.versions", { bookId, id, feedback: true }),
    ]);
    if (!mounted.current) return;
    let fields = clean(next),
      baseline = next;
    if (discard) localStorage.removeItem(key(id));
    else {
      const raw = localStorage.getItem(key(id));
      if (raw) {
        try {
          const draft = JSON.parse(raw);
          if (
            typeof draft.input?.title !== "string" ||
            draft.input.title.length > 200
          )
            throw new Error("草稿标题无效");
          pilotInput({ ...draft.input, title: "本机草稿" });
          if (
            draft.expected?.id !== id ||
            draft.expected?.groupId !== next.groupId
          )
            throw new Error("草稿身份不匹配");
          fields = draft.input;
          baseline = { ...next, ...draft.expected };
          setMessage("已恢复本机未保存调整。保存前请核对版本。");
          if (
            baseline.diskHash !== next.diskHash ||
            baseline.bodyHash !== next.bodyHash
          )
            setError(
              "磁盘稿件在草稿之后发生变化。已保留双方，请读取磁盘对照。",
            );
        } catch {
          setError(
            "本机草稿无法解析，原草稿保留；已读取磁盘稿。请勿直接覆盖草稿。",
          );
        }
      }
    }
    setCurrent(baseline);
    currentRef.current = baseline;
    setInput(fields);
    inputRef.current = fields;
    setComparison((value) => (value?.id === id ? null : value));
    setDisk(null);
    setHistory(versions);
    setFeedback(responses);
    setChapterTitle(next.title);
    setReason("");
    setFeedbackSource("");
    setFeedbackText("");
    localStorage.setItem(navKey, JSON.stringify({ groupId: next.groupId, id }));
  }
  async function openGroup(id: string, requested?: string) {
    const { list } = await refreshGroup(id);
    setCurrent(null);
    setInput(null);
    setComparison(null);
    setDisk(null);
    setCreating(false);
    const target =
      list.find((item) => item.id === requested) ||
      list.find((item) => !item.deletedAt) ||
      list[0];
    localStorage.setItem(navKey, JSON.stringify({ groupId: id }));
    if (target) await loadPilot(target.id);
  }
  useEffect(() => {
    mounted.current = true;
    void perform(async () => {
      const values = await refreshGroups();
      let navigation: { groupId?: string; id?: string } = {};
      try {
        navigation = JSON.parse(localStorage.getItem(navKey) || "{}");
      } catch {}
      const target =
        values.find((item) => item.id === navigation.groupId) || values[0];
      if (target) await openGroup(target.id, navigation.id);
      else setCreating(true);
    });
    return () => {
      mounted.current = false;
    };
  }, [bookId]);
  async function save() {
    if (!group || !current || !input) return;
    const submitted = clean(input),
      base = current;
    const next = await api<Pilot>("pilots.save", {
      bookId,
      groupId: group.id,
      input: submitted,
      expected: base,
    });
    const latest = inputRef.current!;
    setChapterTitle((title) => (title === base.title ? next.title : title));
    setCurrent(next);
    currentRef.current = next;
    if (JSON.stringify(latest) === JSON.stringify(submitted)) {
      setInput(clean(next));
      inputRef.current = clean(next);
      localStorage.removeItem(key(next.id));
      setDraftFailed(false);
    } else stash(latest, next);
    setDisk(null);
    setHistory(await api("pilots.versions", { bookId, id: next.id }));
    await refreshGroup(group.id);
    setMessage("试写已保存，正式章节未改动。");
  }
  const savedActionsDisabled =
    busy || dirty || !!current?.deletedAt || composing || draftFailed;
  function frozenView(value: Frozen) {
    return (
      <>
        <dl>
          {pilotFields.map(([key, label]) => (
            <React.Fragment key={key}>
              <dt>{label}</dt>
              <dd>{value.data[key as keyof Input] || "未填写"}</dd>
            </React.Fragment>
          ))}
        </dl>
        <pre>{value.body}</pre>
      </>
    );
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal pilot-studio"
        role="dialog"
        aria-modal="true"
        aria-label="试写实验室"
      >
        <header>
          <div>
            <h2>试写实验室</h2>
            <p>同一场景，比较声音与人物行动。样稿独立保存，转章只新建章节。</p>
          </div>
          <button
            disabled={busy || composing || draftFailed}
            aria-label="关闭试写实验室"
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        {error && (
          <p role="alert" className="alert error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!!listErrors && (
          <p role="alert">{listErrors} 份记录无法读取，原文件保留。</p>
        )}
        <div className="pilot-toolbar">
          <label>
            实验组
            <select
              aria-label="选择试写实验组"
              value={group?.id || ""}
              disabled={busy || draftFailed}
              onChange={(e) => void perform(() => openGroup(e.target.value))}
            >
              <option value="" disabled>
                请选择
              </option>
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => setCreating(!creating)}>
            新建实验组
          </button>
          {group && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await refreshGroup(group.id);
                  setMessage("实验组与来源状态已刷新，当前本地调整保持。");
                })
              }
            >
              刷新实验状态
            </button>
          )}
        </div>
        {creating && (
          <GroupCreator
            bookId={bookId}
            disabled={busy || draftFailed}
            onCreate={(value) =>
              void perform(async () => {
                const next = await api<Group>("pilots.createGroup", {
                  bookId,
                  input: value,
                });
                localStorage.removeItem(`zinovel.pilot-group-draft.${bookId}`);
                await refreshGroups();
                await openGroup(next.id);
              })
            }
          />
        )}
        {group && (
          <>
            <section className="pilot-brief" aria-label="共同场景与来源">
              <h3>{group.title}</h3>
              <p className="preserve-lines">{group.scene}</p>
              {!!group.sources.length && (
                <details>
                  <summary>
                    来源快照与当前状态（{group.sources.length}）
                  </summary>
                  {group.sources.map((source) => (
                    <article key={source.id}>
                      <h4>
                        {source.data.title} · 版本 {source.revision} ·{" "}
                        {states[source.freshness]}
                      </h4>
                      <dl>
                        {Object.entries(source.data.fields).map(
                          ([key, text]) => (
                            <React.Fragment key={key}>
                              <dt>
                                {materialKinds
                                  .flatMap((kind) => kind.fields)
                                  .find((field) => field.key === key)?.label ||
                                  key}
                              </dt>
                              <dd>{text || "未填写"}</dd>
                            </React.Fragment>
                          ),
                        )}
                      </dl>
                      <p className="preserve-lines">{source.data.notes}</p>
                    </article>
                  ))}
                </details>
              )}
              <p role="status" aria-label="选定版本状态">
                作者选择：{states[group.selectionState]}
                {group.selection &&
                  ` · ${group.selection.snapshot.data.title} · 版本 ${group.selection.snapshot.revision}`}
              </p>
              {group.selection && (
                <details>
                  <summary>查看选定时的稿件与理由</summary>
                  <p>{group.selection.reason}</p>
                  {frozenView(group.selection.snapshot)}
                </details>
              )}
            </section>
            <div className="pilot-toolbar">
              <label>
                当前样稿
                <select
                  aria-label="选择试写样稿"
                  value={current?.id || ""}
                  disabled={busy || draftFailed}
                  onChange={(e) =>
                    void perform(() => loadPilot(e.target.value))
                  }
                >
                  <option value="" disabled>
                    请选择
                  </option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                      {item.deletedAt ? "（回收站）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || draftFailed}
                onClick={() =>
                  void perform(async () => {
                    const next = await api<Pilot>("pilots.save", {
                      bookId,
                      groupId: group.id,
                      input: blank(`试写 ${items.length + 1}`),
                    });
                    await refreshGroup(group.id);
                    await loadPilot(next.id);
                  })
                }
              >
                新建空白样稿
              </button>
              <button
                disabled={!current || savedActionsDisabled}
                onClick={() =>
                  void perform(async () => {
                    const next = await api<Pilot>("pilots.save", {
                      bookId,
                      groupId: group.id,
                      input: {
                        ...clean(current!),
                        title: `${current!.title.slice(0, 190)} · 分支`,
                      },
                      parent: current,
                    });
                    await refreshGroup(group.id);
                    await loadPilot(next.id);
                  })
                }
              >
                复制为独立分支
              </button>
              <label>
                对照样稿
                <select
                  aria-label="选择对照样稿"
                  disabled={busy}
                  value={comparison?.id || ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    void perform(async () =>
                      setComparison(
                        id
                          ? await api<Pilot>("pilots.read", { bookId, id })
                          : null,
                      ),
                    );
                  }}
                >
                  <option value="">不对照</option>
                  {items
                    .filter(
                      (item) => item.id !== current?.id && !item.deletedAt,
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {!current && (
              <p>创建第一份样稿，然后复制分支尝试另一种视角或声音。</p>
            )}
            {current && input && (
              <>
                <p role="status" aria-label="试写保存状态">
                  版本 {current.revision} ·{" "}
                  {dirty ? "有未保存调整（本机草稿）" : "已保存"}
                  {current.externalChange ? " · 磁盘正文曾被外部修改" : ""}
                </p>
                {current.parent && (
                  <p>
                    独立分支来源：版本 {current.parent.revision}（
                    {items.find((item) => item.id === current.parent!.id)
                      ?.title || "来源样稿不可读取"}
                    ），后续编辑互不联动。
                  </p>
                )}
                <div className={`pilot-panes ${comparison ? "comparing" : ""}`}>
                  <section
                    aria-label="当前试写编辑"
                    className={comparison ? "pilot-comparison" : ""}
                  >
                    {comparison && (
                      <>
                        <h3>
                          {input.title} ·{" "}
                          {dirty
                            ? "本地未保存调整"
                            : `已保存版本 ${current.revision}`}
                        </h3>
                        <p>当前样稿；将对照样稿设为“不对照”可继续编辑。</p>
                        {frozenView({
                          id: current.id,
                          revision: current.revision,
                          data: { ...current, ...input },
                          body: input.body,
                        })}
                      </>
                    )}
                    <div hidden={!!comparison}>
                      <fieldset disabled={busy || !!current.deletedAt}>
                        <label>
                          试写标题
                          <input
                            aria-label="试写标题"
                            maxLength={200}
                            value={input.title}
                            onChange={(e) =>
                              edit({ ...input, title: e.target.value })
                            }
                          />
                        </label>
                        <div className="pilot-fields">
                          {pilotFields.map(([key, label]) => (
                            <label key={key}>
                              {label}
                              <textarea
                                aria-label={`试写${label}`}
                                maxLength={10000}
                                value={input[key as keyof Input]}
                                onChange={(e) =>
                                  edit({ ...input, [key]: e.target.value })
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      {current.deletedAt ? (
                        <p>样稿在回收站，恢复后可继续编辑。</p>
                      ) : (
                        <div className="pilot-editor">
                          <ManuscriptEditor
                            key={current.id}
                            ref={editor}
                            label="试写正文编辑器"
                            readOnly={busy || !!comparison}
                            documentKey={`${bookId}.pilot.${current.id}`}
                            value={input.body}
                            onChange={(body) =>
                              edit({ ...inputRef.current!, body })
                            }
                            onSelection={() => {}}
                            onComposition={setComposing}
                          />
                        </div>
                      )}
                    </div>
                  </section>
                  {comparison && (
                    <section className="pilot-comparison" aria-label="样稿对照">
                      <h3>
                        {comparison.title} · 已保存版本 {comparison.revision}
                      </h3>
                      <p>只读快照；重新选择可读取最新版本。</p>
                      {frozenView({
                        id: comparison.id,
                        revision: comparison.revision,
                        data: comparison,
                        body: comparison.body,
                      })}
                    </section>
                  )}
                </div>
                <div className="pilot-toolbar">
                  <button
                    data-dialog-save
                    disabled={
                      busy || composing || !!current.deletedAt || !dirty
                    }
                    onClick={() => void perform(save)}
                  >
                    保存试写
                  </button>
                  <button
                    disabled={busy || !!current.deletedAt}
                    onClick={() => editor.current?.undo()}
                  >
                    撤销试写编辑
                  </button>
                  <button
                    disabled={busy || !!current.deletedAt}
                    onClick={() => editor.current?.redo()}
                  >
                    重做试写编辑
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () =>
                        setDisk(
                          await api<Pilot>("pilots.read", {
                            bookId,
                            id: current.id,
                          }),
                        ),
                      )
                    }
                  >
                    读取磁盘版本供对照
                  </button>
                  <button
                    disabled={busy || dirty}
                    onClick={() =>
                      void perform(async () => {
                        await api("pilots.delete", {
                          bookId,
                          expected: current,
                          deleted: !current.deletedAt,
                        });
                        await refreshGroup(group.id);
                        await loadPilot(current.id);
                      })
                    }
                  >
                    {current.deletedAt ? "恢复样稿" : "移入样稿回收站"}
                  </button>
                </div>
                {disk && (
                  <section className="pilot-disk" aria-label="磁盘版本对照">
                    <h3>
                      磁盘版本 {disk.revision} · {disk.title}
                    </h3>
                    {frozenView({
                      id: disk.id,
                      revision: disk.revision,
                      data: disk,
                      body: disk.body,
                    })}
                    <button
                      disabled={busy || !!disk.deletedAt}
                      onClick={() => {
                        setCurrent(disk);
                        currentRef.current = disk;
                        stash(input, disk);
                        setDisk(null);
                        setMessage(
                          "已采用磁盘版本为基线；保留本地调整，仍需明确保存。外部版本会进入历史。",
                        );
                      }}
                    >
                      保留本地调整，以此磁盘版本为基线
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(() => loadPilot(current.id, true))
                      }
                    >
                      放弃本地调整并重读
                    </button>
                  </section>
                )}
                <details>
                  <summary>历史版本（{history.length}）</summary>
                  {history.slice(0, 40).map((entry, index) => (
                    <article key={index}>
                      <h4>
                        版本 {entry.revision} · {entry.data.title}
                      </h4>
                      <button
                        disabled={busy || !!current.deletedAt}
                        onClick={() => {
                          edit(clean({ ...entry.data, body: entry.body }));
                          setMessage(
                            "历史版本已载入本地调整，保存后形成新版本。",
                          );
                        }}
                      >
                        载入此版本为本地调整
                      </button>
                    </article>
                  ))}
                  {history.length > 40 && (
                    <p>仅显示最近 40 份；全部版本仍保存在作品目录。</p>
                  )}
                </details>
                <PilotAssistant
                  key={current.id}
                  bookId={bookId}
                  pilot={current}
                  disabled={savedActionsDisabled}
                  updated={async () => {
                    localStorage.removeItem(key(current.id));
                    await refreshGroup(group.id);
                    await loadPilot(current.id);
                  }}
                />
                <fieldset
                  disabled={savedActionsDisabled}
                  className="pilot-decision"
                >
                  <legend>选择与进入正文（使用已保存稿件）</legend>
                  <label>
                    选定理由
                    <textarea
                      aria-label="选定理由"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={20000}
                    />
                  </label>
                  <button
                    disabled={savedActionsDisabled || !reason.trim()}
                    onClick={() =>
                      void perform(async () => {
                        setGroup(
                          await api("pilots.choose", {
                            bookId,
                            expectedGroup: group,
                            expected: current,
                            reason,
                          }),
                        );
                        setMessage("已保存作者选择及该版本完整快照。");
                      })
                    }
                  >
                    选定这个版本
                  </button>
                  <label>
                    新章节标题
                    <input
                      aria-label="试写转章标题"
                      value={chapterTitle}
                      onChange={(e) => setChapterTitle(e.target.value)}
                      maxLength={200}
                    />
                  </label>
                  <button
                    disabled={savedActionsDisabled || !chapterTitle.trim()}
                    onClick={() =>
                      void perform(async () => {
                        const result = await api("pilots.promote", {
                          bookId,
                          expected: current,
                          title: chapterTitle,
                        });
                        await onChapter(result.chapterId);
                        onClose();
                      })
                    }
                  >
                    建立新章节并打开
                  </button>
                  <p>
                    不覆盖已有首章；同一保存版本重复操作会打开已建立的章节。
                  </p>
                </fieldset>
                <fieldset disabled={savedActionsDisabled}>
                  <legend>添加试读反馈（绑定已保存版本）</legend>
                  <label>
                    反馈来源
                    <input
                      aria-label="反馈来源"
                      maxLength={200}
                      value={feedbackSource}
                      onChange={(e) => setFeedbackSource(e.target.value)}
                    />
                  </label>
                  <label>
                    反馈内容
                    <textarea
                      aria-label="反馈内容"
                      maxLength={40000}
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={
                      savedActionsDisabled ||
                      !feedbackSource.trim() ||
                      !feedbackText.trim()
                    }
                    onClick={() =>
                      void perform(async () => {
                        await api("pilots.feedback", {
                          bookId,
                          expected: current,
                          input: {
                            source: feedbackSource,
                            comment: feedbackText,
                          },
                        });
                        setFeedback(
                          await api("pilots.versions", {
                            bookId,
                            id: current.id,
                            feedback: true,
                          }),
                        );
                        setFeedbackText("");
                        setMessage("反馈与稿件快照已归档。");
                      })
                    }
                  >
                    归档试读反馈
                  </button>
                </fieldset>
                <section aria-label="已归档试读反馈">
                  {feedback.map((entry) => (
                    <details key={entry.id}>
                      <summary>
                        {entry.source} · 版本 {entry.snapshot.revision} ·{" "}
                        {new Date(entry.at).toLocaleString()}
                      </summary>
                      <p className="preserve-lines">{entry.comment}</p>
                      {frozenView(entry.snapshot)}
                    </details>
                  ))}
                </section>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
function GroupCreator({
  bookId,
  disabled,
  onCreate,
}: {
  bookId: string;
  disabled: boolean;
  onCreate: (input: {
    title: string;
    scene: string;
    sourceIds: string[];
  }) => void;
}) {
  const draftKey = `zinovel.pilot-group-draft.${bookId}`;
  const [input, setInput] = useState(() => {
      try {
        const value = JSON.parse(localStorage.getItem(draftKey) || "null");
        if (
          typeof value?.title === "string" &&
          typeof value?.scene === "string" &&
          Array.isArray(value.sourceIds)
        )
          return value as { title: string; scene: string; sourceIds: string[] };
      } catch {}
      return { title: "", scene: "", sourceIds: [] as string[] };
    }),
    [query, setQuery] = useState(""),
    [materials, setMaterials] = useState<{ id: string; title: string }[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api("materials.list", { bookId, options: { query } })
        .then((result) => {
          if (live) setMaterials(result.items);
        })
        .catch((e) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bookId, query]);
  function edit(value: typeof input) {
    setInput(value);
    try {
      localStorage.setItem(draftKey, JSON.stringify(value));
    } catch {
      setError("实验组草稿未能保存，请在关闭前建立实验组。");
    }
  }
  return (
    <fieldset disabled={disabled} className="pilot-create">
      <legend>建立同场景实验</legend>
      {error && <p role="alert">{error}</p>}
      <label>
        实验标题
        <input
          aria-label="实验标题"
          maxLength={200}
          value={input.title}
          onChange={(e) => edit({ ...input, title: e.target.value })}
        />
      </label>
      <label>
        共同场景任务
        <textarea
          aria-label="共同场景任务"
          maxLength={20000}
          value={input.scene}
          onChange={(e) => edit({ ...input, scene: e.target.value })}
          placeholder="固定人物要做什么、在哪里遇到什么阻碍，分支只改变尝试方向。"
        />
      </label>
      <details>
        <summary>
          关联创意、人物或场景资料（已选 {input.sourceIds.length}/8）
        </summary>
        <p>建立时冻结来源版本；后续资料变化只提示，不替换原始任务。</p>
        <input
          aria-label="搜索试写来源资料"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索资料，显示前 40 份匹配"
        />
        {!!input.sourceIds.length && (
          <button onClick={() => edit({ ...input, sourceIds: [] })}>
            清空所选来源
          </button>
        )}
        {materials.map((item) => (
          <label className="pilot-source" key={item.id}>
            <input
              type="checkbox"
              checked={input.sourceIds.includes(item.id)}
              disabled={
                disabled ||
                (!input.sourceIds.includes(item.id) &&
                  input.sourceIds.length >= 8)
              }
              onChange={(e) =>
                edit({
                  ...input,
                  sourceIds: e.target.checked
                    ? [...input.sourceIds, item.id]
                    : input.sourceIds.filter((id) => id !== item.id),
                })
              }
            />
            {item.title}
          </label>
        ))}
      </details>
      <button
        disabled={disabled || !input.title.trim() || !input.scene.trim()}
        onClick={() => onCreate(input)}
      >
        建立实验组
      </button>
    </fieldset>
  );
}
