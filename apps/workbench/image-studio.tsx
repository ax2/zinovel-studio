import React, { useEffect, useRef, useState } from "react";
import { api, type Book } from "./api";
import { registerEditorCloseGuard } from "./editor-close-guards";
import { imageGenerationPreflight } from "../../packages/novel-domain/image-generation.mjs";
import type { AssetPurpose } from "../../packages/novel-domain/assets.mjs";
import type { ModelChoice } from "./model-choice";

type Expected = { id: string; revision: number; diskHash: string };
type ImageModel = {
  id: string;
  label: string;
  model: string;
  runnable: boolean;
  hasKey: boolean;
  imageOptions: null | { responseMode: "default-base64" | "request-base64" };
  imageBudget: {
    maxImages: number;
    maxCost: number;
    pricing: null | { currency: string; perImage: number };
  };
};
type Task = Expected & {
  status: string;
  storedStatus: string;
  restoredSource: boolean;
  createdAt: string;
  request: { prompt: string; n: number; size: string; responseMode: string };
  profile: { label: string; model: string; revision: number; diskHash: string };
  target: {
    purpose: AssetPurpose;
    material: Expected | null;
    chapter: Expected | null;
  };
  budget: ImageModel["imageBudget"];
  interruptedAfterResponse: boolean;
  candidates: {
    index: number;
    assetId: string;
    decision: string;
    blob: { sha256: string; displayWidth: number; displayHeight: number };
    revisedPrompt?: string;
  }[];
  outcome?: { code: string; dispatched: boolean; remoteResult: string };
};
type Job = {
  bookId: string;
  id: string;
  phase: string;
  running: boolean;
  localResponseRetained: boolean;
  cancelRequested: boolean;
};
type Draft = {
  schemaVersion: 1;
  bookId: string;
  prompt: string;
  purpose: AssetPurpose;
  materialId: string;
  chapterId: string;
  n: number;
  size: string;
  title: string;
  rights: string;
};
const purposes: Record<AssetPurpose, string> = {
  cover: "封面候选",
  portrait: "人物定妆",
  map: "地图底图",
  illustration: "章节插图",
  reference: "参考图",
};
const statuses: Record<string, string> = {
  prepared: "待确认发送",
  sending: "正在等待服务",
  "send-intent": "发送结果待核对",
  "remote-unknown": "远端结果未知",
  "saving-candidates": "候选正在保存",
  "received-pending-check": "图像已返回，需核对本地文件",
  received: "候选待审阅",
  unknown: "远端结果未知",
  failed: "请求未完成",
  cancelled: "发送前已取消",
  discarded: "已放弃任务",
};
const jobPhases: Record<string, string> = {
  preparing: "正在核对配置",
  requesting: "等待图像服务",
  saving: "保存候选",
  "local-save-pending": "候选等待本地补存",
  "outcome-save-pending": "结果等待本地保存",
};
const expected = (task: Expected): Expected => ({
  id: task.id,
  revision: task.revision,
  diskHash: task.diskHash,
});
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "图像操作未完成，请保留当前输入后核对";
const blank = (book: Book): Draft => ({
  schemaVersion: 1,
  bookId: book.id,
  prompt: "",
  purpose: "cover",
  materialId: "",
  chapterId: "",
  n: 1,
  size: "1024x1024",
  title: "图像候选",
  rights: "",
});
function draftValue(raw: string, bookId: string): Draft {
  const value = JSON.parse(raw);
  if (
    raw.length > 40000 ||
    !value ||
    value.schemaVersion !== 1 ||
    value.bookId !== bookId ||
    Object.keys(value).sort().join(",") !==
      "bookId,chapterId,materialId,n,prompt,purpose,rights,schemaVersion,size,title" ||
    !Object.hasOwn(purposes, value.purpose) ||
    !Number.isInteger(value.n) ||
    Math.abs(value.n) > 1000000 ||
    !["1024x1024", "1024x1536", "1536x1024", "auto"].includes(value.size) ||
    ["prompt", "materialId", "chapterId", "title", "rights"].some(
      (key) => typeof value[key] !== "string",
    ) ||
    value.prompt.length > 8000 ||
    value.title.length > 200 ||
    value.rights.length > 4000
  )
    throw new Error("本机图像草稿版本或内容无法识别，原缓存已保留");
  return value;
}

