# alpha.8 发行证据

源码与标签：561a32f404cfc0f553f3754aae22ae7022b30946 / v0.1.0-alpha.8。

## 本机实际安装

未签名 Windows x64 EXE，222,840,627 字节；SHA-256：085fadd581ce86bda3591ddccede39eb39f95e647e21affdfe41952ccb8fa954。

本机 package、完整运行目录启动、NSIS 安装、安装后所有功能套件、重装、卸载保稿与公开 alpha.3 → alpha.8 升级均通过。安装 18,802 ms，重装 23,781 ms，卸载 4,704 ms，升级 23,681 ms。安装后的官方 Harness 使用本机合成 SSE 模型，系统 PATH 不含开发 Node/pnpm。

旧包从 GitHub Release 实际下载，222,812,075 字节；SHA-256 e88243c6ed68ba4430bdcb100743db42ff808363abd5a6500ac5a6f21b83abd6，与公开 manifest 一致。真实旧版写稿及设置保存后覆盖升级，核对正文/任务/加密设置，旧候选可继续保存审阅草稿；不是用旧的本机构建代替公开旧包。

完整运行目录及报告归档本机 release/v0.1.0-alpha.8，安装 EXE 留在 release 根目录，无 ZIP。当前目录的 release-manifest.json、runtime-inventory.json、installer-smoke.json、upgrade-smoke.json 是本机验证结果；公共流水线的独立构建可能具有不同哈希，不能混用。

代表性安装后截图见 screenshots/：桌面深色、窄窗章纲、现实资料候选、公开旧版覆盖升级。视口和全部合成测试检查见原报告，所有图片均为合成作品。

## 自动发行

开发 CI 39954761035 与标签对应的开发检查 39955363001 均成功。[标签发行工作流 39955362954](https://github.com/ax2/zinovel-studio/actions/runs/39955362954) completed/success；同标签全部功能检查、构建、真实安装/重装/卸载及公开 alpha.3 升级通过，CI 升级 17,898 ms。

[公开 Release](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.8) 于 2026-10-23 20:55:08 北京时间发布，draft=false，prerelease=true。四个附件：Windows 安装 EXE、SHA256SUMS.txt、release-manifest.json、runtime-inventory.json，无 ZIP。

CI 公开 EXE 为 222,840,734 字节，SHA-256 **090095695b3b39d9c53afaea6b35e914e034dfac18c4117ccad8875635f30a51**。GitHub asset digest、文件大小、manifest 的精确安装字节及校验和列表一致；已下载并校验三个元数据附件的 GitHub digest。完整公共元数据在 ci-public/。公开 EXE 的安装证据来自发行 CI，本机没有再次下载执行这份 CI 构建；本机独立构建及其公开旧版升级证据见上方，不混淆两份 EXE 哈希。

当前 70 项单元检查通过，106 项需求中 18 verified / 33 in-progress / 55 planned；这是阶段预览，不是全部需求或稳定上架资格通过。
