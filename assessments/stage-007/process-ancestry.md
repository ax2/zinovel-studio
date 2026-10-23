# Windows 验收进程归属与查询修正

alpha.16 首次安装完整套件在独立阅读的退出核对失败，已执行的阅读检查全部通过，但不能因此算作完整安装资格。原始报告保存在 installer-first-failure/。存活条目 PID42564 的创建时间为 2026-10-16，早于 2026-10-24 本次应用启动；只读盘点确认它是早先的 pythonw.exe，父编号 42492。Windows 父编号可能在父进程退出后保留，旧算法仅按 ParentProcessId 纳入后代，会把编号重用后的无关旧进程错误纳入。没有终止该旧进程，未把它归因于程序泄漏。

改为同时校验每一代创建时间：后代不得早于当前父进程；不可读时间拒绝确认归属。原属集合按父进程先于子进程建立，终止逐个核对编号及创建时间，移除 taskkill /T，防止其内部仅按编号追踪的树越过归属校验。最初尝试先终止子进程，任务宿主将正常的子退出持久化成 failed，无法复现意外强退；该失败回归保留于 process-ancestry-validation。修正为先停止宿主，再逐身份终止原属后代，恢复用例仍要求 interrupted，不能放宽为任意终态。

下一次回归遇 PowerShell 清单查询原 15 秒超时。单独两次只读测量在 45 秒预算下仍超时（46,225 / 47,651 ms，均无返回记录）；单纯输出 1 的 PowerShell 5/7 启动也用时 13,707 / 13,451 ms。未查明底层延迟原因，不重启服务或改动主机安全设置，也不把放宽进程消失断言作为解决方案。最初行内诊断命令存在引号错误，未作为耗时证据；之后用独立脚本取得有效测量。

验收工具改用 Windows Toolhelp 进程快照和 GetProcessTimes 的创建时间，限定查询权限，逐个关闭进程与快照句柄。只返回 ProcessId/ParentProcessId/CreationDate，不输出可执行路径、命令行、正文或凭据。Koffi 3.1.1 仅显式加入开发依赖（同版本已由 Harness 依赖引入），不增加小说功能或生产权限。只读实测 747 个进程约 25.7ms，当前测试进程/父编号与 Node 一致，旧 PID42564 的毫秒创建时间与之前 WMI 记录相同。纯算法新增编号重用、旧后代和不可读时间回归；Windows 实际盘点测试检查当前进程身份和返回字段范围。原生调用规格依据 [PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w)、[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) 及 [Koffi 输出参数](https://koffi.dev/output)。

当前还须新工具的安装后任务/流/阅读/编码回归、完整安装/重装/卸载、跨版本升级及本版公开发行核验。不会把当前源码 CI 或失败安装当作发布证据。

原生工具实装回归四组均通过：任务16,284ms、流11,219ms、阅读4,697ms、编码/备份1,572ms；强退仍确认6个原属身份退出，阅读/编码5个身份退出，未放宽interrupted或字节保护断言。完整137项检查通过。首个合成安装已用其自身卸载程序清理，EXE与注册项均消失、稿件hash保持86893eb1f06cff67bf1792bf0120a62126c16a39a0383d66970552c8f59b6434；完整旧候选目录/EXE保留于release/candidates/v0.1.0-alpha.16-b47e3a4，无ZIP。新源码仍须重新打包和完整资格。
