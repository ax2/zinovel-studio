# 主分支 63c664c 失败保留

Development checks 40073142673，Windows Run pnpm test:publication-ui。原日志、该次 stage-007 回执和实际失败截图来自 synthetic-desktop-failure artifact 12551799572（34,881,263 字节）。未使用 artifact 中历史已提交的 release/installed 报告替代本次失败。

10 秒 finishedCount 失败时界面仍显示 PDF 正在导出；同时清理日志记录 taskkill 对已退出 PID 报错。本证据不能确定排版最终是否成功。后续源码等待覆盖产品 90 秒期限加 10 秒收尾，内容/hash/窗口断言保持，不能以等待调整推导新 CI 已通过。本次失败不修改 alpha.23 已成功的不可变发行标签或回执。