export function ImageStudio({
  book,
  onClose,
  onModels,
}: {
  book: Book;
  onClose: () => void;
  onModels: () => void;
}) {
  const storageKey = `zinovel-image-studio/${book.id}`;
  const [draft, setDraft] = useState<Draft>(() => blank(book)),
    draftRef = useRef(draft),
    [loaded, setLoaded] = useState(false),
    loadedRef = useRef(false),
    [unknown, setUnknown] = useState(false),
    unknownRef = useRef(false),
    [model, setModel] = useState<ImageModel | null>(null),
    [choice, setChoice] = useState<ModelChoice | null>(null),
    [rows, setRows] = useState<
      { id: string; status: string; purpose: AssetPurpose; createdAt: string }[]
    >([]),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [refresh, setRefresh] = useState(0),
    [task, setTask] = useState<Task | null>(null),
    taskRef = useRef<Task | null>(null),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    locked = useRef(false),
    alive = useRef(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [discardConfirmed, setDiscardConfirmed] = useState(false),
    [index, setIndex] = useState(0),
    [preview, setPreview] = useState(""),
    [previewIdentity, setPreviewIdentity] = useState(""),
    [mobileView, setMobileView] = useState<"compose" | "history" | "review">(
      "compose",
    ),
    [previewError, setPreviewError] = useState(""),
    [cardQuery, setCardQuery] = useState(""),
    [cardOffset, setCardOffset] = useState(0),
    [cards, setCards] = useState<{ id: string; title: string; kind: string }[]>(
      [],
    ),
    [cardTotal, setCardTotal] = useState(0);
  function showTask(next: Task) {
    taskRef.current = next;
    setTask(next);
    setMobileView("review");
  }
  function persist() {
    if (!loadedRef.current) return false;
    if (unknownRef.current) return true; // Unknown bytes are already retained; do not replace them.
    try {
      localStorage.setItem(storageKey, JSON.stringify(draftRef.current));
      return true;
    } catch {
      if (alive.current)
        setError("本机草稿保存失败，请保留输入并释放空间后重试；窗口保持打开");
      return false;
    }
  }
  function change(next: Draft) {
    if (unknownRef.current || !loadedRef.current) return;
    draftRef.current = next;
    setDraft(next);
    persist();
  }
  const close = () => {
    if (persist()) onClose();
  };
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) {
        const value = draftValue(raw, book.id);
        draftRef.current = value;
        setDraft(value);
      }
    } catch (e) {
      unknownRef.current = true;
      setUnknown(true);
      setError(message(e));
    }
    loadedRef.current = true;
    setLoaded(true);
    return () => {
      alive.current = false;
    };
  }, [book.id]);
  useEffect(() => registerEditorCloseGuard(persist), [book.id]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ profile: ImageModel | null; modelChoice: ModelChoice | null }>(
        "image.settings",
      ).then(
        (result) => {
          if (live) {
            setModel(result.profile);
            setChoice(result.modelChoice);
          }
        },
        (e) => {
          if (live) {
            setModel(null);
            setChoice(null);
            setError(message(e));
          }
        },
      );
    void load();
    window.addEventListener("novel-settings-changed", load);
    return () => {
      live = false;
      window.removeEventListener("novel-settings-changed", load);
    };
  }, [book.id]);
  useEffect(() => {
    let live = true;
    api<{ tasks: typeof rows; total: number; errors: { message: string }[] }>(
      "image.list",
      { bookId: book.id, offset },
    ).then(
      (result) => {
        if (!live) return;
        setRows(result.tasks);
        setTotal(result.total);
        if (result.errors.length)
          setError("部分历史任务不能读取，原文件已保留，请先检查作品文件");
      },
      (e) => {
        if (live) setError(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, [book.id, offset, refresh]);
  useEffect(() => {
    let live = true,
      pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api<Job | null>("image.status");
        if (!live) return;
        setJob(next);
        const selected = taskRef.current;
        if (
          selected &&
          (selected.status === "sending" ||
            selected.status === "saving-candidates" ||
            (next?.bookId === book.id && next.id === selected.id))
        ) {
          const current = await api<Task>("image.read", {
            bookId: book.id,
            id: selected.id,
          });
          if (
            live &&
            taskRef.current?.id === current.id &&
            taskRef.current.diskHash !== current.diskHash
          )
            showTask(current);
        }
      } catch (e) {
        if (live) setError(message(e));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 800);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [book.id]);
  useEffect(() => {
    let live = true;
    api<{ items: typeof cards; total: number }>("materials.list", {
      bookId: book.id,
      options: { kind: "character", query: cardQuery, offset: cardOffset },
    }).then(
      (result) => {
        if (live) {
          setCards(result.items);
          setCardTotal(result.total);
        }
      },
      (e) => {
        if (live) setError(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, [book.id, cardQuery, cardOffset, refresh]);
  useEffect(() => {
    setConfirmed(false);
    setDiscardConfirmed(false);
    setIndex(0);
  }, [task?.id]);
  useEffect(() => {
    let live = true;
    setPreview("");
    setPreviewError("");
    if (!task?.candidates[index]) return;
    api<{ thumbnail: string }>("image.preview", {
      bookId: book.id,
      id: task.id,
      index,
    }).then(
      (result) => {
        if (live) {
          setPreview(result.thumbnail);
          setPreviewIdentity(`${task.id}/${task.diskHash}/${index}`);
        }
      },
      (e) => {
        if (live) setPreviewError(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, [book.id, task?.id, task?.diskHash, index, refresh]);
  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setRefresh((value) => value + 1);
      }
    }
  }
  async function select(id: string) {
    await perform(async () => {
      const value = await api<Task>("image.read", { bookId: book.id, id });
      if (alive.current) showTask(value);
    });
  }
  const ready = !!(
      loaded &&
      !unknown &&
      model?.runnable &&
      model?.hasKey &&
      model?.imageOptions &&
      choice
    ),
    ownJob = job?.bookId === book.id && job.id === task?.id ? job : null,
    candidate = task?.candidates[index],
    previewMatches =
      !!task &&
      previewIdentity === `${task.id}/${task.diskHash}/${index}` &&
      !!preview;
  let cost = "费用未知：未配置每图单价；未知不代表免费。";
  if (task?.budget.pricing) {
    try {
      const value = imageGenerationPreflight(task.request, task.budget);
      cost = `手填估算 ${value.estimatedCost} ${value.currency}；以服务实际账单为准。`;
    } catch (e) {
      cost = message(e);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal image-studio"
        role="dialog"
        aria-modal="true"
        aria-label="AI 图像工作室"
      >
        <header className="modal-heading">
          <div>
            <h2>AI 图像工作室</h2>
            <p>
              封面、定妆、地图与章图候选。只发送明确确认的提示词；生成结果不会自动改正文或替换已有图片。
            </p>
          </div>
          <button onClick={close}>关闭图像工作室</button>
        </header>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {job && (
          <p className="image-job-status" role="status">
            {job.bookId === book.id ? "当前作品" : "其他作品"}有图像任务：
            {jobPhases[job.phase] || "正在处理"}。
            {job.localResponseRetained
              ? "候选在当前进程等待本地补存，退出前必须处理。"
              : "全局一次处理一项；取消只停止本地等待，已发送时可能仍计费。"}
          </p>
        )}
        <nav className="image-mobile-nav" aria-label="图像工作室视图">
          {(
            [
              ["compose", "新图像"],
              ["history", "任务记录"],
              ["review", "候选审阅"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={mobileView === id}
              onClick={() => setMobileView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="image-studio-grid" data-mobile-view={mobileView}>
          <div className="image-compose">
            <section className="image-form">
              <h3>准备新任务</h3>
              <p>
                {model
                  ? `${model.label} · ${model.model}`
                  : "尚未选择独立图像服务"}
              </p>
              <button
                onClick={() => {
                  if (persist()) onModels();
                }}
              >
                管理图像模型
              </button>
              {!ready && (
                <p>
                  请在模型管理中保存独立图像
                  Key，明确响应模式并选择图像服务。当前未满足发送条件。
                </p>
              )}
              {unknown && (
                <button
                  onClick={() => {
                    try {
                      localStorage.removeItem(storageKey);
                      unknownRef.current = false;
                      setUnknown(false);
                      const value = blank(book);
                      draftRef.current = value;
                      setDraft(value);
                      setError("");
                    } catch {
                      setError("本机缓存无法清理，原缓存保留");
                    }
                  }}
                >
                  明确放弃无法识别的本机图像草稿
                </button>
              )}
              <fieldset disabled={busy || !loaded || unknown}>
                <label>
                  图像用途
                  <select
                    aria-label="图像用途"
                    value={draft.purpose}
                    onChange={(e) =>
                      change({
                        ...draft,
                        purpose: e.target.value as AssetPurpose,
                      })
                    }
                  >
                    {Object.entries(purposes).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.purpose === "portrait" && (
                  <>
                    <label>
                      搜索目标人物
                      <input
                        value={cardQuery}
                        onChange={(e) => {
                          setCardQuery(e.target.value);
                          setCardOffset(0);
                        }}
                      />
                    </label>
                    <label>
                      目标人物
                      <select
                        aria-label="目标人物"
                        value={draft.materialId}
                        onChange={(e) =>
                          change({ ...draft, materialId: e.target.value })
                        }
                      >
                        <option value="">请选择明确人物</option>
                        {draft.materialId &&
                          !cards.some(
                            (item) => item.id === draft.materialId,
                          ) && (
                            <option value={draft.materialId}>
                              已选人物（不在本页，发送前重新核对）
                            </option>
                          )}
                        {cards.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="button-row">
                      <button
                        disabled={!cardOffset}
                        onClick={() =>
                          setCardOffset((value) => Math.max(0, value - 40))
                        }
                      >
                        上一页人物
                      </button>
                      <button
                        disabled={cardOffset + 40 >= cardTotal}
                        onClick={() => setCardOffset((value) => value + 40)}
                      >
                        下一页人物
                      </button>
                    </div>
                  </>
                )}
                {draft.purpose === "illustration" && (
                  <label>
                    目标章节
                    <select
                      aria-label="目标章节"
                      value={draft.chapterId}
                      onChange={(e) =>
                        change({ ...draft, chapterId: e.target.value })
                      }
                    >
                      <option value="">请选择明确章节</option>
                      {book.chapters
                        .filter((item) => !item.deletedAt)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  图像提示词
                  <textarea
                    rows={7}
                    maxLength={8000}
                    aria-label="图像提示词"
                    value={draft.prompt}
                    onChange={(e) =>
                      change({ ...draft, prompt: e.target.value })
                    }
                  />
                </label>
                <p>
                  仅发送上述提示词，不自动附加整书正文或人物卡。目标版本用于关联与冲突核对。参考图编辑和人物多视角一致性仍待专门接入。
                </p>
                <label>
                  候选数量
                  <input
                    type="number"
                    min={1}
                    max={4}
                    step={1}
                    value={draft.n}
                    onChange={(e) =>
                      change({ ...draft, n: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  图像尺寸
                  <select
                    aria-label="图像尺寸"
                    value={draft.size}
                    onChange={(e) => change({ ...draft, size: e.target.value })}
                  >
                    {["1024x1024", "1024x1536", "1536x1024", "auto"].map(
                      (size) => (
                        <option key={size}>{size}</option>
                      ),
                    )}
                  </select>
                </label>
                <button
                  disabled={!ready || !!job || !draft.prompt.trim()}
                  onClick={() =>
                    void perform(async () => {
                      if (!model?.imageOptions || !choice || !persist()) return;
                      const material =
                        draft.purpose === "portrait"
                          ? await api<Expected>("materials.read", {
                              bookId: book.id,
                              id: draft.materialId,
                            })
                          : null;
                      const chapter =
                        draft.purpose === "illustration"
                          ? await api<Expected>("chapter.read", {
                              bookId: book.id,
                              chapterId: draft.chapterId,
                            })
                          : null;
                      const value = await api<Task>("image.prepare", {
                        bookId: book.id,
                        input: {
                          id: crypto.randomUUID(),
                          choice,
                          request: {
                            prompt: draft.prompt,
                            n: draft.n,
                            size: draft.size,
                            responseMode: model.imageOptions.responseMode,
                          },
                          target: {
                            purpose: draft.purpose,
                            material: material ? expected(material) : null,
                            chapter: chapter ? expected(chapter) : null,
                          },
                        },
                      });
                      if (alive.current) {
                        showTask(value);
                        setConfirmed(false);
                        setNotice(
                          "任务已保存，尚未发送。请核对下方冻结内容并确认费用。",
                        );
                      }
                    })
                  }
                >
                  准备图像任务（不发送）
                </button>
              </fieldset>
            </section>
            <section className="image-history">
              <h3>图像任务记录</h3>
              <button
                disabled={busy}
                onClick={() => setRefresh((value) => value + 1)}
              >
                刷新图像任务
              </button>
              <p>{total} 项；每页最多 40 项</p>
              <div className="image-task-list">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    disabled={busy}
                    aria-pressed={task?.id === row.id}
                    onClick={() => void select(row.id)}
                  >
                    {purposes[row.purpose]} ·{" "}
                    {statuses[row.status] || row.status}
                    <small>{new Date(row.createdAt).toLocaleString()}</small>
                  </button>
                ))}
              </div>
              <div className="button-row">
                <button
                  disabled={busy || !offset}
                  onClick={() => setOffset((value) => Math.max(0, value - 40))}
                >
                  上一页任务
                </button>
                <button
                  disabled={busy || offset + 40 >= total}
                  onClick={() => setOffset((value) => value + 40)}
                >
                  下一页任务
                </button>
              </div>
            </section>
          </div>
          <div className="image-review">
            {task ? (
              <>
                <h3>核对与审阅 · {statuses[task.status] || task.status}</h3>
                <p>
                  {task.profile.label} · {task.profile.model} ·{" "}
                  {purposes[task.target.purpose]} · {task.request.n} 张 ·{" "}
                  {task.request.size}
                </p>
                {task.restoredSource && (
                  <p>
                    这是恢复副本中的原任务，可审阅或明确采用已有候选，不会接续原网络请求。
                  </p>
                )}
                <label>
                  冻结提示词
                  <textarea
                    aria-label="冻结提示词"
                    readOnly
                    rows={6}
                    value={task.request.prompt}
                  />
                </label>
                <p>{cost}</p>
                {task.status === "prepared" && (
                  <>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      我确认提示词、用途、所选图像服务及可能的费用，明确发送一次
                    </label>
                    <button
                      disabled={busy || !!job || !confirmed || !ready}
                      onClick={() =>
                        void perform(async () => {
                          const result = await api<{
                            task?: Task;
                            message?: string;
                          }>("image.start", {
                            bookId: book.id,
                            expected: expected(task),
                            choice,
                          });
                          if (alive.current) {
                            if (result.task) showTask(result.task);
                            setNotice(
                              result.message || "图像调用已结束，请审阅结果。",
                            );
                          }
                        })
                      }
                    >
                      确认发送图像请求
                    </button>
                  </>
                )}
                {ownJob?.running && (
                  <button
                    disabled={
                      ownJob.phase === "saving" || ownJob.cancelRequested
                    }
                    onClick={() => {
                      void api("image.cancel", {
                        bookId: book.id,
                        id: task.id,
                      }).then(
                        () => {
                          if (alive.current)
                            setNotice(
                              "已请求取消本地等待；远端是否已处理以任务结果为准。",
                            );
                        },
                        (e) => {
                          if (alive.current) setError(message(e));
                        },
                      );
                    }}
                  >
                    取消本地图像等待
                  </button>
                )}
                {(task.status === "remote-unknown" ||
                  task.status === "unknown") && (
                  <p role="status">
                    远端结果未知。不会自动重试；另建并发送任务可能重复计费，请先核对服务记录。
                  </p>
                )}
                {task.outcome && (
                  <p>
                    结果代码 {task.outcome.code} · {task.outcome.remoteResult}
                    。不显示供应商原始错误或凭据。
                  </p>
                )}
                {ownJob && !ownJob.running && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const result = await api<{
                          task?: Task;
                          message?: string;
                        }>("image.retry-save", {
                          bookId: book.id,
                          id: task.id,
                        });
                        if (alive.current) {
                          if (result.task) showTask(result.task);
                          setNotice(
                            result.message ||
                              "本地保存完成，没有再次请求图像服务。",
                          );
                        }
                      })
                    }
                  >
                    重试本地保存（不重新请求）
                  </button>
                )}
                {task.status === "received-pending-check" && !ownJob && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const result = await api<{
                          task: Task;
                          status: string;
                        }>("image.reconcile", {
                          bookId: book.id,
                          expected: expected(task),
                        });
                        if (alive.current) {
                          showTask(result.task);
                          setNotice(
                            result.status === "received"
                              ? "原图已在本地核对完成，没有请求服务。"
                              : "候选文件缺失或损坏，任务保留未完成状态；没有重新请求。",
                          );
                        }
                      })
                    }
                  >
                    核对本地候选文件
                  </button>
                )}
                {task.interruptedAfterResponse && (
                  <p>取消到达时已收到有效图像，候选已保留供审阅。</p>
                )}
                {candidate && (
                  <>
                    <label>
                      审阅候选
                      <select
                        aria-label="审阅候选"
                        value={index}
                        onChange={(e) => setIndex(Number(e.target.value))}
                      >
                        {task.candidates.map((item) => (
                          <option key={item.index} value={item.index}>
                            候选 {item.index + 1} ·{" "}
                            {item.decision === "accepted"
                              ? "已采用"
                              : item.decision === "discarded"
                                ? "已放弃"
                                : "未采用"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="image-candidate-preview">
                      {previewMatches ? (
                        <img
                          src={preview}
                          alt={`候选 ${index + 1} 实际原图预览`}
                        />
                      ) : (
                        <p>{previewError || "正在校验候选原图…"}</p>
                      )}
                    </div>
                    <p>
                      {candidate.blob.displayWidth} ×{" "}
                      {candidate.blob.displayHeight} · SHA256{" "}
                      {candidate.blob.sha256}
                    </p>
                    {candidate.revisedPrompt && (
                      <details>
                        <summary>服务返回的提示说明</summary>
                        <p>{candidate.revisedPrompt}</p>
                      </details>
                    )}
                    {candidate.decision === "accepted" ? (
                      <p role="status">
                        该候选已采用为资源。请到图像资源库编辑、回收或另选封面；这里不会重建或覆盖它。
                      </p>
                    ) : (
                      <fieldset
                        disabled={
                          busy ||
                          unknown ||
                          !loaded ||
                          task.status !== "received" ||
                          candidate.decision !== "pending" ||
                          !previewMatches
                        }
                      >
                        <label>
                          采用后的图像标题
                          <input
                            maxLength={200}
                            value={draft.title}
                            onChange={(e) =>
                              change({ ...draft, title: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          权利与使用范围
                          <textarea
                            rows={3}
                            maxLength={4000}
                            aria-label="权利与使用范围"
                            value={draft.rights}
                            onChange={(e) =>
                              change({ ...draft, rights: e.target.value })
                            }
                          />
                        </label>
                        <p>
                          明确采用只新增资源，不自动设为封面、定妆或地图底图，也不进入出版物。请自行核对服务使用条件与画面质量。
                        </p>
                        <button
                          disabled={!draft.title.trim()}
                          onClick={() =>
                            void perform(async () => {
                              const result = await api<{ task: Task }>(
                                "image.adopt",
                                {
                                  bookId: book.id,
                                  expected: expected(task),
                                  index,
                                  input: {
                                    title: draft.title,
                                    purpose: task.target.purpose,
                                    source: `AI生成；${task.profile.label} / ${task.profile.model}；任务 ${task.id}`,
                                    rights: draft.rights,
                                    notes: "",
                                    linkedIds: task.target.material
                                      ? [task.target.material.id]
                                      : [],
                                  },
                                },
                              );
                              if (alive.current) {
                                showTask(result.task);
                                setNotice(
                                  "候选已新增到图像资源库，正文和已选图片保持原样。",
                                );
                              }
                            })
                          }
                        >
                          明确采用当前候选
                        </button>
                      </fieldset>
                    )}
                  </>
                )}
                {task.status !== "discarded" && !ownJob?.running && (
                  <>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={discardConfirmed}
                        onChange={(e) => setDiscardConfirmed(e.target.checked)}
                      />
                      确认放弃此任务中未采用的候选；已发送费用不会撤销，未补存原图可能无法找回
                    </label>
                    <button
                      disabled={busy || !discardConfirmed}
                      onClick={() =>
                        void perform(async () => {
                          const result = ownJob?.localResponseRetained
                            ? await api<{ task: Task }>(
                                "image.discard-retained",
                                {
                                  bookId: book.id,
                                  expected: expected(task),
                                  confirmation: "discard-unsaved-images",
                                },
                              )
                            : {
                                task: await api<Task>("image.discard", {
                                  bookId: book.id,
                                  expected: expected(task),
                                }),
                              };
                          if (alive.current) {
                            showTask(result.task);
                            setNotice("任务已明确放弃；已采用资源保留。");
                          }
                        })
                      }
                    >
                      明确放弃未采用候选
                    </button>
                  </>
                )}
              </>
            ) : (
              <p>
                准备任务后先核对，再明确发送。也可以从左侧读取已有图像任务；重启不会自动重发。
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
