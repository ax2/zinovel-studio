# Stage-007 导出与发布工作日志

## 冻结格式与独立 HTML 生成层（alpha.15 之外，2026-10-24）

当前 alpha.15 固定源码 c7f293a 的安装候选独立验收，本切片尚未接入桌面、未包含在该包，不将 Stage-007 或 PUB 功能标为 verified。范围与后续主机约束见 design/publication-snapshots.md。

新增 publication.mjs：schema1 快照严格白名单、明确书目字段、章节身份/版本与正文 hash、稳定内容 hash、深冻结；加载时重建并核验，未知字段、未来版本、重复章节、坏 Unicode 和篡改正文拒绝。时间/快照 ID 不改变相同内容的 hash，后续原对象改稿不会改冻结内容。来源成员资格、磁盘严格 UTF-8、共享存储捕获与目标授权仍需主机实现，不假装纯模块能够验证来源文件或作者操作。

实现 TXT/Markdown 字符串及逐章 HTML 文件生成、目录/上下章、主题字号偏好、文件 hash 清单。生成清单状态仅 prepared，真正 exported 还须主机完成写入与核验；不是公开发布。正文 HTML 全部转义、外部固定脚本/样式、CSP 不允许内联脚本/样式，字体使用固定选择器。没有图像/资源绑定、出版保存对话框、持久发布快照或实际远端发布。

4 项单元测试 passed，覆盖稳定内容、后改原数据、篡改/重复/未知字段、Unicode、顺序/首尾、脚本转义、ID路径和实际文件清单。实际独立 file 页面在 Electron44 的 Chromium 中打开，未载入工作台：目录→首章→深色24px→390px→下一章→重载→上一章→目录 passed，0 HTTP、0页面错误、无Node/工作台全局、实际输出文件逐字节清单相符。Browser plugin 未列出，使用仓库 Playwright/Electron；不是 Edge/真实手机/安装后导出入口资格。报告 screenshots/stage-007/html-foundation/html-foundation-smoke.json，最终桌面1287×838、窄屏390×844，深色章页/目录已人工查看；长题名页眉收为两行，目录保留完整题名，正文/控件无横向溢出。

初次独立浏览器空白：随后读取实际 argv 证明 Playwright 加入 inspect/debug 参数，原固定 argv[2] 取到调试选项而非文件。改为专用合成环境变量传文件和临时浏览器目录，保留首次失败 JSON；未把“持有窗口引用/show”试改当成已证实原因。第二次打开成功后发现包裹 select 的标签缺少精确可访问名称，补显式 aria-label 后实测通过；原失败另留 label-failure.json。长题名页眉改紧凑后再跑相同探针通过。探针已保存 scripts/smoke-publication-foundation.mjs。

后续：持久冻结存储与跨书/CAS/坏字节/中断、明确选择和预览、保存到中文空格目录、实际文件替换保护、导出入口，之后资源和其余格式逐项验收。现有全书 Markdown 入口未因此改称完整出版功能。
