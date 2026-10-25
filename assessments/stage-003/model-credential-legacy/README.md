# 更换服务保留旧Key：合成负面复现

model-credentials-smoke.json状态confirmed-vulnerability，**不是通过报告**。真实源码桌面alpha.28设置UI先保存服务A的合成Key，再更换不同端口服务B且留空Key；官方Harness三次B请求均匹配旧Key。记录只存header比较布尔值，不保留真实header或Key。alpha.27源码使用同样设置逻辑，Release说明已补换服务前清除Key的提醒。

最初QA少传target.body，被正式章节守卫拒绝，.cache/alpha28-credential-before.log保留；补完整目标后成功复现，.cache/alpha28-credential-before2.log和此JSON为实际负面结果。目录内failure.png若存在来自最初无效目标探针，不当成产品截图或后续通过证据。

alpha.29用完整服务地址规范化绑定密文；更换服务不带新Key则清空旧密文；旧配置可兼容，外部地址/scope不匹配解密前拒绝。具体源码/安装资格分别记录，不能用后续修复覆写此复现。
