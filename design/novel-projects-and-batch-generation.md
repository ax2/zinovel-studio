# 小说工程、批量创作与模型迁入

2026-10-27 用户追加三项 P0；本设计扩充已有 106 项，不以原 LIB-03 正文导入验收覆盖完整工程。

## 创作资产的权威文件

参考本地 zicode-novel-book-pipeline / write-chinese-fiction 与小说站格式说明（仅提炼公开可移植的结构，不复制私有稿件），新增以下可编辑资产：

```text
README.md
worldbuilding/world.md
worldbuilding/style.md
worldbuilding/characters/<name>.md
outline/master-plan.md
outline/volumes-overview.md
outline/threads.md
outline/volume-NN-chapters.md
outline/volume-NN-chapters-detail.md
production/state/current-state.md
production/reviews/*.md
production/publish/chapter-NNN.frontmatter.yml
assets/images/README.md
assets/images/chapter-NNN/README.md
```

已有 UUID 正文路径与卷章顺序继续是正文权威，不为目录外观重写所有章节。创作 Markdown 是长篇策划文档，既有结构化资料卡承担图谱和正文证据，两者不暗中镜像同步；后续导入设定为卡片必须有明确解析与审阅。

每书 `.zinovel/project-assets.json` 登记路径、类型、原始 UTF-8 hash、版本、字节数与来源。使用同一个 BookStorageKernel 排队，文档、清单及历史在同一可恢复事务中提交。保存比较读取时版本和磁盘 hash，外部修改冲突保留作者缓冲；明确重新读取外部版本后保存，历史保留真实外部前像。恢复新书保留原工程身份并验证恢复来源链。模板标 scaffold，不称模型生成或文学验收。

当前源码实现允许作者显式建立模板、新建文档、编辑、保存及载入历史到缓冲区。现有作品不静默初始化，不覆盖已有未登记 README；桌面新建作品默认在同一事务建立模板，旧安装数据和真实升级仍需共同验证。

## 格式导入

写作工程选择单本 `books/<slug>`，按受控目录扫描，正文只来自 `manuscript/volume-NN/chapter-NNN.md`，总纲/细纲/状态不会误入章节。首行章名与发布旁车的 slug、卷、全局章号、标题检查一致。保留原始 BOM、CRLF 与 Unicode，不改源文件。单章/单资产 8 MiB，正文源总量 128 MiB，资产 32 MiB/512 份，章节 2000；超限明确拒绝。

小说站选择 `src/content/novels/<slug>.md`，解析 YAML 索引，读取相邻 `novel-chapters/<slug>/NNN.md` 的 frontmatter 与正文，使用 volumeTitles。站点索引不能还原从未包含的私人总纲：预览逐项列出缺失位置，不能伪造为已导入。二进制图像当前列入未导入清单，需另从资产界面导入；自动图片映射、空卷保留、工程导出、智能解析卡片均是余项。

预览正文保留在宿主，渲染器只持有不可猜令牌/指纹和清单。确认时重新只读扫描并检查完整指纹，一次令牌只创建一次新书；拒绝链接、特殊文件、路径穿越、Windows设备名、大小写重名、不完整 Unicode 和未知清单版本。未知应用配置及插件不执行。

## 灵感生成多本完整工程（源码已接入，完整质量与安装待验收）

输入：类型、核心灵感与排除项、预期全书字数、试写章节数、同时创建作品数、风格/视角与预算、模型配置。全书预期字数与本次试写实际字数分别展示，不能承诺写完百万字却只落三章。

流程：冻结输入与模型能力 → 为各书生成有差异的方案 → 全书主线/分卷 → 人物/世界/风格 → 章纲/近期逐章细纲/主支线与伏笔 → 当前状态 → 指定数量试写 → 完整性与交叉引用检查 → 新书工程。每书须落盘全部必需资产和准确试写章数，任一步缺失不能标完成；空模板不算生成资产。长篇远期细纲分层展示覆盖范围，不能把近期章纲标为全书细纲。

采用官方 Harness 的工具受控提案、既有预算与可恢复任务账本。每书每阶段有唯一请求/结果/采用记录，重启后的远端未知状态不自动重付费。限制并发与总预算；单本失败保留已完成的其他作品和本书候选，明确缺失阶段。生成候选完成后才提交成可编辑书，保留来源、模型、成本和内容hash。需要真实宿主、模拟协议、断流/取消/重启及安装验证，再使用可控实际模型做文学试读；自动结构检查不等于文学质量。

当前源码的具体阶段与恢复协议见[批量运行时](novel-batch-runtime.md)，实际作者+官方Harness本地模拟20请求通过，仍按GEN-01 in-progress跟踪。真实模型的内容/字数质量、长卷细纲分块、候选修订和费用汇总等未提前认定完成。

## WorkBuddy / DSH / Codex 模型迁入（待实现）

本机只做元数据形状调查，未输出或使用真实 Key：WorkBuddy `models.json` 为模型数组；Codex `config.toml` 有 provider/base_url/wire_api；DSH 官方 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 与配置层。只解析已知字段为数据，不加载用户插件、不执行配置、不复制整份会话目录。

导入预览显示源、模型、地址、协议、能力、Key 是否可迁入；用户确认后新增独立配置，不覆盖既有默认。凭据仅宿主读取并以既有 Windows 加密保存，渲染器/日志/导入回执不含 Key，取消不保留秘密。服务地址改变不能沿用旧地址的 Key。

API Key 与登录会话区分：Codex OAuth 登录不能冒充第三方 API Key；环境变量引用只在明确本机权限下解析且不回传。当前运行文字路由只支持 anthropic-text，OpenAI Chat/Responses 需要基于官方 Harness 的真实协议适配及工具/流式验证；不把仅导入元数据称可调用。不同来源重复配置需有去重和新配置预览。全部仅在用户操作导入时读取，不能启动即搜集所有凭据。
