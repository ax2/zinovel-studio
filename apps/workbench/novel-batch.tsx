import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useModelChoice, ModelChoiceNotice } from "./model-choice";
import { registerEditorCloseGuard } from "./editor-close-guards";
import "./book-project.css";
type Batch = {
  errorCode?: string;
  id: string;
  status: string;
  model: string;
  input: {
    genre: string;
    targetWords: number;
    trialChapters: number;
    novelCount: number;
    requestLimit: number;
    outputTokenLimit: number;
  };
  requestCount: number;
  reservedOutputTokens: number;
  books: {
    id: string;
    index: number;
    status: string;
    title?: string;
    errorCode?: string;
    actualTrialCharacters?: number;
  }[];
  attempts: { id: string; bookIndex: number; stage: string; status: string }[];
};
const statuses: Record<string, string> = {
  prepared: "待发送",
  running: "生成中",
  paused: "已暂停",
  partial: "部分完成 / 需要处理",
  completed: "本批生成完成",
  pending: "待生成",
  failed: "尚未完成",
  created: "已建为待审初稿",
  complete: "候选已校验",
  returned: "已有结果待核对",
  rejected: "结果结构不完整",
  "remote-unknown": "远端结果未知",
  cancelled: "已取消",
};
export function NovelBatchDialog({ onClose }: { onClose: () => void }) {
  const model = useModelChoice();
  const [input, setInput] = useState({
    genre: "悬疑幻想",
    inspiration: "",
    style: "",
    targetWords: 200000,
    trialChapters: 3,
    novelCount: 2,
    requestLimit: 100,
    outputTokenLimit: 1000000,
  });
  const [items, setItems] = useState<Batch[]>([]),
    [currentId, setCurrentId] = useState("");
  const [activeId, setActiveId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);
  const safety = useRef(false);
  safety.current = busy;
  useEffect(() => registerEditorCloseGuard(() => !safety.current), []);
  const current = items.find((item) => item.id === currentId);
  const needsUnknownAcknowledgement = current
    ? [
        ...new Map(
          current.attempts.map((a) => [`${a.bookIndex}/${a.stage}`, a]),
        ).values(),
      ].some((a) => a.status === "remote-unknown")
    : false;
  async function refresh() {
    const result = await api("batch.list");
    setItems(result.items);
    setActiveId(result.active?.id || "");
    if (result.errors.length)
      setError(
        "有批量任务记录无法读取，原始文件已保留；请保留应用数据并检查备份。",
      );
  }
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api("batch.list");
        if (live) {
          setItems(result.items);
          setActiveId(result.active?.id || "");
          if (result.errors.length)
            setError("有批量任务记录无法读取，原始文件已保留。");
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 1500);
      }
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal wide-modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-label="灵感批量创作"
      >
        <div className="modal-heading">
          <h2>灵感批量创作</h2>
          <button disabled={busy} aria-label="关闭批量创作" onClick={onClose}>
            关闭
          </button>
        </div>
        <p>
          从一个灵感生成多本独立小说。每书生成总纲、世界/人物、主支线/伏笔、每卷逐章细纲、指定数量试写和状态交接，再建为可编辑的待审初稿。
        </p>
        <p>
          采用官方 Harness
          顺序执行各书/阶段。关闭此面板可继续后台生成；退出程序会停止当前批次。重启不会自动付费续跑。预期字数是全书规划，本次正文只包含试写。
        </p>
        <ModelChoiceNotice value={model} />
        {error && <p role="alert">{error}</p>}
        <details open={!current}>
          <summary>新建批量创作</summary>
          <label>
            小说类型
            <input
              aria-label="批量小说类型"
              maxLength={80}
              value={input.genre}
              onChange={(e) => setInput({ ...input, genre: e.target.value })}
            />
          </label>
          <label>
            核心灵感与思路
            <textarea
              aria-label="批量创作灵感"
              rows={4}
              value={input.inspiration}
              onChange={(e) =>
                setInput({ ...input, inspiration: e.target.value })
              }
              maxLength={6000}
            />
          </label>
          <label>
            风格或排除项
            <input
              aria-label="批量风格要求"
              value={input.style}
              onChange={(e) => setInput({ ...input, style: e.target.value })}
              maxLength={1000}
            />
          </label>
          {(
            [
              ["targetWords", "全书预期字数", 1000, 50000000],
              ["trialChapters", "每本试写章数", 1, 30],
              ["novelCount", "同时创建小说数", 1, 10],
              ["requestLimit", "本批模型请求上限", 1, 500],
              ["outputTokenLimit", "本批输出Token预留上限", 64, 16000000],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type="number"
                min={min}
                max={max}
                value={input[key]}
                onChange={(e) =>
                  setInput({ ...input, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <p>
            每次调用先按该模型配置的输出Token上限预留预算，未知结果也不退回预留；这不是实际账单。单次费用与上下文限制继续使用模型设置；尚未填单价时不估算费用。
          </p>
          <button
            disabled={busy || !model.ready || !!activeId}
            onClick={() =>
              run(async () => {
                const prepared = await api<Batch>("batch.prepare", {
                  input,
                  modelChoice: model.choice,
                });
                setCurrentId(prepared.id);
                setUnknownAcknowledged(false);
              })
            }
          >
            冻结参数并预览批次（不调用模型）
          </button>
        </details>
        <label>
          创作批次
          <select
            aria-label="创作批次"
            value={currentId}
            disabled={busy}
            onChange={(e) => {
              setCurrentId(e.target.value);
              setUnknownAcknowledged(false);
            }}
          >
            <option value="">选择批次…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.input.genre} · {item.input.novelCount}本 ·{" "}
                {statuses[item.status] || item.status} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <section aria-label="批次进度">
            {current.errorCode && (
              <p role="alert">
                冻结资料校验或本地保存尚未完成，候选与原始记录已保留；没有自动重发请求。
              </p>
            )}
            <h3>{statuses[current.status] || current.status}</h3>
            <p>
              {current.model} · {current.input.novelCount}本 · 每本预期
              {current.input.targetWords}字 / 试写{current.input.trialChapters}
              章
            </p>
            <p>
              已预留{current.requestCount}/{current.input.requestLimit}
              次请求，输出Token上限预留{current.reservedOutputTokens}/
              {current.input.outputTokenLimit}
              。结构完成仍需要作者通读和文学审定，地图和定妆图当前生成制作登记，尚非实际图片。
            </p>
            <ul>
              {current.books.map((book) => (
                <li key={book.id}>
                  第{book.index + 1}本 {book.title || "尚未定名"} ·{" "}
                  {statuses[book.status] || book.status}
                  {book.actualTrialCharacters !== undefined
                    ? ` · 试写${book.actualTrialCharacters}字符`
                    : ""}
                  {book.errorCode === "budget-limit"
                    ? " · 达到本批预算上限"
                    : ""}
                </li>
              ))}
            </ul>
            <details>
              <summary>逐阶段请求记录</summary>
              <ul>
                {current.attempts.map((a) => (
                  <li key={a.id}>
                    第{a.bookIndex + 1}本 · {a.stage} ·{" "}
                    {statuses[a.status] || a.status} · {a.id.slice(0, 8)}
                  </li>
                ))}
              </ul>
            </details>
            {needsUnknownAcknowledgement && (
              <label className="batch-consent">
                <input
                  type="checkbox"
                  checked={unknownAcknowledged}
                  onChange={(e) => setUnknownAcknowledged(e.target.checked)}
                />
                我已核对原任务，确认未知请求重新发送可能再次计费。
              </label>
            )}
            {current.status !== "completed" && activeId !== current.id && (
              <button
                disabled={
                  busy ||
                  !!activeId ||
                  (needsUnknownAcknowledgement && !unknownAcknowledged)
                }
                onClick={() =>
                  run(async () => {
                    await api("batch.start", {
                      id: current.id,
                      acknowledgeUnknown: unknownAcknowledged,
                    });
                  })
                }
              >
                开始 / 继续批量生成（会调用模型）
              </button>
            )}
            {activeId === current.id && (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("batch.cancel", { id: current.id });
                  })
                }
              >
                停止当前批次并保留候选
              </button>
            )}
          </section>
        )}
      </section>
    </div>
  );
}
