import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api";
import { BudgetSettingsEditor, type BudgetSettings } from "./budget-settings";
import { modelServiceURL } from "../../packages/novel-domain/model-service.mjs";
import type { ModelChoice } from "./model-choice";

type ImageBudget = {
  maxImages: number;
  maxCost: number;
  pricing: null | { currency: "CNY" | "USD"; perImage: number };
};
type Profile = {
  id: string;
  label: string;
  protocol: "anthropic-text" | "openai-images" | "openai-images-edits";
  capability: "text" | "image";
  baseURL: string;
  model: string;
  budget?: BudgetSettings;
  imageBudget?: ImageBudget;
  imageOptions?: { responseMode: "default-base64" | "request-base64" } | null;
  hasKey: boolean;
  credentialMismatch: boolean;
};
type View = {
  initialized: boolean;
  encryptionAvailable: boolean;
  revision: number;
  diskHash: string;
  profiles: Profile[];
  routes: { text: string | null; image: string | null };
  recoveryNeeded?: boolean;
  legacyToken?: string;
  legacy?: { baseURL: string; model: string; hasKey: boolean };
};
type Draft = {
  id?: string;
  label: string;
  protocol: Profile["protocol"];
  baseURL: string;
  model: string;
  budget: BudgetSettings;
  imageBudget: ImageBudget;
  imageOptions: { responseMode: "default-base64" | "request-base64" } | null;
  originalService?: string;
  hasKey: boolean;
};
const empty = (): Draft => ({
  label: "",
  protocol: "anthropic-text",
  baseURL: "",
  model: "",
  budget: {
    maxSteps: 12,
    maxContextCharacters: 120000,
    maxOutputTokens: 8192,
    maxReportedTokens: 0,
    maxEstimatedInputTokens: 0,
    maxCost: 0,
    pricing: null,
  },
  imageBudget: { maxImages: 1, maxCost: 0, pricing: null },
  imageOptions: null,
  hasKey: false,
});
const expected = (view: View): ModelChoice => ({
  revision: view.revision,
  diskHash: view.diskHash,
});

