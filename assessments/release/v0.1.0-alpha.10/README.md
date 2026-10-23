# alpha.10 发行证据

源码与标签：89fdc6a95f2a503720ab771408ea13e350111f66 / v0.1.0-alpha.10。

## 本机安装

Windows x64 未签名安装 EXE，222860688 字节；SHA-256 **540cb7f230fa9386c11e7cf27c3bb77f5e2a1c633542341e8b83e6acf12f409f**。

package、完整目录启动、真实 NSIS 中文/空格路径安装、安装后全部套件（含全书证据和关系图）、重装及卸载保稿 passed。安装 17029 ms，重装 36226 ms，卸载 5826 ms。安装后官方 Harness 使用本机合成模型，应用 PATH 不含开发 Node/pnpm。

从实际公开 alpha.3 安装包覆盖升级 passed，升级 23258 ms。旧包 SHA-256 e88243c6ed68ba4430bdcb100743db42ff808363abd5a6500ac5a6f21b83abd6 与公开清单一致；旧版真实写稿、保存加密设置后覆盖升级，新版核对数据原始字节并继续审阅旧候选。

完整运行目录及报告保存在本机 release/v0.1.0-alpha.10，根 release 保留安装 EXE，无 ZIP。本目录 manifest/inventory/installer/upgrade 报告来自本机独立构建；不能冒充 CI 公开 EXE 的哈希。代表性关系图、证据、试写与升级截图位于 screenshots/，全部为合成作品。

## 自动发行

源码开发 CI 39972895733 的最终状态在推标签前重新核对。先前 alpha.10 CI 暴露的工具栏遮挡已实际复现并修复；目录收起后的测试操作也按真实关闭/打开参考流程修正，ccbd3f0 的 CI 39971573363 已成功。标签发行完成后追加公开附件核对。

86 项单元通过，106 项需求当前 24 verified / 31 in-progress / 51 planned。WORLD-04 按原软件条件验收；秘密矩阵、角色时间切片及其他完整产品要求仍未完成。5,000 条关系核对仍需约 3.3–4.7 秒，性能门槛未完成；当前不是稳定上架版本。

### 首次失败与重跑边界

第一次安装流程在试写 AI 套件打开书卡时等待稳定状态超时，pageerror 为空，截图书架内容正常；原因尚未证实，不能据此宣称已修复某个启动问题。相同安装字节、无代码修改的独立重跑通过；按已核对的合成安装路径卸载后，完整安装/全部套件/重装/卸载和公开旧版升级重跑全部通过。first-attempt 保留原失败报告、截图及独立重跑报告，最终 manifest 绑定同一 SHA-256 的完整通过结果。稳定版仍需启动长时与低端验证。

开发 CI 39972895733 已重新核对为 completed/success；本标签继续接受独立 Windows 发行流水线验收，公开状态和公共哈希待后续核对。

## 公开结果

[标签发行 CI 39975497797](https://github.com/ax2/zinovel-studio/actions/runs/39975497797) completed/success；同标签全套功能、实际安装、重装/卸载及公开 alpha.3 升级全部通过，CI 升级 18861 ms。

[公开 Release](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.10) 于 2026-10-23 23:19:45 北京时间发布，draft=false / prerelease=true。四个附件均已上传，未提供 ZIP。

公开 EXE 222860615 字节，SHA-256 **13fa616bce5bec7dcb39fd5ac0c9a9eae5951e9dd2ea24c914806505f460a081**；GitHub asset digest、大小、manifest 与 SHA256SUMS 一致。三个元数据文件已实际下载并核验各自 GitHub digest，保存在 ci-public/。公开 EXE 的执行证据来自发行 CI，本机没有再次下载执行这份 CI 构建；本机独立构建哈希另列，不能混用。
