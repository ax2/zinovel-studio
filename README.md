# ZiNovel Studio

以小说为中心的本地 AI 创作工作台。基于官方开源 **DeepSeek Harness Desktop + DeepSeek Harness Agent** 规划，覆盖创意、试写、规划、设定、正文编辑、连续性、插图、审读及发布。

**当前状态：Stage-000 立项与设计。已有产品规格、技术决策、功能目录和首批技能源文件；桌面应用、Agent 接入、编辑器、工具执行器及发布适配器均尚未实现。没有可运行 EXE。**

## 产品方向

- 一个书库管理多部小说，每部书独立保存卷、章、场景、人物、世界、主支线、伏笔与图像。
- 作者直接编辑正文；选中一段即可让 AI 润色、扩写、缩写、改对白或提供多个版本，按差异接受与撤销。
- 长篇记忆来自带版本和正文出处的事实；区分计划、候选设定、已成立事实与失效记录。
- 手工写作、阅读和本地保存可离线工作，云模型按需调用；正文不进入本项目的公开代码仓库。
- 只内置写小说需要的能力。不捆绑金融、消息、通用办公、开发者平台、通用终端、插件市场和远程控制产品。

## 规划入口

| 文档 | 内容 |
| --- | --- |
| [产品完整规划](plan/product-spec.md) | 用户场景、创作全流程、产品边界 |
| [功能矩阵](plan/feature-matrix.md) | 功能 ID、优先级、阶段、验收条件 |
| [阶段路线图](plan/roadmap.md) | Stage-001 至 Stage-008 的依赖及交付门槛 |
| [上游研究](design/upstream-research.md) | 官方桌面证据、提交号、复用边界 |
| [架构设计](design/architecture.md) | Electron、官方 Harness、小说插件与最小运行时 |
| [数据与存储](design/data-model.md) | 文件结构、版本、事务、迁移、冲突 |
| [编辑与交互](design/interaction.md) | 书架、工作台、局部 AI 修改与可访问性 |
| [技能与工具](design/skills-tools.md) | 技能路由、工具能力、上下文和任务执行 |
| [发布与导出](design/publishing.md) | 导出、站点、投稿、回执与回滚 |
| [验证与风险](assessments/acceptance.md) | 可复现验收、性能目标、文学审读边界 |
| [阶段工作日志](iterations/stage-000/WORKLOG.md) | 本轮已做、未做、关键决策 |
| [来源记录](design/sources.md) | 本地技能的方法提炼、官方源码链接 |
| [内置技能源目录](skills/README.md) | 可阅读技能源；尚未接入运行时 |

## 本仓库当前可执行的检查

```powershell
node scripts/check-project.mjs
```

只检查规划目录、JSON、功能引用和技能基础结构；不证明桌面或 AI 功能可用。当前无需安装应用依赖。正式开发统一采用 pnpm，版本随官方上游锁文件确定。

## 时间线

- 2026-10-22：新建独立项目，确认名称 ZiNovel Studio。
- 2026-10-22：核实官方仓库 `apps/desktop` 已提供 Electron 桌面实现，选择官方基础；不采用社区 DSH Desktop 或 ZiCode/Pi 作为运行时。
- 2026-10-22：完成 Stage-000 规划及首批技能源，应用开发尚未开始。
- 2026-10-22：公开仓库 [ax2/zinovel-studio](https://github.com/ax2/zinovel-studio) 已创建并推送，首轮 GitHub Actions 规划检查通过。

## 开源边界

本项目代码及新编写技能采用 MIT；上游复用时保留其许可证与来源。用户小说、私有素材、模型凭据、运行日志、导出成品均不属于公开代码。参见 [NOTICE](NOTICE)、[贡献说明](CONTRIBUTING.md)。
