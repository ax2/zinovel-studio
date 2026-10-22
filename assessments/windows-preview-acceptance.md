# Windows 技术预览发行验收

日期：2026-10-22。版本：0.1.0-alpha.1。完整小说平台仍在开发，本报告不代表全功能、签名或商店审核通过。

## 已有证据

- 20 项基础测试、上游三份原文件哈希检查通过；开发检查 CI 39796051569 成功。
- 打包范围明确，检查无链接逃逸、无 TypeScript/Playwright/electron-builder 等开发工具；固定版本官方 SDK/CLI 随包提供。
- 文件遍历原先遗漏 peer 依赖，被真实安装启动测试发现；修复后逐包验证非可选依赖在安装目录内部解析。此校验曾正确拒绝旧缺包产物。
- 完整运行目录 EXE：11 项桌面行为通过，见 screenshots/release/unpacked/desktop-smoke.json。
- 新安装到独立中文/空格目录后的 EXE：11 项桌面行为通过，见 screenshots/release/installed/desktop-smoke.json。测试把应用 PATH 限定为 Windows System32，实际官方 Harness 使用 Electron 44.7.0 内含 Node 24.21.0。
- 代表截图为 1426×923 CSS px、DPR 1.25，含浅色、深色、窄窗、冲突和 AI 审阅；内容完全为合成稿件。已查看浅色工作台，正文与按钮可读。

## 验证方式与当前边界

安装/卸载通过真实 NSIS 程序静默执行；没有声称人工点击所有安装向导页面。程序内交互采用 Playwright 驱动真实 Electron。模型服务为本机 SSE fixture，执行官方 SDK/CLI、两项受约束工具及真实候选审阅，不代表云模型文学质量验收。

首轮 180 秒安装超时，第二轮安装实际 209,142ms；该轮因缺包启动失败，未发布。现在测试容许最长 600 秒，并先检查完整目录 EXE。安装速度偏慢保留为优化项。

最终采用 ASAR，实际物理文件为 875 个，完整目录约 904 MB，安装 EXE 222,795,930 字节。物理计数使用 original-fs，归档内依赖另行解析验证。ASAR 完整目录与安装后的全部回归通过；首次安装 15,929ms、同版本重装 22,854ms、卸载 4,836ms。重装后从真实界面打开并核对原稿，卸载后原稿字节仍在。与先前普通文件方案的 186,608ms 首次安装相比明显改善，但不是跨设备性能保证。

本地最终安装包 SHA-256：7f3e562601130d6693586f277c6558d27691f900dcf4b5db9bca3883ecf63906。OPS-10 按其明确行为通过，证据为 screenshots/release/installer-smoke.json、installed/desktop-smoke.json 和 reinstalled.png；不外推为跨版本更新/降级通过。

远端自动 Release 已通过：Windows release 39801795594 全步骤成功；v0.1.0-alpha.1 为公开非草稿 prerelease，未登录 HTTP 200，四个附件上传完成。安装 EXE 为 222,795,938 字节，SHA-256 fb5c7d46165b65b1bb44ffce90a6fa44b2b1c70f1b84beca1c31d3fa93eab1c1，与 GitHub 资产 digest、远端清单和校验文件一致；清单提交 f6d31036f6822ae2848c81be5807552fc13fcd04 与版本标签一致。详见 assessments/release/v0.1.0-alpha.1 下的原始远端清单和核验记录。OPS-09 按其自动发布行为通过。

本地包和 CI 包确实具有不同哈希，不能互相替代；公开下载以 CI 附件为准。此次没有在本机再次下载安装 CI 附件，CI 已对其实际安装和运行，GitHub 资产 digest 核对的是上传后的文件。

仍未完成：代码签名、应用内更新/跨版本降级、其他 Windows/低配置机器、系统 IME、读屏器、断电/磁盘满矩阵，以及小说功能矩阵中尚未验收的创作与发布能力。

## alpha.2 本地安装验收（2026-10-23）

以上 alpha.1 历史证据保留；其本地安装回执已复制到 assessments/release/v0.1.0-alpha.1/local-installer-smoke.json。screenshots/release 当前指向 alpha.2。

alpha.2 安装包 222,803,223 字节，SHA-256 12fab47a225ed6612b4854e0f5258e25784b9508b84d6c0e112508cd06e54e20。实际安装 13,646ms、同版本重装 19,154ms、卸载 4,750ms；安装后的基础写作、官方 Harness、任务强杀/重启、接受回执恢复、101 条旧记录分页和当前选区重试全部通过。全部安装应用使用仅 System32 的 PATH。查看浅色旧记录详情和深色窄窗任务列表，关键控件可读且可操作。

alpha.2 已由 Windows release 39814293616 于 2026-10-22T16:33:28Z 公开发布，非草稿 prerelease、未登录 HTTP 200、四个附件 uploaded。远端安装 EXE 为 222,803,309 字节，SHA-256 ded18a4f18768508c61e3bb73c7a59a7cf22ff15e5699d0e16249310b7a82dae；GitHub digest、下载的 manifest/checksum 及标签提交 93d4a66865e8cc0987303cda273602c4f78f54dc 一致。

打包、安装套件、发布及 Complete job 步骤均报告 success，但核验时总任务状态仍显示 in_progress，暂不把总工作流状态写成成功；原始回执已保存至 assessments/release/v0.1.0-alpha.2/publication-verification.json，后续补核。没有本机重新下载/安装该公开 EXE；CI 安装验收及上传摘要是公开包证据，本地包哈希另列。
