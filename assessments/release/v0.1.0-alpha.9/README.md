# alpha.9 发行证据

源码：05d2405b2212af431e8be7ef07d8798105653e08；版本 v0.1.0-alpha.9。

## 本机安装资格

Windows x64 未签名安装 EXE：222853902 字节；SHA-256：64125bc6909d868d9b3690bef11663b725706ddca92a6e616afd2128204960c5。

构建、完整目录启动、真实 NSIS 中文/空格目录安装、安装后全部功能套件（含手工试写和独立 AI）、重装及卸载保稿均 passed。安装 28691 ms，重装 22943 ms，卸载 4928 ms。安装后的应用 PATH 只含系统目录，官方 Harness 使用本机合成模型服务。

从实际公开 alpha.3 安装包覆盖升级 passed，升级 21666 ms；旧包 SHA-256 e88243c6ed68ba4430bdcb100743db42ff808363abd5a6500ac5a6f21b83abd6 与公开清单一致。旧版真实写稿和加密设置保存后升级，核对数据原始字节和新版旧候选审阅；不是仅改变版本号。

完整目录保存在本机 release/v0.1.0-alpha.9/win-unpacked，EXE 保留在 release 根目录，无 ZIP。本目录元数据是本机独立构建，不能冒充 CI 公开 EXE 的哈希或安装证据。代表性安装后浅色/深色窄窗及升级截图在 screenshots/，全部为合成作品。

## 自动发行

开发 CI 39964912521 completed/success。前一提交 030795b 因漏提交验收 Markdown 导致规划检查失败，05d2405 补齐证据后全套检查通过，未放宽门禁。标签发行与公开附件核对结果将在完成后追加。

79 项单元测试通过；106 项原需求当前 23 verified / 32 in-progress / 51 planned。独立试写五项验收范围见 ../../stage-004/pilot-agent-acceptance.md。真实云模型文学质量、原生 IME、屏幕阅读器、低端设备、大量试写历史、完整迁移与出版尚未完成，阶段预览不代表稳定版上架资格。

### 已公开并核对

[发行 CI 39966140390](https://github.com/ax2/zinovel-studio/actions/runs/39966140390) completed/success，全部同标签功能、安装后套件及公开 alpha.3 升级通过，CI 升级 18857 ms。

[公开 Release](https://github.com/ax2/zinovel-studio/releases/tag/v0.1.0-alpha.9) 于 2026-10-23 22:14:42 北京时间发布，draft=false / prerelease=true。四个附件均已上传：安装 EXE、SHA256SUMS.txt、release-manifest.json、runtime-inventory.json，无 ZIP。

公开 EXE 222853871 字节，SHA-256 **d3324c34048c8be00ead4081e6aba273a293bb8f2db5aece3d67e347493c0dfb**；GitHub asset digest、大小、manifest 与校验和列表完全一致。三个元数据附件已实际下载并核验各自 GitHub digest，保存在 ci-public/。公开 EXE 的执行安装证据来自发行 CI，本机没有再次下载执行这份 CI 构建；本机独立构建的不同哈希保留于上方，不混用。
