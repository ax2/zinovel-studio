# 本地模型设置迁入

2026-10-27：独立 feature/model-settings-import 工作目录开发，alpha.41 候选程序保持冻结。当前仅有宿主纯解析层和合成测试，尚未接入桌面或可调用协议；MODEL-01 的完整验收仍未完成。

## 解析与秘密边界

`previewModelImport(source, bytes)` 接受最多1MiB原始UTF-8，返回不含密钥值的 preview 与仅宿主持有的凭据访问闭包。预览源hash覆盖整个文件，包括凭据变化；确认时宿主须重读文件并匹配hash，再从本次解析结果选择明确的候选。闭包不传IPC、不写日志，不把整份配置放入任务或新书；取消/到期调用dispose。

WorkBuddy按models.json数组读取已知字段。自定义协议标志不能当成Chat协议；未知vendor保留协议待确认。Codex用smol-toml真实解析器，依据所选provider的wire_api区分Chat/Responses，只登记env_key引用，不读取环境或auth.json。默认登录模式标login-session，不产生API Key。缺失服务地址或协议都不自动猜测。

DSH只读取官方Messages适配器的静态模型/地址/凭据字段，不载入模块，不执行插件，不求值!!js，不展开YAML别名。未知tag、别名、重复键拒绝，错误仅固定code，不返回可能含Key的解析器诊断。多层Cordis patch的有效配置解析仍待实现；不能把单文件候选当成整个DSH的最终生效配置。

尚待宿主实现：用户主动选择来源/文件、普通文件及大小复查、明确本机环境引用授权、一次性有期限的预览令牌、重复候选与名称冲突、原子新增和系统加密。只新增、不切换默认，不带入来源的请求头、插件、命令、自动执行选项。实际服务/协议改变继续清空旧Key绑定。

## 真正可调用的协议

沿用固定官方Harness Agent。新传输插件通过官方LlmAdapter注册openai-chat/openai-responses，不引入Pi Agent，不将导入路由假装为anthropic-text。需要修改模型引用/配置验证、运行时provider选择、任务冻结及批量模型语义身份，验证旧anthropic任务仍可读取。

Chat需要处理多分片文本、按index累计tool_calls及工具结果、结束原因和usage；Responses需要按item_id/output_index处理function_call参数、function_call_output和明确completed/failed/incomplete终态。不能收到HTTP200或EOF即认定成功。工具参数完成前不执行，不支持的选项明确拒绝。

官方参考（本日核对）：[Responses流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Node工具调用](https://github.com/openai/openai-node/blob/main/docs/tools.md)、[流式指南](https://developers.openai.com/api/docs/guides/streaming-responses)。Harness契约以固定687f282e的docs/user/develop/practice/llm-adapter.zh.md和packages/llm/llm/src/types.ts为准；每个block-start有对应block-end、usage先于finish、finish最后，HTTP请求带attributionHeaders和取消signal。

验收必须实际启动官方SDK/Agent，经本地合成Chat/Responses服务完成两轮小说工具调用、Unicode增量、usage/预算、取消、断流、错误/截断及重启远端未知无重放。之后再进行真实服务兼容与安装/旧配置升级验证；仅解析层测试不授予可调用或发行资格。
