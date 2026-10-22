import React from "react";
export type Pricing = {
  currency: "CNY" | "USD";
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
};
export type BudgetSettings = {
  maxSteps: number;
  maxContextCharacters: number;
  maxOutputTokens: number;
  maxReportedTokens: number;
  maxEstimatedInputTokens: number;
  maxCost: number;
  pricing: Pricing | null;
};
export function formatCost(value: number) {
  return value > 0 && value < 0.000001
    ? value.toExponential(3)
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}
export function BudgetSettingsEditor({
  value,
  onChange,
}: {
  value: BudgetSettings;
  onChange: (value: BudgetSettings) => void;
}) {
  return (
    <details className="budget-settings">
      <summary>每次写作任务的预算</summary>
      <p className="muted">
        预算和单价在新任务开始时冻结。超额后停止后续调用，已保存结果保留。估算不是精确计费，进行中的一次调用可能超过阈值。
      </p>
      {(
        [
          ["maxSteps", "模型步骤上限", 1, 64],
          ["maxContextCharacters", "章节上下文字符上限", 100, 120000],
          ["maxOutputTokens", "每步输出 Token 上限", 64, 32768],
          ["maxReportedTokens", "已回报 Token 上限（0 为不启用）", 0, 1000000],
          [
            "maxEstimatedInputTokens",
            "每步预估输入 Token 上限（0 为不启用）",
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
            value={value[field]}
            onChange={(e) =>
              onChange({ ...value, [field]: Number(e.target.value) })
            }
          />
        </label>
      ))}
      <p className="muted">
        输入预估包含完整消息和工具定义，使用官方启发式估算。供应商内部网络重试不等同于模型步骤；启用已回报上限后，未回报用量也会停止下一步。
      </p>
      <label className="price-toggle">
        <input
          type="checkbox"
          checked={!!value.pricing}
          onChange={(e) =>
            onChange({
              ...value,
              maxCost: 0,
              pricing: e.target.checked
                ? {
                    currency: "CNY",
                    inputPerMillion: null,
                    outputPerMillion: null,
                    cacheReadPerMillion: null,
                    cacheWritePerMillion: null,
                  }
                : null,
            })
          }
        />
        为当前模型配置价格
      </label>
      {value.pricing && (
        <>
          <label>
            价格币种
            <select
              value={value.pricing.currency}
              onChange={(e) =>
                onChange({
                  ...value,
                  pricing: {
                    ...value.pricing!,
                    currency: e.target.value as Pricing["currency"],
                  },
                })
              }
            >
              <option value="CNY">人民币 CNY</option>
              <option value="USD">美元 USD</option>
            </select>
          </label>
          {(
            [
              ["inputPerMillion", "非缓存输入单价 / 百万 Token"],
              ["outputPerMillion", "输出单价 / 百万 Token"],
              ["cacheReadPerMillion", "缓存读取单价 / 百万 Token"],
              ["cacheWritePerMillion", "缓存写入单价 / 百万 Token"],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                min={0}
                max={1000000}
                step="any"
                placeholder="未知，留空"
                value={value.pricing![field] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    pricing: {
                      ...value.pricing!,
                      [field]:
                        e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
          <label>
            每任务费用阈值（0 为不启用）
            <input
              type="number"
              min={0}
              max={1000000}
              step="any"
              required
              value={value.maxCost}
              onChange={(e) =>
                onChange({ ...value, maxCost: Number(e.target.value) })
              }
            />
          </label>
          <p className="muted">
            单价由你维护，修改地址或模型会清空价格。启用费用阈值需填写四项价格；按已知用量加下一次请求估算检查，未知费用阻止继续。实际账单以服务商为准。
          </p>
        </>
      )}
    </details>
  );
}
