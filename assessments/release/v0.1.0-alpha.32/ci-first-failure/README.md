# alpha.32 标签安装流水线失败

不可变标签eb457359083e19053386e5b6b03cfef6a7002ecc，Windows release40173249996于2026-10-25 07:42:53 UTC在实际安装套件的smoke-tasks.mjs失败，未到两个升级、最终manifest或附件上传。正常主线检查40173247491同提交success，不能代替安装资格。alpha.32没有公开Release，不移动或重跑旧标签来等待偶然通过；后续33修复并重新构建验收。原本机178项及两次升级报告保留为历史，不用于33资格。

CI基本桌面检查已通过，任务探针第一组完成接受/撤销；第二组准备强制终止时，taskkill.exe报告PID 8760无运行实例，但随后快照仍有相同创建时间，旧辅助代码立即抛错。两份实际失败JSON分别保留status=failed（任务1组/安装累计12项），原始步骤日志和CI摘要在本目录。未保存当时的进程句柄等待状态，不把“残留对象或退出竞态”的推断说成已精确重现当时内核时序；独立本机测试随后覆盖了保留已退出进程句柄的情况。

失败artifact12591187585在内存读取压缩HTTP数据，只提取指定JSON，不写ZIP，artifact-read.json记录文件。没有可确认的该次新失败截图，未拿仓库中的旧PNG冒充。失败的CI安装EXE未上传，未声称已下载复算；本机不同字节的32完整目录与EXE仍保留D盘。

修正方向：同一已核对创建时间的原生句柄用于TerminateProcess和WaitForSingleObject，等待真实退出，快照排除已确认退出的对象。保留完整100ns创建时间以拒绝同毫秒内PID复用。拒绝访问、未知身份或等待失败仍不算成功，不按英文错误文案放行。参考微软[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)和[WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)；进程终止异步、对象可因句柄而保留，需单独确认退出。GetProcessTimes的活动进程exitTime未定义，因此不拿它猜退出状态。
