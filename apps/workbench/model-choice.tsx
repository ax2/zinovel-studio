import React, { useEffect, useState } from "react";
import { api } from "./api";

export type ModelChoice = { revision: number; diskHash: string };
type VisibleModel = {
  model: string;
  hasKey: boolean;
  credentialMismatch?: boolean;
  profilesEnabled?: boolean;
  profileLabel?: string;
  modelChoice?: ModelChoice | null;
};

// Keep the revision that was displayed. The host rejects a stale revision before
// decrypting credentials; fetching a fresh choice inside generate would bypass it.
export function useModelChoice() {
  const [value, setValue] = useState<VisibleModel | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const changed = () => setReload((n) => n + 1);
    window.addEventListener("novel-settings-changed", changed);
    return () => window.removeEventListener("novel-settings-changed", changed);
  }, []);
  useEffect(() => {
    let live = true;
    setValue(null);
    setError("");
    api<VisibleModel>("settings.get").then(
      (next) => {
        if (live) setValue(next);
      },
      (e) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [reload]);
  return {
    ready:
      !!value &&
      !value.credentialMismatch &&
      (!value.profilesEnabled || (!!value.modelChoice && !!value.model)),
    choice: value?.profilesEnabled ? value.modelChoice : undefined,
    label: value
      ? `${value.profileLabel || "文字模型"} · ${value.model || "未选择"}`
      : "读取模型配置中…",
    error,
    refresh: () => setReload((n) => n + 1),
  };
}
export function ModelChoiceNotice({
  value,
}: {
  value: ReturnType<typeof useModelChoice>;
}) {
  return (
    <div className="generation-estimate" aria-label="本次文字模型">
      <span>{value.label}</span>
      {value.error && <p role="alert">{value.error}</p>}
      <button type="button" onClick={value.refresh}>
        刷新模型选择
      </button>
    </div>
  );
}
