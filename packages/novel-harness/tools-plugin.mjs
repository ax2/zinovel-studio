import { readFile } from "node:fs/promises";
import { atomicWriteText } from "../novel-storage/atomic.mjs";
import { StreamCapture } from "./stream-capture.mjs";
import { TaskBudget } from "./budget.mjs";
import { materialProposal } from "../novel-domain/material-proposal.mjs";
export const name = "zinovel-task-tools";
export const inject = ["tools"];

// Paths come only from the desktop-generated task profile, never model arguments.
export function apply(ctx, config) {
  const budget = config.usagePath
    ? new TaskBudget(config.usagePath, config.budget)
    : undefined;
  if (budget) {
    ctx.on("llm/stream", (options, next) => budget.beforeStream(options, next));
    ctx.on("agent/request", (payload, next) =>
      budget.beforeRequest(payload, next),
    );
    ctx.on("agent/assistant-stream", (payload) => budget.accept(payload));
    ctx.on("agent/turn-stopping", () => budget.flush());
  }
  const stream = config.streamPath
    ? new StreamCapture(config.streamPath)
    : undefined;
  if (stream) {
    ctx.on("agent/assistant-stream", (payload) => stream.accept(payload));
    ctx.on("agent/turn-stopping", () => stream.flush());
  }
  ctx.tools.register({
    name: config.materialTargetEnabled
      ? "novel_material_read"
      : "novel_selection_read",
    description: config.materialTargetEnabled
      ? "读取当前作者授权的冻结资料基线。不能读取其他作品或任意文件。"
      : "读取当前作者授权的冻结正文选区和上下文。不能读取其他作品或任意文件。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        properties: {
          context: { type: "string" },
          selectedText: { type: "string" },
        },
        required: ["context", "selectedText"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("任务已取消");
      if (!args || typeof args !== "object" || Object.keys(args).length)
        throw new Error("读取工具不接受路径或其他参数");
      const { context, selectedText } = JSON.parse(
        await readFile(config.snapshotPath, "utf8"),
      );
      return { context, selectedText };
    },
  });
  ctx.tools.register({
    name: config.materialTargetEnabled
      ? "novel_material_propose"
      : "novel_change_propose",
    description: config.materialTargetEnabled
      ? "提交当前资料的标题、类型字段与笔记候选供作者审阅。不能修改身份、章节引用、作者确认状态或证据，不会保存正式资料。"
      : "提交当前选区的候选文本供作者审阅。不会修改正式稿，不执行保存或发布。",
    parameters: config.materialTargetEnabled
      ? {
          type: "object",
          properties: {
            title: { type: "string" },
            fields: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            notes: { type: "string" },
          },
          required: ["title", "fields", "notes"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { replacement: { type: "string" } },
          required: ["replacement"],
          additionalProperties: false,
        },
    output: {
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: value.status }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error("任务已取消");
      if (config.materialTargetEnabled) {
        const { materialTarget } = JSON.parse(
          await readFile(config.snapshotPath, "utf8"),
        );
        materialProposal(args, materialTarget.input);
        await atomicWriteText(
          config.proposalPath,
          JSON.stringify({ replacement: JSON.stringify(args) }),
        );
        return { status: "awaiting-author-review" };
      }
      if (
        !args ||
        typeof args.replacement !== "string" ||
        !args.replacement.trim() ||
        args.replacement.length > 120000 ||
        Object.keys(args).some((key) => key !== "replacement")
      )
        throw new Error("候选格式无效或超过长度限制");
      await atomicWriteText(
        config.proposalPath,
        JSON.stringify({ replacement: args.replacement }),
      );
      return { status: "awaiting-author-review" };
    },
  });
  if (config.materialContextEnabled)
    ctx.tools.register({
      name: "novel_materials_read",
      description:
        "读取作者为本任务明确选择的冻结资料快照及版本。计划和正文证据分开标记；不能查询其他资料、其他作品或路径。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: { context: { type: "string" } },
          required: ["context"],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.context }],
      },
      async execute(args, exec) {
        if (exec.signal.aborted) throw new Error("任务已取消");
        if (!args || typeof args !== "object" || Object.keys(args).length)
          throw new Error("资料读取不接受路径、作品或查询参数");
        const { materialContext } = JSON.parse(
          await readFile(config.snapshotPath, "utf8"),
        );
        return { context: JSON.stringify(materialContext) };
      },
    });
  // The profile disables every generic tool producer. This global guard also
  // rejects any unexpected future tool even if an upstream default changes.
  ctx.tools.guard((exec) =>
    [
      ...(config.materialTargetEnabled
        ? ["novel_material_read", "novel_material_propose"]
        : ["novel_selection_read", "novel_change_propose"]),
      ...(config.materialContextEnabled ? ["novel_materials_read"] : []),
    ].includes(exec.name)
      ? undefined
      : "此写作任务只授权读取冻结选区和提交候选",
  );
  return async () => {
    await stream?.close();
    await budget?.flush();
  };
}
