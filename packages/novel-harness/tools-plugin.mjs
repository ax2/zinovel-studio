import { readFile } from "node:fs/promises";
import { atomicWriteText } from "../novel-storage/atomic.mjs";
export const name = "zinovel-task-tools";
export const inject = ["tools"];

// Paths come only from the desktop-generated task profile, never model arguments.
export function apply(ctx, config) {
  ctx.tools.register({
    name: "novel_selection_read",
    description:
      "读取当前作者授权的冻结正文选区和上下文。不能读取其他作品或任意文件。",
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
    name: "novel_change_propose",
    description:
      "提交当前选区的候选文本供作者审阅。不会修改正式稿，不执行保存或发布。",
    parameters: {
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
  // The profile disables every generic tool producer. This global guard also
  // rejects any unexpected future tool even if an upstream default changes.
  ctx.tools.guard((exec) =>
    ["novel_selection_read", "novel_change_propose"].includes(exec.name)
      ? undefined
      : "此写作任务只授权读取冻结选区和提交候选",
  );
}
