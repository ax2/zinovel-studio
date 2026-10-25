# alpha.32 写作窗口崩溃恢复专项

alpha.31标签7cb30267d98206cbc3d5df7425442ca5f5bef78a已冻结，本专项属于后续32源码；31的独立发行CI40169223370尚在运行。未改31标签、未借31安装资格。

之前普通关窗与整个主进程强制终止已实测，renderer-only分支缺少独立证据。本轮在真实HTTP已返回、实际文件系统障碍导致候选未保存时，调用实际webContents.forcefullyCrashRenderer，只终止渲染进程。主进程PID不变、新渲染PID不同、窗口仍唯一，原生产恢复处理器进入原生选择界面；探针只替换选择结果和记录选项，不替换恢复实现。含待补存图片时只有“重新打开”，无退出选项，恢复后同一任务和待保存字节仍在，界面可继续只补存，HTTP计数不增加。

完整图像9组通过、请求[文字0/选中图像B9/未选C0]，既有混合/全坏、同Key主进程中断、人物和章节目标、草稿、窄窗及旧图/原稿保留继续通过。完整pnpm check（类型/324项/规划）通过，应用32重新构建。9组JSON绑定实际main及renderer JS/CSS/HTML；截图和原始日志见screenshots/stage-006/image-renderer-recovery与同目录txt。已查看1426×923、1.25缩放浅色恢复后界面：待补存横幅与按钮可达，障碍仍在时如实显示原图不可读，采用禁用；随后仅移走自己的合成障碍，本地保存通过。

## 探针失败与修正

第一次提前等待domcontentloaded，该等待被预期的page crash事件拒绝。第二次把原生选择改为暂停，先接收crash事件，再等待新文档并选择重开；文档事件到达，但旧Page操作仍报Target crashed。核对本机固定Playwright1.56.1的server/page.js，_didCrash永久关闭该Page的操作scope；不能把它当应用没有恢复，也不能通过多刷新应用伪造恢复。

第三次从本应用自己的DevToolsActivePort读取端口，尝试用HTTP发现重新连接，本机返回503。改为使用同一文件的完整本地WebSocket路径，省去HTTP发现；没有修改全局代理。第四次连接已由应用自行恢复的原窗口，未追加导航或reload，实际UI继续操作通过。所有三次原始失败JSON和日志独立保留在renderer-recovery-first/second/third-probe；失败阶段没有可确认的新截图，未挪用旧failure.png。

增加9组和rendererRecoveryRetainsPaidResult的安装manifest要求；32 ready=false/reports[]，没有32安装/升级/发行资格，尚须新CI。目标复评仅完成设计，运行时仍按原目标版本拒绝，未宣称可复评采用；参考图、人物变体、定妆、封面、章图位置和带图出版原需求不缩减。106项26 verified/49 in-progress/31 planned不变。
