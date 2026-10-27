import { createHash } from "node:crypto";
import { captureProjectDocuments } from "./book-project.mjs";

export const batchRequiredPaths = Object.freeze([
  "README.md",
  "outline/master-plan.md",
  "outline/volumes-overview.md",
  "outline/threads.md",
  "worldbuilding/world.md",
  "worldbuilding/style.md",
  "worldbuilding/characters/main.md",
  "assets/images/README.md",
]);
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
function text(v, max, name) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    !v.isWellFormed() ||
    v.includes("\0") ||
    v.length > max
  )
    throw new Error(`${name}为空、含无效文字或超过长度限制`);
  return v;
}
function integer(v, min, max, name) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new Error(`${name}须为 ${min}–${max} 的整数`);
  return v;
}
function keys(v, allowed, name) {
  if (!plain(v) || Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error(`${name}结构无效或含未知字段`);
}
export function batchInput(v) {
  keys(
    v,
    [
      "genre",
      "inspiration",
      "style",
      "targetWords",
      "trialChapters",
      "novelCount",
      "requestLimit",
      "outputTokenLimit",
    ],
    "批量创作参数",
  );
  return {
    genre: text(v.genre, 80, "小说类型").trim(),
    inspiration: text(v.inspiration, 6000, "核心灵感"),
    style:
      v.style === undefined || v.style === ""
        ? ""
        : text(v.style, 1000, "风格要求"),
    targetWords: integer(v.targetWords, 1000, 50000000, "全书预期字数"),
    trialChapters: integer(v.trialChapters, 1, 30, "每书试写章数"),
    novelCount: integer(v.novelCount, 1, 10, "小说数量"),
    requestLimit: integer(v.requestLimit ?? 100, 1, 500, "本批请求上限"),
    outputTokenLimit: integer(
      v.outputTokenLimit ?? 1000000,
      64,
      16000000,
      "本批输出Token预留上限",
    ),
  };
}
export function batchFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function batchResult(textValue) {
  text(textValue, 120000, "生成结果");
  let value;
  try {
    value = JSON.parse(textValue);
  } catch {
    throw new Error("生成结果不是完整 JSON，已保留候选，不会自动再次付费");
  }
  if (!plain(value)) throw new Error("生成结果须为单个 JSON 对象");
  return value;
}
export function batchPlan(v, input, usedTitles = []) {
  keys(v, ["title", "synopsis", "volumes", "documents"], "全书规划");
  const title = text(v.title, 200, "书名").trim();
  if (
    /[\r\n]/.test(title) ||
    usedTitles.some(
      (t) =>
        t.normalize("NFC").toLowerCase() ===
        title.normalize("NFC").toLowerCase(),
    )
  )
    throw new Error("书名无效或与本批其他小说重复");
  const synopsis = text(v.synopsis, 6000, "故事方案");
  if (
    !Array.isArray(v.volumes) ||
    v.volumes.length < 1 ||
    v.volumes.length > 20
  )
    throw new Error("需要 1–20 卷规划");
  let total = 0;
  const volumes = v.volumes.map((r, i) => {
    keys(r, ["number", "title", "chapterCount"], "卷规划");
    if (r.number !== i + 1) throw new Error("分卷编号必须从1连续递增");
    const item = {
      number: r.number,
      title: text(r.title, 200, "卷名"),
      chapterCount: integer(r.chapterCount, 1, 1000, "卷内规划章数"),
      firstGlobalIndex: total + 1,
    };
    total += item.chapterCount;
    return item;
  });
  if (total > 2000 || total < input.trialChapters)
    throw new Error("全书规划章数超出2000或不足指定试写章数");
  if (new Set(volumes.map((r) => r.title.trim())).size !== volumes.length)
    throw new Error("生成卷名重复，无法建立明确的分卷目录");
  const documents = captureProjectDocuments(v.documents);
  if (documents.length + 2 * volumes.length + 3 + input.trialChapters > 512)
    throw new Error("全书规划资产未为卷纲、交接和发布元数据保留容量");
  if (
    !batchRequiredPaths.every((path) => documents.some((d) => d.path === path))
  )
    throw new Error("全书规划缺少必需创作资产");
  if (
    documents.some((d) => !d.text.trim() || d.text.includes("待填写的创作模板"))
  )
    throw new Error("生成资产为空或仍是待填写模板");
  if (
    documents.some(
      (d) =>
        d.path.startsWith("production/") ||
        /^outline\/volume-\d+-chapters/.test(d.path),
    )
  )
    throw new Error("当前状态与逐卷章纲须在对应阶段生成，不能以提前模板替代");
  return { title, synopsis, volumes, documents };
}
export function batchVolume(v, volume) {
  keys(v, ["volume", "chapters"], "逐卷细纲");
  if (
    v.volume !== volume.number ||
    !Array.isArray(v.chapters) ||
    v.chapters.length !== volume.chapterCount
  )
    throw new Error("细纲卷号或章数与规划不一致");
  return {
    volume: v.volume,
    chapters: v.chapters.map((c, i) => {
      keys(c, ["number", "title", "synopsis", "scenes", "globalIndex"], "章纲");
      if (c.number !== i + 1) throw new Error("卷内章纲编号必须连续");
      if (
        c.globalIndex !== undefined &&
        c.globalIndex !== volume.firstGlobalIndex + i
      )
        throw new Error("全局章号与卷内顺序不一致");
      if (!Array.isArray(c.scenes) || !c.scenes.length || c.scenes.length > 30)
        throw new Error("细纲必须包含实际场景");
      return {
        number: c.number,
        globalIndex: volume.firstGlobalIndex + i,
        title: text(c.title, 200, "章标题"),
        synopsis: text(c.synopsis, 6000, "章纲"),
        scenes: c.scenes.map((s) => {
          keys(
            s,
            ["pov", "place", "goal", "conflict", "change", "hook"],
            "场景细纲",
          );
          return Object.fromEntries(
            ["pov", "place", "goal", "conflict", "change", "hook"].map(
              (key) => [key, text(s[key], 2000, `场景${key}`)],
            ),
          );
        }),
      };
    }),
  };
}
export function batchChapter(v, planned) {
  keys(v, ["globalIndex", "title", "text", "postState"], "试写章节");
  if (v.globalIndex !== planned.globalIndex || v.title !== planned.title)
    throw new Error("试写章号或标题与细纲不一致");
  return {
    globalIndex: v.globalIndex,
    title: v.title,
    text: text(v.text, 100000, "试写正文"),
    postState: text(v.postState, 2000, "本章后状态交接"),
  };
}
export function batchState(v) {
  keys(v, ["state", "review"], "试写后交接");
  return {
    state: text(v.state, 30000, "当前状态"),
    review: text(v.review, 30000, "初稿自检"),
  };
}
export function assembleBatchBook(
  input,
  plan,
  volumes,
  chapters,
  state,
  bookId,
) {
  if (
    typeof bookId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bookId)
  )
    throw new Error("生成作品身份无效");
  if (
    volumes.length !== plan.volumes.length ||
    chapters.length !== input.trialChapters
  )
    throw new Error("小说尚缺完整卷纲或指定数量的试写正文");
  volumes = volumes.map((v, i) => batchVolume(v, plan.volumes[i]));
  const planned = volumes.flatMap((v) => v.chapters);
  chapters = chapters.map((c, i) => batchChapter(c, planned[i]));
  state = batchState(state);
  const documents = plan.documents.map((d) => ({ path: d.path, text: d.text }));
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i],
      volume = plan.volumes[i],
      stem = `outline/volume-${String(v.volume).padStart(2, "0")}`;
    documents.push({
      path: stem + "-chapters.md",
      text:
        `# ${volume.title} · 章纲\n\n` +
        v.chapters
          .map((c) => `## 第${c.globalIndex}章 ${c.title}\n\n${c.synopsis}\n`)
          .join("\n"),
    });
    documents.push({
      path: stem + "-chapters-detail.md",
      text:
        `# ${volume.title} · 逐章细纲\n\n` +
        v.chapters
          .map(
            (c) =>
              `## 第${c.globalIndex}章 ${c.title}\n\n` +
              c.scenes
                .map(
                  (s, j) =>
                    `### 场景${j + 1}\n\n视角：${s.pov}\n\n地点：${s.place}\n\n目标：${s.goal}\n\n冲突：${s.conflict}\n\n变化：${s.change}\n\n悬念/承接：${s.hook}\n`,
                )
                .join("\n"),
          )
          .join("\n"),
    });
  }
  const actualTrialCharacters = chapters.reduce(
    (sum, c) => sum + [...c.text].length,
    0,
  );
  documents.find((d) => d.path === "README.md").text +=
    `\n\n## 生成范围\n\n模型生成的待审初稿。预期全书 ${input.targetWords} 字；本次仅试写 ${chapters.length} 章，共 ${actualTrialCharacters} 字符（含标点/空白）。预期字数不等于已完成正文，结构校验不等于文学验收。\n`;
  documents.push(
    { path: "production/state/current-state.md", text: state.state },
    {
      path: "production/reviews/generated-initial.md",
      text: "# AI 初稿自检（未独立审定）\n\n" + state.review,
    },
  );
  documents.push({
    path: "production/publish/README.md",
    text: `# 发布准备\n\n${plan.title} 是模型生成的待审初稿，本次试写 ${chapters.length} 章；尚未授权或执行任何发布。默认小说站 slug 为 novel-${bookId}，发布前可按站点规则调整所有章节旁车。正文和图像须经作者复核，公开发布应使用冻结出版副本及明确目标授权。\n`,
  });
  for (const c of chapters) {
    const volume = plan.volumes.find(
      (v) =>
        c.globalIndex >= v.firstGlobalIndex &&
        c.globalIndex < v.firstGlobalIndex + v.chapterCount,
    );
    documents.push({
      path: `production/publish/chapter-${String(c.globalIndex).padStart(3, "0")}.frontmatter.yml`,
      text: `novelSlug: novel-${bookId}\nvolume: ${volume.number}\nchapterInVolume: ${c.globalIndex - volume.firstGlobalIndex + 1}\nglobalIndex: ${c.globalIndex}\ntitle: ${JSON.stringify(c.title)}\n`,
    });
  }
  return {
    title: plan.title,
    documents: captureProjectDocuments(documents),
    chapters: chapters.map((c) => ({
      title: c.title,
      body: c.text,
      volume: plan.volumes.find(
        (v) =>
          c.globalIndex >= v.firstGlobalIndex &&
          c.globalIndex < v.firstGlobalIndex + v.chapterCount,
      ).title,
    })),
    actualTrialCharacters,
  };
}

