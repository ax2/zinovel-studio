# alpha.33 进程恢复验证修正

alpha.32在同标签源检查成功后，安装流水线40173249996于旧任务强杀辅助代码失败，未公开Release。详情见../release/v0.1.0-alpha.32/ci-first-failure。33延续32的复评功能；人物形象/参考图仍未新增运行时实现，完整106项26/49/31不变。

Windows QA由“核对快照后按PID taskkill”改为打开带TERMINATE/QUERY_LIMITED_INFORMATION/SYNCHRONIZE权限的句柄，对同一对象核对GetProcessTimes完整100ns创建时间后终止和等待。句柄保持到确认退出再释放，PID重用不会把动作移向另一对象。已退出对象或终止时已退出可确认成功；活着但拒绝访问、创建时间不可读、WAIT_FAILED或超时仍失败，句柄finally释放。原生快照用进程句柄信号排除已退出对象，不依据未定义的活动exitTime。[微软API说明](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)支持此做法，原失败时的精确内核时序未记录，仅将其归为退出竞态相关证据。

13项通过：原4项加6项确定性句柄状态/失败检查、1项同毫秒不同100ns祖先过滤和2项实际Windows子进程检查。真实检查保留一个无关活子进程，错误创建时间不触碰目标，正确身份可结束目标且不碰旁边进程；另持有退出子进程的原生句柄，快照仍能确认不再运行，再检查不把它当活对象。只操作自行创建子进程，不列出命令行、进程名或凭据。

完整346项/类型/规划通过，重建33后任务恢复3组及图像11组通过；真实桌面/官方Harness树强制停止后仍恢复interrupted和部分提案、无重放。图像继续覆盖renderer-only恢复、付费候选补存、同Key中断、混合批次和目标复评，HTTP[0,9,0]。这些是33源码证据，没有33安装资格；ready=false/reports[]，下一步实际安装、alpha.3及公开31升级后才可发布新标签。

强化复跑另暴露测试脚本在终止后向已断开的Playwright对象查询PID，随后一次修正放错局部作用域；两次失败日志保留于本地.cache。现于终止前捕获PID并严格断言根进程实际terminated，最终任务3组、流式3组、图像11组均通过，HTTP[0,9,0]，不接受根进程提前死亡作为强杀成功。tasks报告另绑定源码bundle/安装asar及版本；33安装清单新增此回执门禁。
