# 认知资料接入Agent：1338698源码研究

2026-10-24，alpha.13设计与实现记录，不混入alpha.12安装源码。以下接口方案已经实现，实际验证与限制见 assessments/stage-004/knowledge-context.md。

现有链路：context-selector.tsx显式选择→materials.context→MaterialStore.contextPack共享队列冻结→main.ts发起前重读hash→runtime materialContextText预算/持久任务快照→tools-plugin novel_materials_read读取单次冻结snapshot，参数必须为空，不能任意查询书库。预算已限制8份/2万字符，通用context合计12万字符；工具allowlist随是否有快照决定第三个工具。

选择复用现有资料快照读取工具，不创建平行的通用认知查询工具。增加类型化引用material / knowledge-event / knowledge-choice，宿主同书校验、共享队列一次冻结。全体类型合计8条/2万字符，不分别放宽；超限拒绝，不静默截断。旧materialIds-only调用继续支持。独立知识上下文ID要命名空间化，不能把可能与资料卡相同的UUID混成一种身份。

MixedContext在同一exclusive里读取各服务的内部record/view，不嵌套调用已有带exclusive的contextPack，否则死锁。可提炼materials.contextEntries内部只读操作。查询参数只是同书类型化ID/选择身份，不接任意文件路径；作者选择按命题/范围/人物定位，不能把客户端传入的快照当成权威。

每条认知展示范围、人物、状态、说明、故事时间、来源章节/引文和有效性；命题内容仅解释该事件含义，不附带未选作者真相设置或其他人物的事件。UI发送前预览必须明确包括哪些派生题名/命题/引文。作者真相不等于正文事实，作者当前选择也不是自动故事时间结论。旧来源未变/已变提示独立展示，未读文件不能在报告称已读。

快照hash必须含事件/当前选择原始hash、当前正文/定义有效性及来源链状态。发送前变化零模型请求阻止；真实任务恢复保留原快照，后续改稿不能改历史。未选同书记录和他书哨兵不得进入提示词或工具返回。云文学效果仍另验，fixture仅验证数据与权限边界。

实施门槛：单位同书/跨书、同版本外改、choice变化、来源损坏、字数总限、ID跨命名空间冲突；真实Electron+官方Harness fixture零请求预览/陈旧阻止、受限工具实际读取、重启后快照固定；旧资料、资料提案、试写及预算套件回归。三处作者上下文入口（正文、资料、试写）都要明确支持或禁用，不只接一个表面UI。

## 可实施接口方案

为减少三个助理入口参数漂移，ContextSelection.ids继续用string[]：资料为原UUID（完全兼容），新认知为knowledge:<UUID>，作者选择为choice:<命题UUID>:<world|reader|character>:<人物UUID或->。宿主严格解析，绝不当路径。主进程所有快照构建点（materials.context、正文/资料/试写任务与estimate）转到同一个MixedContext服务，不只修改渲染器。选项列表新增来源类型和40条分页，保留旧资料搜索行为；新列表须可取消，避免200ms筛选堆积大书扫描。

实际采用MixedContext在一次共享exclusive中调用内部record/view；纯资料选择直接委托原contextPack，保留旧包结构/hash，没有额外提炼contextEntries。knowledge/choice条目id命名空间化，kind为knowledge-event/knowledge-choice，仍在materialContext.materials[]中，由既有受限工具读取，不增加任意查询权限。

对choice列表可扩展choices.project支持null筛选和可选同步visitor，逐文件只收集40条轻量选项/总数，不把全书冻结raw快照数组留内存。原矩阵仍传限定Set和人物列表，不改变行为。

快照content只含明确所选事件的范围/状态/说明/当前有效性/命题含义/引用人物题名/本条正文引文；choice使用冻结旧事件而非后来最新事件。不得自动附带命题作者真相设置、人物其他资料、其他认知或旧来源完整引文。选择原资料卡则仍按旧完整资料规则发送，UI预览明确哪些派生内容一并发送。停用/清除/失联/无法解析项目应拒绝或禁选；允许待复核内容时必须显式标旧，不能称真相或自动当前状态。

仅hash文本和freshness不够：当来源已stale再改一次，其标签仍stale，不能误以为快照没变化。每条额外proofHash应聚合当前事件原文件hash、choice原文件hash、引用定义当前hash、当前章节正文hash/删除状态、origin文件hash及其旧owner当前hash。只发聚合hash，不把未选的定义笔记/旧资料全文泄露给模型。pack.hash含proofHash与可见content，发起前任何相关改动都0模型请求拒绝。读取坏UTF-8或未来格式不当作已无记录；保留原文件。

所有任务继续走materialContextText的统一8条2万字符限额和runtime总上下文预算，不为每种类型开独立上限。输出JSON有少量元数据额外字符，模型调用的真实工具输出仍由既有预算检查，不能宣称文本字符数等于账单token。任务恢复读取冻结snapshot，不根据新库状态重生成历史；后续作者选择变化不能改旧请求。
