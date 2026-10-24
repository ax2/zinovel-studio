# alpha.27 阶段资格

当前状态：不可变标签2eb2e1b的独立发行CI40105233629首次完整success，2026-10-24 23:20:44北京时间公开。公开EXE155483341字节，SHA `8ed75c2ffcb84a80bc3f58a46b436d87346803a389aa2e75642bc4e3a3e3ccb6`；已实际下载并独立复核，四附件/三份元数据摘要/匿名可见全部通过，见ci-public/verification.json。精确公开文件保存在实际D盘ci-public，与本机8ad1985e...安装包分开。本机155项与公开alpha.3升级继续作为独立本机证据。没有新增本地执行公开EXE的声明；标签CI安装了清单对应的精确字节。稳定门禁始终false；本版106项26 verified/44 in-progress/36 planned。

本阶段增量：CAS多代完整逻辑备份、Windows原生写入锁、窗口/作品绑定目录授权、进度取消、明确选版恢复新书，以及官方Harness六配置/30次越权工具拒绝。全部产品范围未缩减。自动定时/清理、多格式出版、远端发布、文学质量和完整上架验收仍继续。

## 本机证据

- 生产源码33c949314f725d1f18003d9f1059d9b54ee07b45。后续5f311fd仅QA/文档；没有改变打包产品字节。asar SHA `f55fe862b5e445fdaca5440babf7024cf152647cc951b385a83466e42eb08239`。
- 本机EXE155483211字节，SHA `8ad1985ed0fd28171d0bf49457b876bb86afccbdd8de7c4fc07a1fc6a328d50d`。155项完整安装/运行/重装/卸载首轮通过，计时10114/15834/4870ms。EXE与注册移除，合成原稿保留。见installer-smoke.json。
- 公开alpha.3精确安装包升级17116ms通过，保留旧稿/任务/候选及测试用加密设置；候选仍需明确审阅，卸载保留数据。见upgrade-smoke.json。
- 真实安装EXE的v2备份D Disk1到C Disk0，逐对象hash、零新增重复、取消/关闭保护、重启、旧稿/图像/来源恢复、损坏拒绝四组通过，见installed/incremental-backup。其asar与本候选完全匹配。已查看实际安装深色窄窗806×803/1.25及恢复书PNG；保留在screenshots/release/v0.1.0-alpha.27。
- 原生Koffi3.1.1在实际嵌入Node24.21.0调用kernel32成功，应用内解包模块1042944字节、MIT许可1117字节均有精确hash；图像三格式/许可和DOCX17份许可同时核对。runtime-inventory.json和image-runtime-verification.json保留。
- 完整251项源码/类型/规划和20项备份专项通过，实际源码宿主四组及打包官方Harness通过。local-source-check.txt不等同CI或商店认证。

完整运行目录、EXE、元数据和整轮原始输出在实际D盘`D:\zinovel-releases\v0.1.0-alpha.27`，无ZIP。原始QA输出可能含历史失败截图，不把目录存在当成每份文件本轮通过。项目内installed JSON均已检查没有不同版本的version字段；完整安装155项回执列明实际执行范围。

## 失败与边界

首次package:win在原生模块的词法路径断言失败：归档经release Junction解析为实际D路径。此前真实模块加载和系统调用已成功；修正为original-fs真实路径后对**同一asar**重新严格验证通过，再执行打包Harness和NSIS，未隐藏失败或换产品逻辑。日志`.cache/alpha27-package-first.log`、native-path-diagnostic/fixed保留。

新增UI损坏探针首轮产品正确拒绝“对象大小或类型无效”，探针只匹配“校验/损坏”而失败；补实际语义后重新通过。更早主进程require全局假设失败也保留；详情见stage-008/vault-desktop-source.md。源/目标全部合成，不含真实稿件或凭据。

选择器结果、异常写入屏障及模型端点由QA控制；未声称真实点击全部原生选择器、系统IME、硬盘损毁或网络文件系统认证。安装版与未来CI独立重建安装包可能有不同SHA，后续公开文件必须另下载核对，不能沿用本机SHA。
