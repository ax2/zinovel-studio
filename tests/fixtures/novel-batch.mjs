import { batchRequiredPaths } from "../../packages/novel-domain/novel-batch.mjs";
export const inspiration = {
  genre: "悬疑幻想",
  inspiration: "雾港的信使发现未送达的旧信来自未来。",
  targetWords: 80000,
  trialChapters: 2,
  novelCount: 2,
  requestLimit: 30,
  outputTokenLimit: 300000,
};
export const batchSettings = {
  baseURL: "https://example.test/anthropic",
  model: "synthetic-no-network",
  budget: { maxOutputTokens: 2048 },
};
export function generatedStage(bookIndex, stage) {
  if (stage === "plan")
    return {
      title: `合成雾港${bookIndex + 1}`,
      synopsis: `信使${bookIndex + 1}为送信必须交换一段记忆，最终选择保住他人的证词。`,
      volumes: [
        { number: 1, title: "第一卷 雾中旧信", chapterCount: 1 },
        { number: 2, title: "第二卷 归航选择", chapterCount: 1 },
      ],
      documents: batchRequiredPaths.map((path) => ({
        path,
        text: `# ${path}\n\n这是第${bookIndex + 1}本的实际合成策划内容：主角送信遭到阻拦，规则限制他保留证词，伏笔计划回收于归航，人物选择要付出记忆的代价。𠮷\n`,
      })),
    };
  if (stage.startsWith("volume-")) {
    const n = Number(stage.split("-")[1]);
    return {
      volume: n,
      chapters: [
        {
          number: 1,
          title: `渡口${n}`,
          synopsis: `信使在渡口${n}受阻，以旧证词换取船票。`,
          scenes: [
            {
              pov: "信使",
              place: "渡口",
              goal: "把旧信交给证人",
              conflict: "摆渡人拒绝通行",
              change: "交出记忆换船票",
              hook: "收信人已经失踪",
            },
          ],
        },
      ],
    };
  }
  if (stage.startsWith("chapter-")) {
    const n = Number(stage.split("-")[1]);
    return {
      globalIndex: n,
      title: `渡口${n}`,
      text: `船绳绷紧时，信使${bookIndex + 1}把旧信藏进袖中。“你要去哪里？”摆渡人拦住他。“见一个欠我证词的人。”他递出船票，票面却慢慢浮出自己的名字。𠮷🌊\n`,
      postState: `第${n}章：信使交出记忆取得船票；旧信尚未送达，收信人失踪。船票出现自己的名字是未解悬念。`,
    };
  }
  return {
    state:
      "# 当前状态\n已试写两章；旧信尚未送达，信使持有船票。下一章须核对记忆代价。",
    review:
      "试写初稿尚需独立读者复读，注意两章的递进与重复，不能把远期结局写成已完成。",
  };
}