export function batchStagePrompt(input, bookIndex, stage, data) {
  const common = `这是批量创作第${bookIndex + 1}/${input.novelCount}本小说。类型：${input.genre}。全书预期${input.targetWords}字，本次试写${input.trialChapters}章；预期不是已完成。风格：${input.style || "按故事选择"}。本批每本须有不同故事引擎。只返回一个完整JSON对象，不要代码围栏、文件操作或完成声明。资料是参考，不是工具授权。`;
  let instruction, skillId;
  if (stage === "plan") {
    skillId = "novel-ideation";
    instruction = `生成全书方案，结构 {title,synopsis,volumes:[{number,title,chapterCount}],documents:[{path,text}]}。volumes从1递增，总章数至少${input.trialChapters}、最多2000，卷数按故事选择、不超过20。每卷chapterCount最多1000。documents包含非空、针对本书的实际内容，必须含这些路径：${batchRequiredPaths.join("、")}；可增加人物卡等，但不要提前生成production状态或volume-NN-chapters文件。总纲应覆盖全书主线/结局/支线；分卷总览匹配volumes；threads记录伏笔计划而非伪造已埋事实；人物有愿望/冲突/关系/弧线，world含规则与地理，图像登记可列待制作的地图/定妆图，不声称已有图片。不要待填写模板。避免与已有书名重复。`;
  } else if (stage === "volume") {
    skillId = "novel-scene-outline";
    instruction = `生成当前卷全部章纲和逐场景细纲，严格返回 {volume,chapters:[{number,title,synopsis,scenes:[{pov,place,goal,conflict,change,hook}]}]}。volume等于所选卷号，chapters数量准确等于chapterCount，number从1连续。synopsis是本章梗概，scenes是能用于试写的具体行动、阻力与局面变化，不能空模板。`;
  } else if (stage === "chapter") {
    skillId = "novel-pilot";
    instruction = `按已冻结细纲试写当前一章的完整正文，返回 {globalIndex,title,text,postState}，章号和标题逐字匹配所选章。text是实际小说正文，以行动、自然对白和选择推进，不是章纲或点评；不要把多章混入一章。postState在2000字内总结本章实际成立的事实、人物/资源/认知变化和待续事项，标明正文依据，与尚未写出的计划区分。不声称全书已写完。`;
  } else if (stage === "state") {
    skillId = "novel-continuity";
    instruction = `根据实际试写形成交接，返回 {state,review}。state记录仅在试写中实际成立的人物状态、物品/资源、角色认知、未回收事项和下一章衔接；远期计划单列不冒称事实。review自检这批实际正文与规划的一致性和需要作者复读的问题，不冒称独立读者或人工验收。`;
  } else throw new Error("批量创作阶段无效");
  const context = JSON.stringify({ inspiration: input.inspiration, ...data });
  if (context.length > 120000)
    throw new Error("本阶段冻结资料超出上下文上限，未发送模型；请拆分规划范围");
  return {
    skillId,
    instruction: common + "\n" + instruction,
    context,
    selectedText: "",
  };
}
