# Windows 发行工程

2026-10-22：按用户要求，将安装验证与自动 Release 提前到结构化创作功能之前。功能范围仍以功能矩阵为准；预览版不表示全部需求或上架验收通过。

## 交付与触发

- 日常开发按可验证切片提交到 GitHub main，每次 push 触发 Windows 检查。
- `v<package.json 版本>` 标签触发独立发行工作流；校验标签、锁文件、上游来源、测试、打包和真实安装后，才创建 Release。
- 含 `alpha`/`beta`/`rc` 的版本发布为 prerelease。正式稳定版需要另外完成发行验收，不能自动去掉预览标签。
- 交付 Windows x64 NSIS 安装 EXE、SHA-256 清单和发行说明。本地保留完整 win-unpacked 目录；不提供 ZIP。

2026-10-23 最新发行政策：用户要求经过验证的阶段成果也发布 Release。check-release-ready.mjs 按 package 版本分渠道；alpha/beta/rc 必须匹配 plan/preview-readiness.json 的版本、验收文件、passed 运行报告和未完成范围，稳定版仍检查 plan/release-readiness.json 全部资格及所有功能 verified。预览资格只准许进入流水线，不能跳过本标签构建、安装、运行、升级和 manifest 哈希检查；CI 的公开预览字节与本机独立构建字节分别记录，不假定哈希相同。

## 最小独立运行时

Electron 44.7.0 自带 Node 24.21.0；官方 SDK 通过该 EXE 的 Node 模式启动固定版本 DSH CLI。安装机无需 Node、pnpm、Python 或其他桌面应用。ASAR 保存 JavaScript/配置等普通资源；原生模块和外部可执行组件由打包器解包。已实测 Node 模式能够解析归档内 ESM、官方 CLI 和小说插件，不能仅凭开发环境可用推断。

仅生产依赖随包进入。官方 CLI 的依赖闭包包含一些未加载的共享插件；小说 profile 继续关闭通用终端、文件工具等入口。npmRebuild=false 保持供应商预构建依赖，首轮必须实际验证打包后的 Agent。该选择不表示未加载的原生模块全部可用。

发行工具固定 electron-builder/app-builder-lib 26.17.0。pnpm 的无限深度 JSON 枚举会在共享依赖图上耗尽内存，因此以可追踪补丁使用打包器内置文件遍历，并补齐其原先遗漏的 required/optional peers。包内检查验证每个真实模块的非可选依赖都能在应用目录内部解析；先运行完整目录中的 EXE，再打 NSIS。源码、锁文件、补丁、安装字节哈希与实际验收共同进入发布证据。

## 安装验收边界

真实安装到独立中文/空格路径，运行安装后的 EXE，执行保存、重启、冲突、撤销与真实官方 Agent/本机模型 fixture；重装后核对稿件，卸载后保留独立用户数据。测试发现已有正式安装时拒绝覆盖，绝不替换用户安装。

从 alpha.4 起增加固定 alpha.3 → 当前候选的覆盖升级门禁，详见 [升级方案](upgrade-validation.md)。CI 先下载公开旧包及 manifest，校验旧包 SHA-256，再实际旧版写作/覆盖安装/新版读取与草稿保存/卸载保稿；发行 manifest 同时校验新包安装和升级报告的版本与 SHA-256。降级、其他历史版本及跨架构仍另行验收。

当前未配置代码签名，预览版明确标注 unsigned。安装签名、更新/降级、多 Windows 版本、低配置、真实 IME 和文学质量仍需后续验收。未提供应用内自动升级，不把 GitHub 自动发布描述为应用自动更新。

从 alpha.2 起，安装后的 EXE 还必须通过任务强杀恢复、接受事务对账、旧版任务分页和当前选区重试。故障 worker 采用同一提交的生产存储服务在持久检查点退出，安装应用完成恢复；这不是物理断电测试。版本间完整运行目录归档到 release/v<version>/win-unpacked，保留安装 EXE 与各版安装回执。

## 公开附件复查

后续主分支增加可重复命令 `pnpm release:verify-public v0.1.0-alpha.N RELEASE_RUN_ID`：核对本机标签指向、Windows发行工作流成功/标签/提交一致、公开非草稿prerelease与四附件、实际下载三个元数据的GitHub digest、EXE大小/digest/manifest/SHA256SUMS一致、重装卸载与升级回执。报告保存对应版本ci-public/verification.json，失败明确写failed，不残留本次passed。

当前命令实际下载公开EXE到独立指定目录并重新核对大小与SHA-256，另核对三份元数据摘要及匿名可见性；不再次运行该下载EXE。公开字节的执行证据来自同一成功发行CI，不能称为本机再次安装。它可在后续版本工作区复查旧标签，不要求当前package版本等于被复查版本。alpha.23已完成该版本的实际下载与复算证明。此项属于发行后的独立复查，不能替代工作流中的实际安装和升级门禁。
