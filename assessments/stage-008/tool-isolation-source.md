# alpha.27 正式权限探针

状态：源码专项已通过，未形成安装版资格，LIB-08/OPS-06保持in-progress。

scripts/smoke-tool-isolation.mjs使用真实官方SDK与Harness，受控SSE模型尝试调用工具，不直接调用插件execute冒充完整Agent回路。三种任务（正文、资料、试写）分别组合有/无显式参考资料，共六个真实配置；每组先发五种越权调用，再正常读取、读取显式参考及提交有效候选。

30次越权调用包括未知执行工具、读取工具携带他书ID/路径、提案工具携带他书ID、串用其他任务模式的提案工具、未授权资料读取或已启用资料读取附带他书参数。每个实际tool_result均is_error=true；后续合法调用仍成功，候选为awaiting-review，任务始终绑定原书及原章/资料/试写ID。对整个两书目录逐文件hash比较无变化，所有请求不含另一书正文/资料或本书未选资料的秘密标记；广告工具集严格为对应两项或三项。

测试使用合成书库、合成Key和本地受控模型，不记录提示词全文或真实凭据。回执screenshots/stage-008/tool-isolation/tool-isolation-smoke.json；临时四案例原探针保留为历史证据，本轮整理为跨机器可运行脚本并加入源码/发行CI。

此专项不证明真实模型的文学质量，不把source NovelHarness执行称为安装EXE验证。宿主IPC在正式请求前拒绝他书chapter/material/pilot引用、资料注入的完整模式覆盖、安装版和重启并发仍需独立验证，不能据此直接晋升功能verified。
