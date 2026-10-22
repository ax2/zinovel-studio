# ZiNovel Studio

以小说为中心的本地 AI 创作工作台。基于官方开源 **DeepSeek Harness Desktop + DeepSeek Harness Agent** 规划，覆盖创意、试写、规划、设定、正文编辑、连续性、插图、审读及发布。

**当前状态：Stage-001/002 继续补全，Stage-003 任务恢复已开始。官方 Harness 与小说桌面已实际贯通，Windows 技术预览已发布。完整功能与上架资格尚未验证。**

Windows 技术预览版：[v0.1.0-alpha.3 下载与说明](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.3)。提供 x64 安装 EXE，自动构建、实际安装/运行/重装/卸载验证通过后发布。当前未代码签名，仍有大量创作功能待完成。

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
| [预览版使用说明](docs/USER_GUIDE.zh-CN.md) | 安装、手工写作、模型预算、审阅草稿和备份范围 |
| [功能矩阵](plan/feature-matrix.md) | 功能 ID、优先级、阶段、验收条件 |
| [阶段路线图](plan/roadmap.md) | Stage-001 至 Stage-008 的依赖及交付门槛 |
| [上游研究](design/upstream-research.md) | 官方桌面证据、提交号、复用边界 |
| [架构设计](design/architecture.md) | Electron、官方 Harness、小说插件与最小运行时 |
| [数据与存储](design/data-model.md) | 文件结构、版本、事务、迁移、冲突 |
| [编辑与交互](design/interaction.md) | 书架、工作台、局部 AI 修改与可访问性 |
| [技能与工具](design/skills-tools.md) | 技能路由、工具能力、上下文和任务执行 |
| [发布与导出](design/publishing.md) | 导出、站点、投稿、回执与回滚 |
| [Windows 发行工程](design/release-engineering.md) | 自动 Release、安装 EXE、安装验收与签名边界 |
| [验证与风险](assessments/acceptance.md) | 可复现验收、性能目标、文学审读边界 |
| [基础接入工作日志](iterations/stage-001/WORKLOG.md) | 官方 Agent 与桌面贯通、测试和修正 |
| [本地写作工作日志](iterations/stage-002/WORKLOG.md) | 卷章、导入、检索、备份和编辑器 |
| [AI 协作工作日志](iterations/stage-003/WORKLOG.md) | 任务记录、重启恢复与候选范围 |
| [来源记录](design/sources.md) | 本地技能的方法提炼、官方源码链接 |
| [内置技能源目录](skills/README.md) | 21 项技能源可选，逐项文学质量尚未验收 |

## 本地开发与检查

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm dev
node scripts/smoke-harness.mjs
node scripts/smoke-novel-agent.mjs
pnpm test:desktop
pnpm test:library
pnpm test:editor-tools
pnpm test:recovery
pnpm test:merge
pnpm test:tasks
pnpm test:acceptance
pnpm test:task-compatibility
pnpm test:stream
pnpm test:budget
pnpm test:candidate-review
pnpm test:benchmark
pnpm package:win
pnpm test:installer
pnpm release:manifest
```

当前使用 Node 26、pnpm 10.3.0、Electron 44.7.0。前两个 Agent 探针运行官方 Harness 与本机模型 fixture，不消耗真实模型额度。桌面冒烟使用独立临时书库和合成小说，截图保存在 screenshots/stage-001。普通运行在用户应用数据目录保存作品。模型设置通过系统安全存储加密凭据；手工写作无需模型 Key。

已实现的开发切片：卷章/导入/检索、Markdown 编辑与恢复日志、备份恢复、三方冲突合并、历史、批注书签、逐项替换、阅读主题、官方 Harness 的技能候选与两个受约束工具。真实 Electron 验证涵盖渲染进程崩溃恢复和卡死关闭；1,000 章/约 305 万字符合成基准已运行。功能矩阵中的 `verified` 仅表示条目的验收范围通过，`in-progress` 仍有原验收条件待满足。Windows 安装、安装后 Agent、重装保稿及卸载保稿已通过，自动 Release 也已远端验证，当前不是上架版本。详见 [安装验收](assessments/windows-preview-acceptance.md)。

开发切片定期提交到 GitHub，每次 push 触发检查。`v*` 版本标签触发 Windows 发行工作流：版本/来源检查、回归、打包、真实安装和运行通过后才创建预览 Release，附件为安装 EXE、SHA-256 和运行时清单。当前尚未代码签名；GitHub 自动发布与应用自动升级是不同能力，后者仍待实现。

## 时间线

Stage-003 已增加跨书任务分页、旧版任务只读入口和恢复审阅：新任务绑定准确书章与选区，中断/取消后已落盘提案或流式文字可找回，作者可用当前选区明确重试。接受意图与书内事务回执支持崩溃对账，并保留作者后续编辑；用量预算和其他创作能力仍待补齐，详见任务恢复设计和阶段日志。流式片段恢复为 alpha.2 标签之后的开发内容。

alpha.3 提供流式恢复、任务步骤/输出/章节上下文限制、官方启发式输入预估及自定义单价/费用阈值；供应商回报、预估和未知项明确区分。完整请求在发送前检查，历史任务保留自己的预算与单价，参见 [用量预算设计](design/task-budget.md)。这些不是实际服务商账单的保证。

alpha.3 标签之后正在补充 [逐块候选审阅](design/candidate-review.md)：可分别采用修改或保留原文、显式保存审阅草稿并在重启后恢复，最后一次接受并可撤销。该切片已通过真实桌面验证，多候选比较仍待补全，尚未进入已发布安装包。

- 2026-10-22：新建独立项目，确认名称 ZiNovel Studio。
- 2026-10-22：核实官方仓库 `apps/desktop` 已提供 Electron 桌面实现，选择官方基础；不采用社区 DSH Desktop 或 ZiCode/Pi 作为运行时。
- 2026-10-22：完成 Stage-000 规划及首批技能源，应用开发尚未开始。
- 2026-10-22：公开仓库 [ax2/zinovel-studio](https://github.com/ax2/zinovel-studio) 已创建并推送，首轮 GitHub Actions 规划检查通过。
- 2026-10-22：官方 Harness 候选链路和小说桌面贯通；随后完成卷章、导入、备份、CodeMirror、长篇基准、锚点与故障恢复切片，工作日志持续记录实测和修正。安装、全部创作功能和文学质量验收仍在后续阶段。

## 开源边界

本项目代码及新编写技能采用 MIT；上游复用时保留其许可证与来源。用户小说、私有素材、模型凭据、运行日志、导出成品均不属于公开代码。参见 [NOTICE](NOTICE)、[贡献说明](CONTRIBUTING.md)。
