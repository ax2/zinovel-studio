export const PROJECT_DOCUMENT_LIMIT = 512;
export const PROJECT_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const PROJECT_TOTAL_BYTES = 32 * 1024 * 1024;

export function projectDocumentKind(path) {
  if (
    typeof path !== "string" ||
    path.length > 220 ||
    !path.isWellFormed() ||
    path !== path.normalize("NFC") ||
    /[\\:\x00-\x1f\x7f]/.test(path)
  )
    throw new Error("创作资产路径无效");
  const parts = path.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /[<>"|?*]/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error("创作资产路径无效");
  if (path === "README.md") return "overview";
  if (/^worldbuilding\/characters\/(?:[^/]+\/)*[^/]+\.md$/.test(path))
    return "character";
  if (/^worldbuilding\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) return "world";
  if (/^outline\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) {
    if (/chapters-detail\.md$/.test(path)) return "detail";
    if (/threads\.md$/.test(path)) return "threads";
    if (/volume[^/]*\.md$/.test(path)) return "volume";
    return "outline";
  }
  if (/^production\/state\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) return "state";
  if (/^production\/reviews\/(?:[^/]+\/)*[^/]+\.md$/.test(path))
    return "review";
  if (/^production\/publish\/(?:[^/]+\/)*[^/]+\.(?:md|yml|yaml)$/.test(path))
    return "publish";
  if (/^assets\/images\/(?:[^/]+\/)*README\.md$/.test(path))
    return "image-registry";
  throw new Error("该路径不属于可编辑的创作资产目录");
}

export function captureProjectDocuments(input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > PROJECT_DOCUMENT_LIMIT
  )
    throw new Error("创作工程需要 1–512 份文档");
  const seen = new Set();
  let bytes = 0;
  return input.map((entry) => {
    const path = entry?.path,
      text = entry?.text;
    const kind = projectDocumentKind(path),
      key = path.toLowerCase();
    if (seen.has(key)) throw new Error("创作资产路径重复");
    seen.add(key);
    if (
      typeof text !== "string" ||
      !text.isWellFormed() ||
      text.includes("\0") ||
      Buffer.byteLength(text) > PROJECT_DOCUMENT_BYTES
    )
      throw new Error("创作资产须为完整 UTF-8 文本，单份不超过 8 MiB");
    bytes += Buffer.byteLength(text);
    if (bytes > PROJECT_TOTAL_BYTES) throw new Error("创作资产总量超过 32 MiB");
    return { path, kind, text };
  });
}

export function projectScaffold(title) {
  const note = "\n> 待填写的创作模板；不是已生成或已审定的小说内容。\n\n";
  return captureProjectDocuments(
    [
      [
        "README.md",
        `# ${title}\n${note}## 创作目标\n\n## 工程目录\n\nworldbuilding：世界与人物；outline：总纲、分卷、细纲与伏笔；production：当前状态、审读与发布；assets/images：图像登记。\n`,
      ],
      [
        "worldbuilding/world.md",
        `# 世界设定${note}## 时空与规则\n\n## 地理与地图\n\n## 组织、资源与限制\n`,
      ],
      [
        "worldbuilding/style.md",
        `# 叙事风格${note}## 视角与时态\n\n## 语言、对白与禁忌\n`,
      ],
      [
        "worldbuilding/characters/README.md",
        `# 人物目录${note}人物卡分文件保存，记录欲望、阻力、关系、声音、变化与定妆图引用。\n`,
      ],
      [
        "outline/master-plan.md",
        `# 全书总纲${note}## 类型与核心承诺\n\n## 主线、代价与结局\n\n## 预期总字数\n`,
      ],
      ["outline/volumes-overview.md", `# 分卷总览${note}## 卷目标与转折\n`],
      [
        "outline/threads.md",
        `# 主支线与伏笔${note}## 主线\n\n## 支线\n\n## 伏笔：计划、实际埋设与回收证据\n`,
      ],
      [
        "outline/volume-01-chapters.md",
        `# 第一卷章纲${note}## 章节目标、冲突与局面变化\n`,
      ],
      [
        "outline/volume-01-chapters-detail.md",
        `# 第一卷细纲${note}## 场景、视角、动机、阻力与章尾\n`,
      ],
      [
        "production/state/current-state.md",
        `# 当前状态${note}## 已写进度\n\n## 人物、资源、认知与未回收事项\n\n## 下一章交接\n`,
      ],
      [
        "production/reviews/README.md",
        `# 审读记录${note}记录审读范围、版本、问题、修改和复读结论。\n`,
      ],
      [
        "production/publish/README.md",
        `# 发布资产${note}记录发布元数据与回执，不保存凭据。小说站章节发布旁车使用 chapter-NNN.frontmatter.yml。\n`,
      ],
      [
        "assets/images/README.md",
        `# 图像登记${note}## 封面、地图、人物定妆与章节插图\n\n记录用途、权利、文件与版本。\n`,
      ],
    ].map(([path, text]) => ({ path, text })),
  );
}
