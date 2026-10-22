# EDIT-04 / EDIT-05：专注、打字机与旧稿参考

2026-10-22，真实 Windows Electron 44.7.0。宽窗 1426×923 CSS 像素，DPR 1.25，浅色。

`scripts/smoke-writing-views.mjs` 通过：

- 在正文旁选择本书另一章及其历史版本，参考为只读快照。编辑当前稿和外部修改参考源都不改变已打开的参考文字，点击重新读取才更新；当前正文不被覆盖。
- 进入专注隐藏卷章与参考栏，退出恢复，输入焦点保持在正文。窄窗参考抽屉进入专注时关闭。
- 打字机模式跟随真正的 CodeMirror 光标居中；本机测试编辑区高 644.8 CSS px、光标距垂直中心 0 px。切换模式后落盘正文与预期逐字相等。
- 桌面 Agent 回归追加：生成期间切到旧稿参考，官方 Harness 继续执行；候选通过独立弹窗展示，接受/撤销仍正确。参考切换不会卸载正在运行的助手。

已查看 [参考分栏](../screenshots/stage-002/reference/side-reference.png)、[专注与居中](../screenshots/stage-002/reference/typewriter-focus.png)。[视图回执](../screenshots/stage-002/reference/writing-views-smoke.json) 和 [Agent/桌面回执](../screenshots/stage-002/reference/desktop-smoke.json) 保留实测行为。

EDIT-04/05 当前验收范围通过。参考选项目前是本书章节/旧稿，结构化人物设定和世界百科将在后续加入；窄窗使用可开关抽屉而非挤压正文。当前参考快照不是 Agent 的自动上下文包，未将其当作长篇记忆功能完成。系统 IME 与屏幕阅读器仍待全应用验收。