export function ProfilesPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [baseline, setBaseline] = useState<ModelChoice | null>(null),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [deleteId, setDeleteId] = useState<string | null>(null);
  const locked = useRef(false);
  const close = () => {
    if (!locked.current) onClose();
  };
  useEffect(() => {
    let live = true;
    api<View>("profiles.list").then(
      (v) => {
        if (live) setView(v);
      },
      (e) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const guard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, [busy]);
  function edit(profile?: Profile) {
    if (!view) return;
    const next = empty();
    setDraft(
      profile
        ? {
            ...next,
            ...profile,
            budget: profile.budget || next.budget,
            imageBudget: profile.imageBudget || next.imageBudget,
            originalService: profile.baseURL,
          }
        : next,
    );
    setBaseline(expected(view));
    setKey("");
    setError("");
    setMessage("");
    setDeleteId(null);
  }
  async function perform(action: string, payload: object, finishEdit = true) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<View>(action, payload);
      setView(next);
      setConfirmed(false);
      setDeleteId(null);
      if (finishEdit) {
        setDraft(null);
        setBaseline(null);
        setKey("");
      }
      setMessage("配置已保存；新任务使用当前选择，已开始的任务保留原配置。");
      window.dispatchEvent(new Event("novel-settings-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  let changed = false;
  if (draft?.originalService) {
    try {
      changed = modelServiceURL(draft.baseURL) !== draft.originalService;
    } catch {
      changed = true;
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal settings-modal model-profiles-panel"
        role="dialog"
        aria-modal="true"
        aria-label="模型与能力管理"
      >
        <div className="modal-heading">
          <h2>模型与能力管理</h2>
          <button
            type="button"
            aria-label="关闭模型管理窗口"
            disabled={busy}
            onClick={close}
          >
            <X />
          </button>
        </div>
        <p className="muted">
          文字写作由官方 DeepSeek Harness 执行。各配置独立保存
          Key、服务与预算；只有明确生成才发送所选小说内容。图像服务需先确认内联响应模式，再到
          AI 图像工作室核对并发送。
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error} 草稿保留；可取消编辑并刷新列表后重试。
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!view && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void perform("profiles.list", {})}
          >
            重新读取列表
          </button>
        )}
        {view && !view.initialized && (
          <>
            <p>
              {view.recoveryNeeded
                ? "模型列表缺失，已阻止生成且没有回用旧服务。恢复只会重建迁移前的一份文字配置，不包含迁移后新增或更改的配置。请先保留现有数据。"
                : "启用多模型将当前设置迁移为独立文字配置。迁移前文件会原样备份（含系统加密的旧Key）；活动设置改为新版指针。旧版无法读取新版模型设置，手工稿件不受影响。"}
            </p>
            <p>
              迁移来源：{view.legacy?.model || "未配置"}；
              {view.legacy?.hasKey ? "已有独立加密凭据" : "未保存有效凭据"}。
            </p>
            <label className="price-toggle">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已了解迁移、备份和旧版兼容边界
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy || !confirmed}
              onClick={() =>
                void perform("profiles.migrate", {
                  legacyToken: view.legacyToken,
                  ...(view.recoveryNeeded ? { restoreMissing: true } : {}),
                })
              }
            >
              {view.recoveryNeeded
                ? "从迁移前备份明确恢复"
                : "启用独立模型配置"}
            </button>
          </>
        )}
        {view?.initialized && (
          <>
            {(["text", "image"] as const).map((capability) => (
              <label key={capability}>
                {capability === "text" ? "文字写作服务" : "独立图像服务"}
                <select
                  aria-label={
                    capability === "text" ? "文字写作服务" : "图像服务"
                  }
                  value={view.routes[capability] || ""}
                  disabled={busy || !!draft}
                  onChange={(e) =>
                    void perform("profiles.select", {
                      capability,
                      id: e.target.value || null,
                      expected: expected(view),
                    })
                  }
                >
                  <option value="">不选择服务</option>
                  {view.profiles
                    .filter((p) => p.capability === capability)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} · {p.model}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            {!draft && (
              <>
                <div aria-label="已保存模型配置">
                  {view.profiles.map((profile) => (
                    <div key={profile.id} className="model-profile-row">
                      <strong>{profile.label}</strong>
                      <span>
                        {profile.capability === "text"
                          ? "文字"
                          : "图像（不可生成）"}{" "}
                        · {profile.model} ·{" "}
                        {profile.hasKey ? "已存Key" : "未存Key"}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => edit(profile)}
                        aria-label={`编辑配置 ${profile.label}`}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          Object.values(view.routes).includes(profile.id)
                        }
                        onClick={() => setDeleteId(profile.id)}
                        aria-label={`删除配置 ${profile.label}`}
                      >
                        删除
                      </button>
                      {deleteId === profile.id && (
                        <div>
                          <p>
                            删除此配置及当前加密Key？迁移前备份仍保留。此操作不会删除小说或历史任务。
                          </p>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void perform("profiles.remove", {
                                id: profile.id,
                                expected: expected(view),
                              })
                            }
                          >
                            确认删除配置
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setDeleteId(null)}
                          >
                            取消删除
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="muted">
                  删除已选配置前，请先切换或取消对应服务。清除当前Key不删除迁移前的加密备份。
                </p>
                <button
                  type="button"
                  disabled={busy || view.profiles.length >= 20}
                  onClick={() => edit()}
                >
                  新增模型配置
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void perform("profiles.list", {})}
                >
                  刷新配置列表
                </button>
              </>
            )}
            {draft && (
              <form
                aria-label="编辑模型配置"
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(draft.id ? "profiles.update" : "profiles.add", {
                    ...(draft.id ? { id: draft.id } : {}),
                    expected: baseline,
                    input: {
                      label: draft.label,
                      protocol: draft.protocol,
                      baseURL: draft.baseURL,
                      model: draft.model,
                      apiKey: key,
                      ...(draft.protocol === "anthropic-text"
                        ? { budget: draft.budget }
                        : {
                            imageBudget: draft.imageBudget,
                            imageOptions: draft.imageOptions,
                          }),
                    },
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <legend>{draft.id ? "编辑独立配置" : "新增独立配置"}</legend>
                  <label>
                    配置名称
                    <input
                      required
                      maxLength={80}
                      value={draft.label}
                      onChange={(e) =>
                        setDraft({ ...draft, label: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    协议与能力
                    <select
                      value={draft.protocol}
                      disabled={!!draft.id || busy}
                      onChange={(e) => {
                        setKey("");
                        setDraft({
                          ...empty(),
                          label: draft.label,
                          protocol: e.target.value as Draft["protocol"],
                        });
                      }}
                    >
                      <option value="anthropic-text">
                        Anthropic 兼容文字接口 · Harness
                      </option>
                      <option value="openai-images">
                        OpenAI 兼容内联图像接口
                      </option>
                      <option value="openai-images-edits">
                        参考图编辑接口 · JSON images / 内联结果
                      </option>
                    </select>
                  </label>
                  <label>
                    服务地址
                    <input
                      required
                      value={draft.baseURL}
                      onChange={(e) => {
                        setKey("");
                        setDraft({
                          ...draft,
                          baseURL: e.target.value,
                          budget: {
                            ...draft.budget,
                            pricing: null,
                            maxCost: 0,
                          },
                          imageBudget: {
                            ...draft.imageBudget,
                            pricing: null,
                            maxCost: 0,
                          },
                        });
                      }}
                    />
                  </label>
                  {changed && (
                    <p role="status">
                      地址已改变，保存时不会沿用旧Key；修改地址会清空尚未保存的Key。
                    </p>
                  )}
                  <label>
                    模型名称
                    <input
                      required
                      value={draft.model}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          model: e.target.value,
                          budget: {
                            ...draft.budget,
                            pricing: null,
                            maxCost: 0,
                          },
                          imageBudget: {
                            ...draft.imageBudget,
                            pricing: null,
                            maxCost: 0,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="off"
                      disabled={busy || !view.encryptionAvailable}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder={
                        draft.hasKey && !changed
                          ? "已保存，留空保留本配置Key"
                          : "未保存，绝不借用其他配置Key"
                      }
                    />
                  </label>
                  {!view.encryptionAvailable && (
                    <p role="alert">
                      系统安全存储不可用，不能保存新Key；请修复后再生成。
                    </p>
                  )}
                  {draft.protocol === "anthropic-text" ? (
                    <BudgetSettingsEditor
                      value={draft.budget}
                      onChange={(budget) => setDraft({ ...draft, budget })}
                    />
                  ) : (
                    <>
                      <p>
                        图像预算独立于文字服务。只有在 AI
                        图像工作室明确发送才调用服务；手填估算不代表供应商账单。
                      </p>
                      <label>
                        明确的图像响应模式
                        <select
                          aria-label="图像响应模式"
                          value={draft.imageOptions?.responseMode || ""}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              imageOptions: e.target.value
                                ? {
                                    responseMode: e.target.value as
                                      | "default-base64"
                                      | "request-base64",
                                  }
                                : null,
                            })
                          }
                        >
                          <option value="">未确认；保持不可运行</option>
                          <option value="default-base64">
                            服务默认返回内联base64；不发送response_format
                          </option>
                          <option value="request-base64">
                            明确请求response_format=b64_json
                          </option>
                        </select>
                      </label>
                      <p>
                        请按所选服务文档确认参数支持；不根据模型名称猜测，也不下载服务返回的远端图片URL。保存选项本身不会调用服务，旧配置保持未确认直到明确选择。
                      </p>
                      <label>
                        每次图像数量上限
                        <input
                          type="number"
                          required
                          min={1}
                          max={4}
                          step={1}
                          value={draft.imageBudget.maxImages}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              imageBudget: {
                                ...draft.imageBudget,
                                maxImages: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="price-toggle">
                        <input
                          type="checkbox"
                          checked={!!draft.imageBudget.pricing}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              imageBudget: {
                                ...draft.imageBudget,
                                maxCost: 0,
                                pricing: e.target.checked
                                  ? { currency: "CNY", perImage: 0 }
                                  : null,
                              },
                            })
                          }
                        />
                        配置图像单价
                      </label>
                      {draft.imageBudget.pricing && (
                        <>
                          <label>
                            图像价格币种
                            <select
                              value={draft.imageBudget.pricing.currency}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  imageBudget: {
                                    ...draft.imageBudget,
                                    pricing: {
                                      ...draft.imageBudget.pricing!,
                                      currency: e.target.value as "CNY" | "USD",
                                    },
                                  },
                                })
                              }
                            >
                              <option>CNY</option>
                              <option>USD</option>
                            </select>
                          </label>
                          <label>
                            每张图像单价
                            <input
                              type="number"
                              required
                              min={0}
                              max={1000000}
                              step="any"
                              value={draft.imageBudget.pricing.perImage}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  imageBudget: {
                                    ...draft.imageBudget,
                                    pricing: {
                                      ...draft.imageBudget.pricing!,
                                      perImage: Number(e.target.value),
                                    },
                                  },
                                })
                              }
                            />
                          </label>
                          <label>
                            图像费用阈值（0 为不启用）
                            <input
                              type="number"
                              required
                              min={0}
                              max={1000000}
                              step="any"
                              value={draft.imageBudget.maxCost}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  imageBudget: {
                                    ...draft.imageBudget,
                                    maxCost: Number(e.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                  <div className="modal-actions">
                    <button className="primary" type="submit">
                      保存独立配置
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(null);
                        setKey("");
                        setBaseline(null);
                        setError("");
                      }}
                    >
                      取消编辑
                    </button>
                  </div>
                </fieldset>
                {draft.id && draft.hasKey && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform("profiles.update", {
                        id: draft.id,
                        expected: baseline,
                        input: {
                          label: draft.label,
                          protocol: draft.protocol,
                          baseURL: draft.baseURL,
                          model: draft.model,
                          clearKey: true,
                          ...(draft.protocol === "anthropic-text"
                            ? { budget: draft.budget }
                            : {
                                imageBudget: draft.imageBudget,
                                imageOptions: draft.imageOptions,
                              }),
                        },
                      })
                    }
                  >
                    清除本配置Key并保存当前编辑
                  </button>
                )}
              </form>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>
            {busy ? "保存中…" : "关闭模型管理"}
          </button>
        </div>
      </section>
    </div>
  );
}
