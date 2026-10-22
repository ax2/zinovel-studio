# ADR-006：Markdown 文本编辑事务

2026-10-22，采用 CodeMirror 6 的纯文本视图、状态和历史模块，替换 Stage-001 原生 textarea。

## 选择依据

原生 textarea 已验证保存、恢复和选区链路，但程序应用 AI 替换时缺少统一的编辑事务与可靠撤销边界。富文本编辑器需要额外维护 Markdown 的双向转换；当前小说正文主数据是开放文本，优先避免引入另一份富文档真值。

CodeMirror 仅启用文本编辑、换行、选区和历史，不启用代码语言、终端、开发补全等无关功能。原文按 UTF-16 编辑位置映射；AI/历史/查找替换通过局部 change transaction 更新，标 `isolateHistory.full`，一次接受可以一次撤销，未改部分保持原文。官方 [view 来源](https://raw.githubusercontent.com/codemirror/view/main/README.md) 与 [history 实现](https://raw.githubusercontent.com/codemirror/commands/main/src/history.ts) 支持这一接口选择，运行依赖固定在 package.json/lockfile，许可证 MIT。

## 实验和真实验证

- CodeMirror 版本：state 6.7.6，view 6.43.15，commands 6.11.1。
- Electron 全链回归通过：中文保存、关闭重开、冲突、历史、AI 选区候选接受与一次撤销/精确重做、过期提案拒绝。
- 阅读模式隐藏编辑视图，不销毁历史；章节切换使用 bookId + chapterId 区分编辑状态。光标/选区位置按作品和章节存本地状态，打开书时优先恢复上次章节。
- 1,000 章、3,048,004 字符；压力章 50,998 字符。实际编辑器输入 25 次，落盘逐字相等。合成 composition 事件期间保存被推迟，compositionend 后保存通过；不是 Windows IME 候选窗人工验证。
- 原实现每次输入渲染整个 1,000 章目录，输入到两帧完成 P95 59ms。拆出 memo ChapterTree 后复测 13ms；长章打开 296ms、末次输入后自动保存 709ms、全书检索 325ms。详细 [机器回执](../assessments/writing-benchmark.json)。

机器：Windows 10.0.26300、i9-14900HX、64 GiB。以上为本机单轮合成结果，不外推到目标 4 核/16GB 机器，不把两帧观测等同于纯 JS 处理耗时。长篇索引和低配置基准继续开放。

## 后续

补齐系统 IME、屏幕阅读器、焦点圈、组合输入关闭/恢复、编辑位置跨外部修改的映射，以及批注和场景锚点。查找替换先用字面匹配并展示数量与位置，不接受任意正则表达式以免阻塞输入线程。
