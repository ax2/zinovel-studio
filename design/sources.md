# 来源与方法适配记录

核实日期：2026-10-22。

## 官方资料

- [DeepSeek Harness 官网](https://www.deepseek.com/en/harness/)与[官方桌面下载](https://www.deepseek.com/download/)。
- [官方桌面说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/README.md)。
- [桌面 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/package.json)、[Host 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/host-process.ts)、[preload](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/preload-app.ts)、[包集合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/core-package-set.ts)。
- [官方许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。

只把上述已查看内容作为事实证据；小说专用 UI/工具/数据设计是本项目建议，不声称官方已有这些功能。

## 本地写作技能（只记录名称和相对文件，不发布私人路径/稿件）

| 来源 | 本次使用 | 处理差异 |
| --- | --- | --- |
| write-chinese-fiction/SKILL.md | 创作全循环、作者意图、正文事实与交付状态 | 新编写便携小说技能 |
| references/story-design.md | 类型承诺、主支线、能力代价、长篇规模 | 允许发现式写作和近期细纲 |
| references/continuity-and-delivery.md | 正典、检查点、版本和导出证据 | 转为实体版本与状态机 |
| references/reader-review.md | 先正文后作者答案、真实阅读覆盖、改后复读 | 转为盲读/复读工作流 |
| zicode-novel-book-pipeline/SKILL.md | 创意到正文、人物地图图像、站点资源与发布职责 | 不复制私人部署配置；固定阈值和文风可配 |
| zicode-novel-picker/SKILL.md | 句法/结构分开、正文抽读范围、同质化诊断 | 不采用未复核市场数据作为产品事实 |
| books/_shared/templates/*.template.md | 人物、总纲、卷纲、细纲和线索字段 | 不采用固定六卷/六十章等示例为默认事实 |
| skill-creator/SKILL.md | 短技能、精准触发、按需加载、能力边界与基础校验 | 项目内新编写，未安装到全局环境 |

## 本轮决策

先排查本地 DSH 插件工作区与 ZiCode；发现社区桌面名称容易混淆。用户澄清后查证官方 monorepo 中已有 desktop，因此采用官方路线。没有修改上述参考项目，也没有复制小说原文、图像或凭据。
