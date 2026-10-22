import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2, Sparkles, X, Square } from "lucide-react";
import { api } from "./api";
import { TaskHistory, type StoredTask } from "./task-history";

type Settings = {
  baseURL: string;
  model: string;
  hasKey: boolean;
  encryptionAvailable: boolean;
  budget: {
    maxSteps: number;
    maxContextCharacters: number;
    maxOutputTokens: number;
    maxReportedTokens: number;
  };
};
export function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Settings | null>(null),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    api<Settings>("settings.get")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="modal-backdrop">
      <form
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型设置"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await api("settings.save", { ...config, apiKey: key });
            setKey("");
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="modal-heading">
          <h2>模型设置</h2>
          <button type="button" aria-label="关闭模型设置" onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="muted">
          AI 任务通过官方 DeepSeek Harness
          运行。开始生成时，选区和当前章节会发送到你配置的模型服务。
        </p>
        {config && (
          <>
            <label>
              服务地址
              <input
                value={config.baseURL}
                onChange={(e) =>
                  setConfig({ ...config, baseURL: e.target.value })
                }
              />
            </label>
            <label>
              模型名称
              <input
                value={config.model}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value })
                }
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  config.hasKey ? "已安全保存，留空保持原值" : "输入 API Key"
                }
              />
            </label>
            <p className="muted">
              凭据使用系统安全存储加密，界面不会读回已有密钥。
            </p>
            <details className="budget-settings">
              <summary>每次写作任务的预算</summary>
              <p className="muted">
                预算在新任务开始时冻结。达到上限后停止后续模型步骤，已保存结果保留。进行中的一次调用可能超过已回报用量上限。
              </p>
              {(
                [
                  ["maxSteps", "模型步骤上限", 1, 64],
                  ["maxContextCharacters", "章节上下文字符上限", 100, 120000],
                  ["maxOutputTokens", "每步输出 Token 上限", 64, 32768],
                  [
                    "maxReportedTokens",
                    "已回报 Token 上限（0 为不启用）",
                    0,
                    1000000,
                  ],
                ] as const
              ).map(([field, label, min, max]) => (
                <label key={field}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    required
                    value={config.budget[field]}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        budget: {
                          ...config.budget,
                          [field]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
              <p className="muted">
                启用已回报 Token
                上限后，若前一步没有回报用量，也会停止下一步。供应商内部网络重试不等同于模型步骤。当前费用未知，尚未配置价格。
              </p>
            </details>
            {config.hasKey && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    setConfig(
                      await api("settings.save", { ...config, clearKey: true }),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                清除已保存的密钥
              </button>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!config || saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </form>
    </div>
  );
}
export type WritingSnapshot = {
  bookId: string;
  chapterId: string;
  body: string;
  start: number;
  end: number;
  baseHash?: string;
};
export function WritingAssistant({
  snapshot,
  apply,
  openSettings,
  openChapter,
  bookId,
}: {
  snapshot: WritingSnapshot | null;
  apply: (
    base: WritingSnapshot,
    candidate: string,
    taskId?: string,
  ) => Promise<boolean>;
  openSettings: () => void;
  openChapter: (id: string, bookId?: string) => Promise<void>;
  bookId: string;
}) {
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]),
    [skillId, setSkillId] = useState("novel-polish"),
    [instruction, setInstruction] = useState("保留情节和人物意图，改善表达。");
  const [running, setRunning] = useState(false),
    [error, setError] = useState(""),
    [tasksOpen, setTasksOpen] = useState(false),
    [applying, setApplying] = useState(false),
    [proposalError, setProposalError] = useState(""),
    [proposal, setProposal] = useState<{
      id: string;
      text: string;
      base: WritingSnapshot;
    } | null>(null);
  useEffect(() => {
    api<typeof skills>("skills.list")
      .then(setSkills)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(
    () => () => {
      void api("ai.cancel").catch(() => {});
    },
    [],
  );
  const selected = snapshot
    ? snapshot.body.slice(snapshot.start, snapshot.end)
    : "";
  async function generate(retry?: StoredTask) {
    if (!snapshot) return;
    const base = { ...snapshot };
    setError("");
    setRunning(true);
    try {
      const result = await api<{ id: string; text: string }>("ai.generate", {
        skillId: retry?.record.skillId || skillId,
        instruction: retry?.snapshot.instruction || instruction,
        retryOf: retry?.record.id,
        context: base.body,
        selectedText: base.body.slice(base.start, base.end),
        target: base,
      });
      setProposalError("");
      setProposal({ id: result.id, text: result.text, base });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="assistant">
      <div className="assistant-heading">
        <h3>
          <Sparkles size={16} />
          写作助理
        </h3>
        <button title="模型设置" onClick={openSettings}>
          <Settings2 size={16} />
        </button>
      </div>
      <label>
        创作方法
        <select
          aria-label="创作方法"
          value={skillId}
          onChange={(e) => setSkillId(e.target.value)}
        >
          {skills.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        这次怎样修改
        <textarea
          aria-label="写作要求"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={8000}
        />
      </label>
      <p className="selection-hint">
        {selected
          ? `已选中 ${Array.from(selected).length} 字`
          : "未选择正文，候选可插入光标位置"}
      </p>
      {running ? (
        <button
          className="cancel-task"
          onClick={() => api("ai.cancel").catch((e) => setError(e.message))}
        >
          <Square size={14} />
          取消生成
        </button>
      ) : (
        <button
          className="primary"
          disabled={!snapshot || !instruction.trim()}
          onClick={() => void generate()}
        >
          <Sparkles size={16} />
          生成候选
        </button>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <button
        className="task-history-trigger"
        onClick={() => setTasksOpen(true)}
      >
        写作任务记录
      </button>
      {tasksOpen && (
        <TaskHistory
          bookId={bookId}
          onClose={() => setTasksOpen(false)}
          openChapter={openChapter}
          retryTarget={snapshot}
          onRetry={
            running
              ? undefined
              : (task) => {
                  setTasksOpen(false);
                  setSkillId(task.record.skillId);
                  setInstruction(task.snapshot.instruction!);
                  void generate(task);
                }
          }
          onReview={(task) => {
            setTasksOpen(false);
            setProposalError("");
            setProposal({
              id: task.record.id,
              text:
                task.record.acceptanceRecovery === "original-text-retained"
                  ? task.record.acceptance?.acceptedText ||
                    task.record.candidate!
                  : task.record.candidate!,
              base: task.snapshot.target!,
            });
          }}
        />
      )}
      {proposal &&
        createPortal(
          <div className="modal-backdrop">
            <div
              className="modal proposal-modal"
              role="dialog"
              aria-modal="true"
              aria-label="审阅 AI 候选"
            >
              <div className="modal-heading">
                <h2>审阅 AI 候选</h2>
                <button
                  aria-label="关闭候选"
                  disabled={applying}
                  onClick={() => setProposal(null)}
                >
                  <X />
                </button>
              </div>
              <p className="muted">
                接受后保存正文，并保留历史版本。正文如有变化，将拒绝替换。关闭窗口后可从写作任务记录找回候选。
              </p>
              <div className="conflict-columns">
                <section>
                  <h3>原文选区</h3>
                  <pre>
                    {proposal.base.body.slice(
                      proposal.base.start,
                      proposal.base.end,
                    ) || "（插入新内容）"}
                  </pre>
                </section>
                <section>
                  <h3>候选文本</h3>
                  <textarea
                    aria-label="候选文本"
                    value={proposal.text}
                    readOnly={applying}
                    onChange={(e) =>
                      setProposal({ ...proposal, text: e.target.value })
                    }
                  />
                </section>
              </div>
              {proposalError && (
                <p role="alert" className="inline-error">
                  {proposalError}
                </p>
              )}
              <div className="modal-actions">
                <button disabled={applying} onClick={() => setProposal(null)}>
                  暂不采用
                </button>
                <button
                  className="primary"
                  disabled={applying || !proposal.text.trim()}
                  onClick={async () => {
                    setApplying(true);
                    setProposalError("");
                    try {
                      if (
                        !(await apply(
                          proposal.base,
                          proposal.text,
                          proposal.id,
                        ))
                      ) {
                        setProposalError(
                          "当前正文或保存状态不允许接受，请保留候选并检查正文提示。",
                        );
                        return;
                      }
                      setProposal(null);
                    } catch (e) {
                      setProposalError(`接受未完成：${(e as Error).message}`);
                    } finally {
                      setApplying(false);
                    }
                  }}
                >
                  {applying ? "正在保存…" : "接受候选"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
