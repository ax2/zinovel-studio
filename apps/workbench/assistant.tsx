import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Settings2, Sparkles, X, Square } from "lucide-react";
import { api } from "./api";
import { ProfilesPanel } from "./profiles-panel";
import { useModelChoice, ModelChoiceNotice } from "./model-choice";
import { modelServiceURL } from "../../packages/novel-domain/model-service.mjs";
import { TaskHistory, type StoredTask } from "./task-history";
import { CandidateReview } from "./candidate-review";
import { ContextSelector, type ContextSelection } from "./context-selector";
import { reviewContent } from "../../packages/novel-domain/review-content.mjs";
import {
  BudgetSettingsEditor,
  formatCost,
  type BudgetSettings,
} from "./budget-settings";

type Settings = {
  baseURL: string;
  model: string;
  hasKey: boolean;
  encryptionAvailable: boolean;
  budget: BudgetSettings;
  credentialMismatch?: boolean;
  profilesEnabled?: boolean;
};
export function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Settings | null>(null),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [profiles, setProfiles] = useState(false);
  const savedService = useRef<string | null>(null);
  function adopt(value: Settings) {
    savedService.current = value.baseURL;
    setConfig(value);
    if (value.profilesEnabled) setProfiles(true);
  }
  let endpointChanged = false;
  if (config && savedService.current) {
    try {
      endpointChanged =
        modelServiceURL(config.baseURL) !== savedService.current;
    } catch {
      endpointChanged = true;
    }
  }
  useEffect(() => {
    api<Settings>("settings.get")
      .then(adopt)
      .catch((e) => setError(e.message));
  }, []);
  if (profiles) return <ProfilesPanel onClose={onClose} />;
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
            window.dispatchEvent(new Event("novel-settings-changed"));
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
          运行。开始生成时，选区、当前章节和你明确选择的资料快照会发送到你配置的模型服务。
        </p>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setKey("");
            setProfiles(true);
          }}
        >
          管理多个模型与能力
        </button>
        {config && (
          <>
            <label>
              服务地址
              <input
                value={config.baseURL}
                onChange={(e) => {
                  setKey("");
                  setConfig({
                    ...config,
                    baseURL: e.target.value,
                    budget: { ...config.budget, pricing: null, maxCost: 0 },
                  });
                }}
              />
            </label>
            {endpointChanged && (
              <p role="status" className="muted">
                服务地址已更改；留空保存会清除旧服务的密钥，请为新服务重新输入。修改地址也会清空尚未保存的Key。
              </p>
            )}
            {config.credentialMismatch && (
              <p role="alert" className="inline-error">
                服务地址与已保存凭据不匹配，旧密钥不会发送；请明确重新输入或清除。
              </p>
            )}
            <label>
              模型名称
              <input
                value={config.model}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    model: e.target.value,
                    budget: { ...config.budget, pricing: null, maxCost: 0 },
                  })
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
                  endpointChanged
                    ? "新服务需重新输入Key；留空会清除旧Key"
                    : config.hasKey
                      ? "已安全保存，留空保持原值"
                      : "输入 API Key"
                }
              />
            </label>
            <p className="muted">
              凭据使用系统安全存储加密，界面不会读回已有密钥。
            </p>
            <BudgetSettingsEditor
              value={config.budget}
              onChange={(budget) => setConfig({ ...config, budget })}
            />
            {(config.hasKey || config.credentialMismatch) && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    adopt(
                      await api("settings.save", { ...config, clearKey: true }),
                    );
                    setKey("");
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
  const model = useModelChoice();
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
      initialText?: string;
      reviewRevision?: number;
      reviewDraftError?: string;
      hasSavedDraft?: boolean;
    } | null>(null);
  const [materialSelection, setMaterialSelection] = useState<ContextSelection>({
    ready: true,
    ids: [],
    pack: null,
  });
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
  const [preview, setPreview] = useState<{
    inputTokens: number;
    outputTokenCap: number;
    projectedCost: number | null;
    currency?: string;
  } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    const changed = () => setPreviewRevision((value) => value + 1);
    window.addEventListener("novel-settings-changed", changed);
    return () => window.removeEventListener("novel-settings-changed", changed);
  }, []);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewFailed(false);
    if (!snapshot || !model.ready) return;
    const timer = setTimeout(() => {
      api<NonNullable<typeof preview>>("ai.estimate", {
        modelChoice: model.choice,
        skillId,
        instruction,
        context: snapshot.body,
        selectedText: selected,
        bookId,
        materialIds: materialSelection.ids,
      })
        .then((value) => {
          if (active) setPreview(value);
        })
        .catch(() => {
          if (active) setPreviewFailed(true);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    snapshot?.body,
    selected,
    instruction,
    skillId,
    previewRevision,
    materialSelection.pack?.hash,
    materialSelection.ready,
    model.ready,
    model.choice?.diskHash,
  ]);
  async function generate(retry?: StoredTask) {
    if (!snapshot || !materialSelection.ready || !model.ready) return;
    const base = { ...snapshot };
    setError("");
    setRunning(true);
    try {
      const result = await api<{ id: string; text: string }>("ai.generate", {
        modelChoice: model.choice,
        skillId: retry?.record.skillId || skillId,
        instruction: retry?.snapshot.instruction || instruction,
        retryOf: retry?.record.id,
        context: base.body,
        selectedText: base.body.slice(base.start, base.end),
        target: base,
        materialIds: materialSelection.ids,
        materialContextHash: materialSelection.pack?.hash,
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
      <ModelChoiceNotice value={model} />
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
      <ContextSelector
        bookId={bookId}
        disabled={running}
        onChange={setMaterialSelection}
      />
      {preview && (
        <p className="generation-estimate" aria-label="生成前预算预览">
          作者材料约 {preview.inputTokens} Token；每步输出上限{" "}
          {preview.outputTokenCap} Token。
          <br />
          {preview.projectedCost === null
            ? "费用未知：未配置完整单价。"
            : `材料加输出上限参考 ${formatCost(preview.projectedCost)} ${preview.currency}。`}
          <br />
          不含待装配的系统与工具部分；完整请求会在发送前再次估算，多步任务会累计消耗。
        </p>
      )}
      {previewFailed && (
        <p className="generation-estimate">
          暂时无法预估；开始任务时仍会执行预算检查。
        </p>
      )}
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
          disabled={
            !snapshot ||
            !instruction.trim() ||
            !materialSelection.ready ||
            !model.ready
          }
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
              text: task.record.candidate!,
              initialText: reviewContent(task).text,
              hasSavedDraft: reviewContent(task).source === "saved-review",
              reviewRevision: task.reviewDraft?.revision || 0,
              reviewDraftError: task.reviewDraftError,
              base: task.snapshot.target!,
            });
          }}
        />
      )}
      {proposal &&
        createPortal(
          <CandidateReview
            key={proposal.id}
            original={proposal.base.body.slice(
              proposal.base.start,
              proposal.base.end,
            )}
            candidate={proposal.text}
            initialText={proposal.initialText}
            hasSavedDraft={proposal.hasSavedDraft}
            applying={applying}
            error={proposalError || proposal.reviewDraftError || ""}
            onClose={() => setProposal(null)}
            onSave={
              proposal.reviewDraftError
                ? undefined
                : async (text) => {
                    const result = await api<{ revision: number }>(
                      "ai.saveReview",
                      {
                        id: proposal.id,
                        text,
                        expectedRevision: proposal.reviewRevision || 0,
                      },
                    );
                    setProposal((current) =>
                      current?.id === proposal.id
                        ? { ...current, reviewRevision: result.revision }
                        : current,
                    );
                  }
            }
            onAccept={async (text) => {
              setApplying(true);
              setProposalError("");
              try {
                if (!(await apply(proposal.base, text, proposal.id))) {
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
          />,
          document.body,
        )}
    </section>
  );
}
