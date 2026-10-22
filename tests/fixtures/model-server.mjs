import { createServer } from "node:http";
export async function modelFixture({
  delayMs = 0,
  beforeReply,
  streamText,
  afterText,
} = {}) {
  const requests = [];
  const replacement = "灯塔熄灭时，林舟终于拆开了旧信。";
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const last = body.messages.at(-1),
        results = last?.content || [];
      const previousTool = results.find?.(
        (block) => block.type === "tool_result",
      );
      let block, stop;
      if (typeof streamText === "string") {
        block = { type: "text", text: streamText };
        stop = "end_turn";
      } else if (!previousTool) {
        block = {
          type: "tool_use",
          id: "read-selection",
          name: "novel_selection_read",
          input: {},
        };
        stop = "tool_use";
      } else if (previousTool.tool_use_id === "read-selection") {
        block = {
          type: "tool_use",
          id: "propose-selection",
          name: "novel_change_propose",
          input: { replacement },
        };
        stop = "tool_use";
      } else {
        block = { type: "text", text: "候选已提交，请作者审阅。" };
        stop = "end_turn";
      }
      const events = [
        {
          type: "message_start",
          message: {
            id: `fixture-${requests.length}`,
            model: "deepseek-v4-flash",
            usage: { input_tokens: 30, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block:
            block.type === "text"
              ? { type: "text", text: "" }
              : { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: stop },
          usage: { output_tokens: 18 },
        },
        { type: "message_stop" },
      ];
      await beforeReply?.(requests.length);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "content_block_delta" && block.type === "text")
          await afterText?.(requests.length);
      }
      response.end();
    } catch {
      response.writeHead(500).end("fixture failure");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    replacement,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
