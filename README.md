# ZiNovel Studio

最新公开版为[alpha.37](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.37)，包含[Windows安装EXE](https://github.com/ax2/zinovel-studio/releases/download/v0.1.0-alpha.37/ZiNovel-Studio-0.1.0-alpha.37-windows-x64-setup.exe)。交付手工导入分章/合并/改名、四编码预览和快照确认保护；源码与独立发行CI、198项完整安装、五条公开升级及218条清单通过，公开EXE另外下载/hash和实际安装运行、卸载。详见[公开证据](assessments/release/v0.1.0-alpha.37/ci-public/README.md)。当前未签名，完整平台和稳定上架仍未完成。

**模型凭据提醒：** alpha.27及沿用旧设置逻辑的版本，更换模型服务地址且留空Key会保留上一服务的Key。请先在原地址下清除已保存Key，再修改地址并输入新服务对应Key，不要向不信任的服务沿用旧Key。已在公开alpha.29修复，请优先更新；公开Release说明已同步提醒。

以小说为中心的本地 AI 创作工作台。基于官方开源 **DeepSeek Harness Desktop + DeepSeek Harness Agent** 规划，覆盖创意、试写、规划、设定、正文编辑、连续性、插图、审读及发布。

**当前状态：文本合订和纯文字DOCX/PDF导出已有实际安装证据；复核完整设计后，含图/目录/注释等尚未完成的格式条目继续进行中，29项 verified、47项 in-progress、30项 planned。阶段成果发布含 Windows 安装 EXE 的预览 Release；完整产品上架资格仍未完成。**

Windows 技术预览版：[v0.1.0-alpha.37 下载与说明](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.37) · [下载安装 EXE](https://github.com/ax2/zinovel-studio/releases/download/v0.1.0-alpha.37/ZiNovel-Studio-0.1.0-alpha.37-windows-x64-setup.exe)。独立CI198项安装/重装/卸载、五升级和218条清单通过，公开文件另有本机安装运行与卸载证据；完整运行目录和EXE留档，无ZIP。

**编码风险：** alpha.15 及更早版本读取含非法 UTF-8 字节的正文后保存，可能改写原始字节。请保留原始副本，其他编码使用导入预览处理，不要用旧版打开并保存损坏文件。alpha.15 因新增复现撤销本机资格，取消流水线时发布步骤已完成，复核后已将 Release 转回草稿；修复已随 alpha.17 完成安装与发行验证并交付；alpha.16冻结标签两轮失败，未公开发布。历史测试报告保留并附资格撤销记录。1000认知事件扫描仍超过500ms查询目标；自动故事时间推演、大书性能、多格式出版和完整上架要求继续推进。

主线alpha.38已实现导入来源确认记录、分页查看与备份恢复；源码391项、202项实际安装、公开3/31/33/35/36/37六升级及229条manifest通过，本机证据与完整运行目录已归档。已开启阶段标签入口，独立发行与公开包复验仍待。完整106项仍29/47/30，其他需求继续推进。

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
| [模型配置与能力后续设计](design/model-profiles-and-capabilities.md) | 独立文字/图像路由、Key范围与完整验证要求；alpha.30接入文字，图像生成待实现 |
| [数据与存储](design/data-model.md) | 文件结构、版本、事务、迁移、冲突 |
| [编辑与交互](design/interaction.md) | 书架、工作台、局部 AI 修改与可访问性 |
| [技能与工具](design/skills-tools.md) | 技能路由、工具能力、上下文和任务执行 |
| [发布与导出](design/publishing.md) | 导出、站点、投稿、回执与回滚 |
| [Windows 发行工程](design/release-engineering.md) | 自动 Release、安装 EXE、安装验收与签名边界 |
| [验证与风险](assessments/acceptance.md) | 可复现验收、性能目标、文学审读边界 |
| [基础接入工作日志](iterations/stage-001/WORKLOG.md) | 官方 Agent 与桌面贯通、测试和修正 |
| [本地写作工作日志](iterations/stage-002/WORKLOG.md) | 卷章、导入、检索、备份和编辑器 |
| [AI 协作工作日志](iterations/stage-003/WORKLOG.md) | 任务记录、重启恢复与候选范围 |
| [阅读与审读工作日志](iterations/stage-005/WORKLOG.md) | 独立阅读预览、进度与运行证据 |
| [创作资料工作日志](iterations/stage-004/WORKLOG.md) | 类型资料、证据、上下文、结构化提案与实测 |
| [资料提案设计](design/material-proposals.md) | 版本冻结、语义审阅、接受事务与恢复 |
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

alpha.5 阶段增加了 [逐块候选审阅](design/candidate-review.md)、显式草稿保存恢复和同页同章候选比较，最后一次接受并可撤销。alpha.4 曾因恢复后新草稿选择缺陷撤回为草稿；相关修复已包含在 alpha.8 及后续版本中，并通过实际安装与升级验证。批量候选生成和另存小说分支仍未完成。

- 2026-10-22：新建独立项目，确认名称 ZiNovel Studio。
- 2026-10-22：核实官方仓库 `apps/desktop` 已提供 Electron 桌面实现，选择官方基础；不采用社区 DSH Desktop 或 ZiCode/Pi 作为运行时。
- 2026-10-22：完成 Stage-000 规划及首批技能源，应用开发尚未开始。
- 2026-10-22：公开仓库 [ax2/zinovel-studio](https://github.com/ax2/zinovel-studio) 已创建并推送，首轮 GitHub Actions 规划检查通过。
- 2026-10-22：官方 Harness 候选链路和小说桌面贯通；随后完成卷章、导入、备份、CodeMirror、长篇基准、锚点与故障恢复切片，工作日志持续记录实测和修正。安装、全部创作功能和文学质量验收仍在后续阶段。

## 开源边界

本项目代码及新编写技能采用 MIT；上游复用时保留其许可证与来源。用户小说、私有素材、模型凭据、运行日志、导出成品均不属于公开代码。参见 [NOTICE](NOTICE)、[贡献说明](CONTRIBUTING.md)。

### 2026-10-23 恢复开发

暂停时的 Development checks 39826350216 最终全部成功。恢复初期曾按用户要求暂停预览发行，加入完整产品门禁；之后用户明确要求阶段成果发布含安装程序的 Release，现改为独立预览资格与稳定版上架资格，保留全部安装/运行/升级检查。

Stage-004 正在实现[创作资料](design/creative-materials.md)：八种类型表单、章节引用、检索、版本冲突、回收站、历史与已保存资料导出。实现和真实桌面证据见[阶段日志](iterations/stage-004/WORKLOG.md)，当时公开 alpha.3 与本机原 alpha.5 安装包均不包含新资料功能。

Stage-004 已增加正文证据与显式 AI 资料上下文：伏笔/人物状态/关系/认知事件保留引文和版本，正文修改后提示复核；写作助理按作者选择冻结同书资料。无资料任务保留两个受约束工具，有资料任务增加只读 novel_materials_read。该切片开发版本为 alpha.6，完整要求和上架资格仍未完成。

本机 alpha.6 已通过安装、安装后功能、重装/卸载保稿及 alpha.3 升级验证，完整运行目录与 EXE 保留，没有公开发布。后续主分支增加关联设定版本复核、证据精确导航和资料扫描分批调度；5,000 份资料扫描时的保存等待从 911 ms 降至 16 ms，查询仍有一次超过 500 ms 初始目标。安装包与后续源码的证据分别记录，详见 Stage-004 日志。

alpha.7 开发切片已接入 AI 完善已有资料：模型提交独立结构化候选，作者可对照原卡、编辑、保存审阅草稿并明确接受；过期版本拒绝覆盖。人物字段、场景细纲编辑与证据段落导航已按原条目验收，参见[逐项报告](assessments/stage-004/materials-and-evidence-acceptance.md)。alpha.8 进一步接入共享场景看板/章纲、组织/物品/能力/现实资料。全流程文学质量、关系/认知矩阵、地图和出版等仍待完成。

alpha.8 标签发行 CI 39955362954 已成功，四个公开附件与安装清单哈希核对一致；本机和 CI 构建分别留存证据，详见[发行证据](assessments/release/v0.1.0-alpha.8/README.md)。后续[试写分支](design/pilot-branches.md)在 alpha.9 源码中实现，独立验证与发布，不计入 alpha.8 功能。

alpha.9 已于 2026-10-23 22:14:42 北京时间公开，发行 CI 39966140390 成功，安装附件及元数据核对通过。独立试写五项原验收条目已通过，完整产品仍在开发；见[发行证据](assessments/release/v0.1.0-alpha.9/README.md)。

alpha.10 已于 2026-10-23 23:19:45 北京时间公开，标签发行 CI 39975497797 成功，四个附件与哈希核对通过；本机首次安装超时、同包重跑及最终完整资格分别留档，见[发行证据](assessments/release/v0.1.0-alpha.10/README.md)。

alpha.11 已于 2026/10/24 00:52:22 北京时间公开，发行 CI39988528009 全部成功，安装 EXE 与三个元数据附件已核对；完整证据见[alpha.11 发行记录](assessments/release/v0.1.0-alpha.11/README.md)。后续 alpha.12 作者选择未混入该标签。

alpha.17 已于2026-10-24 09:23:23北京时间公开，标签发行CI40048673869全部成功。公开EXE222895662字节、SHA256 824d8f2926f57c3800dd2050e268e67e1c86418a579926790568735b7c2f5cc3，已下载复算且匿名可见。原文编码保护、冻结发布副本与实际导出/独立HTML通过安装验收；本机EXE与CIEXE分开留证，完整本机运行目录保留D盘。alpha.18本机资格已取得，标签CI与公开安装包仍单独核对；图像资源方案与解码实测见design/assets-and-media.md。

alpha.18开发源码已接入[小说图像资源库](iterations/stage-006/WORKLOG.md)：原图导入与方向预览、来源/权利/用途、资料关联、历史采用和回收恢复；完整地图、图像生成及带图出版仍在后续。本版已取得本机安装/升级资格，标签Windows release [40053936921](https://github.com/ax2/zinovel-studio/actions/runs/40053936921)第2次完整运行成功，alpha.18已公开并下载复算SHA。下一切片[世界地图设计](design/world-map.md)已记录空间对象和冻结底图边界，不算已实现地图。

主分支alpha.20开始地图领域实现：地点/区域/路线稳定ID、简单多边形校验、作者显式比例尺及冻结底图记录，六项领域测试通过；存储服务和可编辑界面尚未接通，ART-03仅in-progress，不继承alpha.19的发行资格。alpha.19标签CI40055840140已成功并公开，公开EXE下载复算摘要通过；主分支地图存储仍在开发，不包含于19。
