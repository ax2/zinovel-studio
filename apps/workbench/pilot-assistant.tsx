import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useModelChoice, ModelChoiceNotice } from "./model-choice";
import type { Pilot } from "./pilot-studio";
import type { StoredTask } from "./task-history";
import { CandidateReview } from "./candidate-review";
import { reviewContent } from "../../packages/novel-domain/review-content.mjs";
import { ContextSelector, type ContextSelection } from "./context-selector";
type Target = Pick<
  Pilot,
  "id" | "groupId" | "revision" | "diskHash" | "bodyHash"
> & {
  bookId: string;
  input: Pick<
    Pilot,
    "title" | "body" | "pov" | "voice" | "action" | "obstacle" | "promise"
  >;
};
type Pack = { hash: string; context: string; target: Target };
type PilotTask = StoredTask & {
  snapshot: StoredTask["snapshot"] & { pilotTarget: Target };
};
const labels: Record<string, string> = {
  preparing: "准备中",
  running: "生成中",
  "awaiting-review": "待审阅",
  applied: "已接受",
  discarded: "已放弃",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断",
  accepting: "接受状态待核对",
  "acceptance-uncertain": "接受结果待核对",
};
export function PilotAssistant({
  bookId,
  pilot,
  disabled,
  updated,
}: {
  bookId: string;
  pilot: Pilot;
  disabled: boolean;
  updated: () => Promise<void>;
}) {
  const model = useModelChoice();
  const [pack, setPack] = useState<Pack | null>(null),
    [instruction, setInstruction] = useState(
      "按本样稿的视角和声音试写共同场景，用人物行动推进冲突，保留读者承诺。",
    ),
    [estimate, setEstimate] = useState(""),
    [generating, setGenerating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [tasks, setTasks] = useState<StoredTask["record"][]>([]),
    [offset, setOffset] = useState(0),
    [reload, setReload] = useState(0),
    [task, setTask] = useState<PilotTask | null>(null),
    [review, setReview] = useState(false),
    [draftRevision, setDraftRevision] = useState(0);
  const active = useRef(true),
    snapshotRequest = useRef(0),
    locked = useRef(false);
  const [references, setReferences] = useState<ContextSelection>({
    ready: true,
    ids: [],
    pack: null,
  });
  useEffect(
    () => setEstimate(""),
    [
      references.ready,
      references.pack?.hash,
      model.ready,
      model.choice?.diskHash,
    ],
  );
  async function snapshot() {
    const request = ++snapshotRequest.current;
    setPack(null);
    setEstimate("");
    const value = await api<Pack>("ai.pilotSnapshot", {
      bookId,
      expected: pilot,
    });
    if (active.current && request === snapshotRequest.current) setPack(value);
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      snapshotRequest.current++;
    };
  }, []);
  useEffect(() => {
    void snapshot().catch((e) => active.current && setError(e.message));
  }, [pilot.diskHash, pilot.bodyHash]);
  useEffect(() => {
    let live = true;
    api<StoredTask["record"][]>("ai.pilotTasks", {
      bookId,
      pilotId: pilot.id,
      offset,
    })
      .then((value) => {
        if (live) setTasks(value);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [bookId, pilot.id, offset, reload]);
  useEffect(() => {
    const reset = () => setEstimate("");
    window.addEventListener("novel-settings-changed", reset);
    return () => window.removeEventListener("novel-settings-changed", reset);
  }, []);
  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  const payload = () => ({
    modelChoice: model.choice,
    bookId,
    expected: {
      id: pilot.id,
      revision: pilot.revision,
      diskHash: pilot.diskHash,
      bodyHash: pilot.bodyHash,
    },
    snapshotHash: pack?.hash,
    skillId: "novel-pilot",
    instruction,
    materialIds: references.ids,
    materialContextHash: references.pack?.hash,
  });
  async function openTask(id: string, showReview = true) {
    const value = await api<PilotTask>("ai.task", { id });
    if (
      value.record.kind !== "pilot" ||
      value.snapshot.pilotTarget?.id !== pilot.id ||
      value.snapshot.pilotTarget.bookId !== bookId
    )
      throw new Error("任务与当前试写不一致");
    if (!active.current) return;
    setTask(value);
    setDraftRevision(value.reviewDraft?.revision || 0);
    setReview(
      showReview &&
        value.record.status === "awaiting-review" &&
        typeof value.record.candidate === "string",
    );
  }
  const unavailable =
    busy ||
    generating ||
    disabled ||
    !pack ||
    !references.ready ||
    !model.ready;
  const displayed = task
    ? task.record.status === "applied" && task.record.acceptedText !== undefined
      ? task.record.acceptedText
      : reviewContent(task).text
    : "";
  return (
    <section className="pilot-assistant" aria-label="试写 AI 协作">
      <details>
        <summary>AI 试写当前分支</summary>
        <ModelChoiceNotice value={model} />
        <p>
          使用内置“开篇试写”方法；先审阅候选，再明确接受。只改当前样稿正文，不改标题、场景字段或正式章节。多种方案请分别复制分支后生成。
        </p>
        <label>
          试写要求
          <textarea
            aria-label="AI 试写要求"
            maxLength={8000}
            disabled={busy || generating}
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              setEstimate("");
            }}
          />
        </label>
        <button
          disabled={busy || generating || disabled}
          onClick={() => void perform(snapshot)}
        >
          刷新试写快照
        </button>
        {pack && (
          <details>
            <summary>
              将发送的场景、样稿与来源（{pack.context.length} 字符）
            </summary>
            <pre className="context-prose">{pack.context}</pre>
          </details>
        )}
        <ContextSelector
          bookId={bookId}
          disabled={busy || generating || disabled}
          onChange={setReferences}
        />
        <div className="pilot-toolbar">
          <button
            disabled={unavailable}
            onClick={() =>
              void perform(async () => {
                const value = await api("ai.pilotEstimate", payload());
                if (active.current)
                  setEstimate(
                    `作者材料约 ${value.inputTokens} Token，${value.contextCharacters} 字符；${value.projectedCost === null ? "费用未知" : `按自定义单价预估 ${value.projectedCost} ${value.currency}`}。完整请求另行校验预算。`,
                  );
              })
            }
          >
            估算试写任务
          </button>
          <button
            disabled={unavailable || !instruction.trim()}
            onClick={() => {
              setGenerating(true);
              void perform(async () => {
                try {
                  const result = await api<{ id: string }>(
                    "ai.pilotGenerate",
                    payload(),
                  );
                  await openTask(result.id);
                } finally {
                  if (active.current) {
                    setGenerating(false);
                    setReload((n) => n + 1);
                  }
                }
              });
            }}
          >
            生成试写候选
          </button>
          {generating && (
            <button
              onClick={() =>
                void api("ai.cancel").catch((e) => setError(e.message))
              }
            >
              取消试写生成
            </button>
          )}
        </div>
        {estimate && <p role="status">{estimate}</p>}
        {generating && (
          <p role="status">官方 Harness 正在生成试写候选，原稿保持。</p>
        )}
      </details>
      {error && !review && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <details>
        <summary>这份试写的 AI 任务（本页 {tasks.length}）</summary>
        <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
          刷新试写任务
        </button>
        {tasks.map((item) => (
          <button
            className="material-task-row"
            key={item.id}
            disabled={busy}
            onClick={() => void perform(() => openTask(item.id))}
          >
            {new Date(item.startedAt).toLocaleString("zh-CN")} ·{" "}
            {labels[item.status] || item.status}
          </button>
        ))}
        <div className="pilot-toolbar">
          <button
            disabled={busy || !offset}
            onClick={() => setOffset(Math.max(0, offset - 40))}
          >
            上一页试写任务
          </button>
          <button
            disabled={busy || tasks.length < 40}
            onClick={() => setOffset(offset + 40)}
          >
            下一页试写任务
          </button>
        </div>
      </details>
      {task && (
        <section className="pilot-task" aria-label="试写任务详情">
          <h4>
            {labels[task.record.status] || task.record.status} ·{" "}
            {task.snapshot.pilotTarget.input.title}
          </h4>
          <p>
            绑定样稿版本 {task.snapshot.pilotTarget.revision}
            ；历史快照不随后续改稿变化。
          </p>
          {task.reviewDraftError && <p role="alert">{task.reviewDraftError}</p>}
          {task.record.errorCode && (
            <p>
              任务结束原因：{task.record.errorCode}
              。原稿未自动更改，可保留内容后基于当前样稿重新生成。
            </p>
          )}
          <details>
            <summary>任务当时的输入与候选</summary>
            <pre>{task.snapshot.context}</pre>
            <h4>
              {task.record.partialCandidate
                ? "未完成片段（不能直接接受）"
                : task.record.status === "applied"
                  ? "实际接受稿"
                  : "候选 / 审阅草稿"}
            </h4>
            <pre>{displayed || "没有已保存的输出"}</pre>
          </details>
          {task.record.usage && (
            <p>
              请求 {task.record.usage.attempts} 次 · 已回报 Token{" "}
              {task.record.usage.observedTokens} · 费用{" "}
              {task.record.usage.cost === null
                ? "未知"
                : task.record.usage.cost}
              。完整预算明细可在全局任务记录查看。
            </p>
          )}
          {task.record.status === "awaiting-review" && (
            <button
              disabled={busy}
              onClick={() => {
                setError("");
                setReview(true);
              }}
            >
              审阅试写候选
            </button>
          )}
          {["accepting", "acceptance-uncertain"].includes(
            task.record.status,
          ) && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api("ai.reconcile", { id: task.record.id });
                  await openTask(task.record.id);
                  setReload((n) => n + 1);
                })
              }
            >
              核对试写接受结果
            </button>
          )}
        </section>
      )}
      {review &&
        task &&
        createPortal(
          <CandidateReview
            key={`${task.record.id}.${task.record.acceptance?.id || "initial"}`}
            original={task.snapshot.pilotTarget.input.body}
            originalLabel="原试写正文"
            targetLabel="当前试写正文"
            candidate={task.record.candidate || ""}
            initialText={displayed}
            hasSavedDraft={!!task.reviewDraft}
            applying={busy}
            error={error || task.reviewDraftError || ""}
            onClose={() => {
              setReview(false);
              setError("");
            }}
            onSave={async (text) => {
              if (task.reviewDraftError) throw new Error(task.reviewDraftError);
              const result = await api<NonNullable<StoredTask["reviewDraft"]>>(
                "ai.saveReview",
                {
                  id: task.record.id,
                  text,
                  expectedRevision: draftRevision,
                },
              );
              setDraftRevision(result.revision);
              setTask((value) =>
                value ? { ...value, reviewDraft: result } : value,
              );
            }}
            onAccept={(candidate) =>
              perform(async () => {
                if (disabled)
                  throw new Error(
                    "当前样稿有未保存调整或正在操作，请先关闭审阅并保存，再核对候选版本。",
                  );
                const result = await api<{
                  pilot: Pilot;
                  receiptPending: boolean;
                }>("ai.pilotAccept", { id: task.record.id, candidate });
                await updated();
                if (!active.current) return;
                setReview(false);
                await openTask(task.record.id, false);
                setReload((n) => n + 1);
                setMessage(
                  result.receiptPending
                    ? "试写已保存，接受状态待核对。"
                    : "已接受试写候选，正式章节未改动。",
                );
              })
            }
          />,
          document.body,
        )}
    </section>
  );
}
