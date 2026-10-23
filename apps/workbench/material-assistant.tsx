import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { Material } from "./materials-panel";
import { ContextSelector, type ContextSelection } from "./context-selector";
import { materialKind } from "../../packages/novel-domain/materials.mjs";
import { materialProposal } from "../../packages/novel-domain/material-proposal.mjs";
import { reviewContent } from "../../packages/novel-domain/review-content.mjs";
import type { StoredTask } from "./task-history";
type Proposal = {
  title: string;
  fields: Record<string, string>;
  notes: string;
};
type MaterialTask = StoredTask & {
  snapshot: StoredTask["snapshot"] & {
    materialTarget: {
      id: string;
      bookId: string;
      revision: number;
      diskHash: string;
      input: Material;
    };
  };
};
const methods: Record<string, string> = {
  idea: "novel-ideation",
  character: "novel-character",
  location: "novel-worldbuilding",
  rule: "novel-worldbuilding",
  organization: "novel-worldbuilding",
  item: "novel-worldbuilding",
  ability: "novel-worldbuilding",
  research: "novel-research",
  outline: "novel-master-outline",
  scene: "novel-scene-outline",
  thread: "novel-plot-threads",
  foreshadow: "novel-foreshadow",
};

export function MaterialAssistant({
  bookId,
  material,
  disabled,
  updated,
}: {
  bookId: string;
  material: Material;
  disabled: boolean;
  updated: (value: Material) => void;
}) {
  const [instruction, setInstruction] = useState(""),
    [skillId, setSkill] = useState(methods[material.kind]),
    [skills, setSkills] = useState<{ id: string; name: string }[]>([]),
    [context, setContext] = useState<ContextSelection>({
      ready: true,
      ids: [],
      pack: null,
    }),
    [generating, setGenerating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [estimate, setEstimate] = useState(""),
    [tasks, setTasks] = useState<StoredTask["record"][]>([]),
    [offset, setOffset] = useState(0),
    [reload, setReload] = useState(0),
    [task, setTask] = useState<MaterialTask | null>(null),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [draftRevision, setDraftRevision] = useState(0);
  const active = useRef(true);
  useEffect(
    () => setEstimate(""),
    [material.diskHash, skillId, context.pack?.hash],
  );
  useEffect(() => {
    const reset = () => setEstimate("");
    window.addEventListener("novel-settings-changed", reset);
    return () => window.removeEventListener("novel-settings-changed", reset);
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    api<typeof skills>("skills.list")
      .then(setSkills)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let current = true;
    api<typeof tasks>("ai.materialTasks", {
      bookId,
      materialId: material.id,
      offset,
    })
      .then((value) => {
        if (current) setTasks(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [bookId, material.id, offset, reload]);
  const payload = () => ({
    bookId,
    expected: {
      id: material.id,
      revision: material.revision,
      diskHash: material.diskHash,
    },
    skillId,
    instruction,
    materialIds: context.ids,
    materialContextHash: context.pack?.hash,
  });
  async function openTask(id: string) {
    const value = await api<MaterialTask>("ai.task", { id });
    if (
      value.snapshot.materialTarget?.id !== material.id ||
      value.snapshot.materialTarget.bookId !== bookId
    )
      throw new Error("任务与当前资料不一致");
    if (!active.current) return;
    setTask(value);
    setError("");
    setMessage("");
    setDraftRevision(value.reviewDraft?.revision || 0);
    try {
      const parsed = JSON.parse(
        value.record.status === "applied" && value.record.acceptedText
          ? value.record.acceptedText
          : reviewContent(value).text,
      );
      // An explicitly saved draft may temporarily have an empty title; only acceptance requires it.
      materialProposal(
        {
          ...parsed,
          title:
            typeof parsed.title === "string" && !parsed.title.trim()
              ? "未命名草稿"
              : parsed.title,
        },
        value.snapshot.materialTarget.input,
      );
      setProposal(parsed);
    } catch {
      setProposal(null);
    }
  }
  const accepting = task?.record.status === "awaiting-review" && proposal;
  const close = () => {
    if (!busy) {
      setTask(null);
      setProposal(null);
      setError("");
      setMessage("");
    }
  };
  const fields = materialKind(material.kind).fields;
  return (
    <section className="material-assistant" aria-label="资料 AI 协作">
      <details>
        <summary>AI 完善这份资料</summary>
        <p className="muted">
          发送这份资料及明确选择的参考，生成独立候选。类型、章节关联、作者确认状态和正文证据保持；明确接受前不会改资料或正文。
        </p>
        <label>
          资料创作方法
          <select
            aria-label="资料创作方法"
            value={skillId}
            disabled={generating || disabled}
            onChange={(e) => setSkill(e.target.value)}
          >
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          资料修改要求
          <textarea
            aria-label="资料修改要求"
            maxLength={8000}
            value={instruction}
            disabled={generating || disabled}
            onChange={(e) => {
              setInstruction(e.target.value);
              setEstimate("");
            }}
          />
        </label>
        <ContextSelector
          bookId={bookId}
          disabled={generating || disabled}
          onChange={setContext}
        />
        <div className="material-actions">
          <button
            disabled={disabled || generating || busy || !context.ready}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const value = await api<{
                  inputTokens: number;
                  contextCharacters: number;
                  projectedCost: number | null;
                  currency?: string;
                }>("ai.materialEstimate", payload());
                setEstimate(
                  `作者材料约 ${value.inputTokens} Token，${value.contextCharacters} 字符；${value.projectedCost === null ? "费用未知" : `按自定义单价预估 ${value.projectedCost} ${value.currency}`}。完整请求另行校验预算。`,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            估算资料任务
          </button>
          <button
            className="primary"
            disabled={
              disabled ||
              generating ||
              busy ||
              !context.ready ||
              !instruction.trim()
            }
            onClick={async () => {
              setGenerating(true);
              setError("");
              setMessage("");
              try {
                const result = await api<{ id: string }>(
                  "ai.materialGenerate",
                  payload(),
                );
                if (active.current) {
                  await openTask(result.id);
                  setReload((n) => n + 1);
                }
              } catch (e) {
                if (active.current) setError((e as Error).message);
              } finally {
                if (active.current) {
                  setGenerating(false);
                  setReload((n) => n + 1);
                }
              }
            }}
          >
            {generating ? "正在生成资料候选…" : "生成资料候选"}
          </button>
          {generating && (
            <button
              onClick={() => api("ai.cancel").catch((e) => setError(e.message))}
            >
              取消资料生成
            </button>
          )}
        </div>
        {estimate && <p role="status">{estimate}</p>}
        {disabled && (
          <p className="muted">请先保存资料调整，或等待当前资料操作完成。</p>
        )}
      </details>
      <details>
        <summary>这份资料的 AI 任务（当前页 {tasks.length} 项）</summary>
        <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
          刷新资料任务
        </button>
        {tasks.map((item) => (
          <button
            className="material-task-row"
            disabled={busy || disabled}
            key={item.id}
            onClick={() => openTask(item.id).catch((e) => setError(e.message))}
          >
            {new Date(item.startedAt).toLocaleString("zh-CN")} ·{" "}
            {item.status === "awaiting-review"
              ? "待审阅"
              : item.status === "applied"
                ? "已接受"
                : item.status === "discarded"
                  ? "已放弃"
                  : "未完成 / 查看状态"}
          </button>
        ))}
        <div className="material-actions">
          <button
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 40))}
          >
            上一页资料任务
          </button>
          <button
            disabled={tasks.length < 40}
            onClick={() => setOffset(offset + 40)}
          >
            下一页资料任务
          </button>
        </div>
      </details>
      {!task && error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!task && message && <p role="status">{message}</p>}
      {task &&
        createPortal(
          <div
            className="modal-backdrop"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-label="审阅资料候选"
              className="modal material-review"
            >
              <div className="modal-heading">
                <h2>审阅{materialKind(material.kind).label}候选</h2>
                <button
                  aria-label="关闭资料候选"
                  disabled={busy}
                  onClick={close}
                >
                  关闭
                </button>
              </div>
              <p className="muted">
                绑定资料版本 {task.snapshot.materialTarget.revision} ·
                只修改标题、类型字段和笔记。关闭不会保存本次调整；可先保存审阅草稿。任务原候选保留。
              </p>
              {material.kind === "research" && (
                <p className="muted">
                  性质标记与核对记录保留原卡内容。如需改变，请关闭候选后在原资料中手工修改；本任务没有访问外部来源。
                </p>
              )}
              {task.record.status !== "awaiting-review" && (
                <p className="inline-error">
                  当前状态：{task.record.status}。此记录只读，不自动重试或应用。
                </p>
              )}
              {task.reviewDraftError && (
                <p role="alert">{task.reviewDraftError}</p>
              )}
              {proposal ? (
                <div className="material-review-grid">
                  <section aria-label="生成前资料">
                    <h3>生成前</h3>
                    <h4>{task.snapshot.materialTarget.input.title}</h4>
                    {fields.map((field) => (
                      <p key={field.key}>
                        <strong>{field.label}</strong>
                        <br />
                        {task.snapshot.materialTarget.input.fields[field.key] ||
                          "（未填写）"}
                      </p>
                    ))}
                    <p>{task.snapshot.materialTarget.input.notes}</p>
                  </section>
                  <fieldset
                    disabled={busy || !accepting}
                    aria-label="可编辑的资料候选"
                  >
                    <legend>候选 / 作者调整</legend>
                    <label>
                      候选标题
                      <input
                        aria-label="候选标题"
                        maxLength={200}
                        value={proposal.title}
                        onChange={(e) =>
                          setProposal({ ...proposal, title: e.target.value })
                        }
                      />
                    </label>
                    {fields.map((field) => (
                      <label key={field.key}>
                        {field.label}
                        {field.options ? (
                          <select
                            aria-label={`候选${field.label}`}
                            disabled={
                              material.kind === "research" &&
                              field.key === "boundary"
                            }
                            value={proposal.fields[field.key] || ""}
                            onChange={(e) =>
                              setProposal({
                                ...proposal,
                                fields: {
                                  ...proposal.fields,
                                  [field.key]: e.target.value,
                                },
                              })
                            }
                          >
                            <option value="">未指定</option>
                            {field.options.map((option) => (
                              <option key={option}>{option}</option>
                            ))}
                          </select>
                        ) : (
                          <textarea
                            aria-label={`候选${field.label}`}
                            readOnly={
                              material.kind === "research" &&
                              field.key === "checkedAt"
                            }
                            maxLength={10000}
                            rows={3}
                            value={proposal.fields[field.key] || ""}
                            onChange={(e) =>
                              setProposal({
                                ...proposal,
                                fields: {
                                  ...proposal.fields,
                                  [field.key]: e.target.value,
                                },
                              })
                            }
                          />
                        )}
                      </label>
                    ))}
                    <label>
                      候选笔记
                      <textarea
                        aria-label="候选笔记"
                        maxLength={120000}
                        rows={5}
                        value={proposal.notes}
                        onChange={(e) =>
                          setProposal({ ...proposal, notes: e.target.value })
                        }
                      />
                    </label>
                  </fieldset>
                </div>
              ) : (
                <label>
                  部分结果 / 无有效结构
                  <textarea
                    readOnly
                    value={task.record.candidate || "尚无候选"}
                  />
                </label>
              )}
              {task.snapshot.materialContext && (
                <details>
                  <summary>当时的参考资料</summary>
                  <pre className="context-prose">
                    {task.snapshot.materialContext.materials
                      .map((item) => item.content)
                      .join("\n\n")}
                  </pre>
                </details>
              )}
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              {message && <p role="status">{message}</p>}
              <div className="modal-actions">
                {[
                  "awaiting-review",
                  "failed",
                  "cancelled",
                  "interrupted",
                ].includes(task.record.status) && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api("ai.discard", { id: task.record.id });
                        setTask(null);
                        setProposal(null);
                        setReload((n) => n + 1);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    放弃资料候选
                  </button>
                )}
                {["accepting", "acceptance-uncertain"].includes(
                  task.record.status,
                ) && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api("ai.reconcile", { id: task.record.id });
                        await openTask(task.record.id);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    核对资料接受状态
                  </button>
                )}
                <button
                  disabled={busy || !accepting}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const draft = await api<{ revision: number }>(
                        "ai.saveReview",
                        {
                          id: task.record.id,
                          text: JSON.stringify(proposal),
                          expectedRevision: draftRevision,
                        },
                      );
                      setDraftRevision(draft.revision);
                      setMessage(`已保存资料审阅草稿 · 版本 ${draft.revision}`);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  保存资料审阅草稿
                </button>
                <button
                  className="primary"
                  disabled={busy || !accepting}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const result = await api<{
                        material: Material;
                        receiptPending: boolean;
                      }>("ai.materialAccept", { id: task.record.id, proposal });
                      updated(result.material);
                      setMessage(
                        result.receiptPending
                          ? "资料已保存，任务回执尚待核对；可打开任务检查状态。"
                          : "资料修改已接受，原始候选和旧版本均保留。",
                      );
                      setTask(null);
                      setProposal(null);
                      setReload((n) => n + 1);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  接受资料修改
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </section>
  );
}
