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

2026-10-23 补核：总工作流已 completed/success，发布回执同步为 passed。此前状态延迟已解除；公开资产及本地/CI 哈希边界不变。

## alpha.3 本机安装资格（2026-10-23）

运行目录清单通过：874 个物理文件、904,051,739 字节；新 NSIS EXE 本机 SHA-256 为 01e765cc7e7da20fac00b6f8b924b53ff38721f0f8099c713494631a66b0bce7。首次封装失败后同一完整目录重试成功，失败细节未完整保留，尚无确定根因；本机重试不替代独立 CI 构建。

真实安装/安装后完整套件/重装/卸载最终 passed。首次安装 15,383ms、重装 21,362ms、卸载 7,205ms；同版本重装后实际打开原稿，卸载后稿件字节保留。安装后增加流式取消/强杀恢复和完整预算/自定义价格 UI 验证。代表截图在 screenshots/release/installed/stream 与 budget，已查看费用明细和窄窗设置，文字可读，操作可达。安装用 Harness 的模型仍为本机 fixture，不是云端账单或文学质量证明。

alpha.2 完整目录归档在 release/v0.1.0-alpha.2/win-unpacked，报告归档在 assessments/release/v0.1.0-alpha.2/local-installer-smoke.json。alpha.3 标签工作流和公开附件待单独核验，本机哈希不能代替 CI 产物哈希。

alpha.3 公开补核：Windows release 39820858936 completed/success，四附件 uploaded，非草稿 prerelease，未登录 HTTP 200。公开 EXE 222,812,075 字节，SHA-256 e88243c6ed68ba4430bdcb100743db42ff808363abd5a6500ac5a6f21b83abd6，与公开 manifest/checksum、GitHub digest 和标签 edbd695 一致。完整回执在 assessments/release/v0.1.0-alpha.3/publication-verification.json。未本机重装公开 EXE；它的安装资格来自同一 CI 构建/安装/上传链路。

## alpha.4 本机安装与覆盖升级（2026-10-23）

EXE 222,813,868 字节，SHA-256 4489647f45a90800ebd10977ab8ff8962d514e388438ce4310bba9d4991ab765。完整打包、安装后的全部回归（含差异审阅和草稿恢复）、同版本重装和卸载 passed；安装 17,254ms、重装 23,048ms、卸载 5,403ms。

指定 alpha.3 → alpha.4 覆盖升级 passed：旧版实际写入稿件和合成加密设置，新版覆盖安装 21,178ms，library/tasks/model.json 字节一致，实际打开新版本 EXE（系统目录 PATH）并恢复旧候选、保存独立草稿。卸载保留正文。报告与截图在 screenshots/release/upgrade；本机旧包 SHA-256 01e765cc7e7da20fac00b6f8b924b53ff38721f0f8099c713494631a66b0bce7，与公开旧包不同。此结果不代表所有历史版本、降级或跨架构迁移。

已查看升级后浅色和安装版深色冲突截图。alpha.4 公开包仍待独立工作流核验，不能以本机产物代替；alpha.3 本机完整目录/manifest 及本机安装报告已归档。

## 实际暂停记录

- 北京时间 2026-10-23 02:00 到点停止开发、测试与发布；本段为收尾保存记录。
- 最新功能提交：d55e08383b97df26c851000ca66c18a45b6a6c13，已推送 main；版本 0.1.0-alpha.5。
- alpha.5 本地打包、安装、重装、卸载和 alpha.3 → alpha.5 覆盖升级验证通过。安装 15832 ms、重装 21825 ms、卸载 4847 ms；升级 20940 ms，升级后原稿、任务、设置字节保留，旧候选可读取并独立保存审阅草稿。
- 本地 alpha.5 安装程序 SHA256：4008122de46c041ce268d94a29e508d456e93ee9d9d49335e4250dff2f85fe38。完整运行目录与 EXE 保留在 release/，未创建 alpha.5 标签或公开 Release。
- GitHub Development checks 39826350216 在暂停时仍 in_progress；不将其记录为通过，不启动后续发布。恢复任务时首先核对最终结果。
- 最新公开预览为 alpha.3。alpha.4 曾短暂发布，发现恢复后新保存审阅草稿优先级缺陷后已撤回为 draft；不得推荐该版本。修复已包含于 alpha.5，并通过本地安装版本的恢复回归验证。
- 本任务尚未完成，上架质量及完整小说平台需求尚未达到。保持暂停，等待用户明确恢复。
