# alpha.31 图像传输后端源码切片

状态：10项专项与完整278项源码/类型/规划通过；尚无宿主、持久任务、作者图像界面或本版安装资格。现有图像profile仍runnable=false，没有把已保存配置自动变为可用生成。106项26/46/34保持，不把源代码模块当完整绘图流程。

实现novel-domain/image-generation.mjs请求与手填预算校验，现有模型配置复用同一预算函数；novel-harness/image-provider.mjs只负责明确接口模式下的传输及候选解码，不解析profile、不读作品、不采用图像或开放IPC。文字Agent仍使用固定官方Harness。

实际本机HTTP fixture核对：租户路径原样拼接/images/generations，独立A/B合成Key不串用；发送意图回调前冻结请求与Key，之后外部对象修改不改变请求；默认base64模式不添加response_format，明确请求模式才添加b64_json。PNG/JPEG/WebP原字节hash/真实解码和缩略图均验证，不只测头部。未知单价/用量保留null，不当零；回报用量只允许有限非负整数白名单，忽略私有字段。

响应上限64MiB、单候选10MiB、最多4张，提示词8000字符；均为资源保护边界，不称性能资格。测试无Content-Length的65MiB真实分块响应在累计上限处拒绝，另测声明超限、非法UTF8/MIME、URL-only、坏base64、坏图、数量不符、429、重定向和无意图/取消。跳转目标零请求；不抓取返回图片URL，不读错误体、不保留原始供应商异常。所有凭据为合成，只比较身份，不记录真实Key。

真实请求发送后取消和100ms截止时间均返回远端结果未知，不自动重试。结束读取正文的受控检查点触发取消后，已收到的可解码候选仍返回并标记interruptedAfterResponse，不能伪报什么都没收到；检查点明确由测试包装实际HTTP Response实现，不称真实供应商竞态验收。后续持久任务必须在beforeDispatch保存发送意图，并保存成功迟到候选；当前只有回调约束，没有宣称已经实现崩溃恢复。

小数预算先用3×0.1与0.3边界真实复现二进制浮点误拒绝（9通过/1失败），改为基于存储数值十进制表示的整数系数/指数相乘比较；精确边界通过，0.10000000000000002×3真实超额仍拒绝。此为作者手填估算，不能保证供应商实际收费。原始失败image-transport-decimal-before.txt及最终image-transport-check.txt保留。

后续：明确适配选项、profile修订检查、持久任务与恢复、所选参考/用途冻结、审阅候选、唯一BookStorageKernel采用、真实桌面/安装与供应商验证；详见design/image-generation-delivery.md。人物定妆/变体、地图底图、封面、章图和来源分别验收，需求不缩减。alpha.30不可变标签仍在独立发行，本模块不属于其EXE。
