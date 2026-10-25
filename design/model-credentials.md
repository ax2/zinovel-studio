# 模型服务与凭据绑定

alpha.29安全修复，承接OPS-06与OPS-01的基础保障，不冒充完整多模型/文字图像能力路由已完成。

后续进展：alpha.30已增加独立配置与文字路由；alpha.31增加独立图像调用，并把新Windows凭据改为自包含CurrentUser DPAPI封装，保留旧Electron密文读取。首次新Key保存后强制中断及旧密文重启兼容已通过同版实际安装，见[31阶段资格](../assessments/release/v0.1.0-alpha.31/README.md)和[原生凭据修复](../assessments/stage-006/image-partial-and-credentials.md)。已丢失旧加密材料的Key不能因此恢复；以下alpha.29历史安全问题、服务绑定规则和负面证据继续保留。

## 实际问题与处置

旧ModelSettings保存新baseURL时默认保留existing.encryptedKey，原界面Key留空提示保持原值。合成环境中先保存服务A的假Key，再通过真实设置界面切换到不同端口的服务B并留空，官方Harness对B的三次真实请求全部携带A的假Key。证据assessments/stage-003/model-credential-legacy/model-credentials-smoke.json，状态confirmed-vulnerability；不含真实凭据，header只记录布尔比较。首次探针少了target.body，被正式章节守卫正确拒绝，补完整目标后复现，旧日志保留。

alpha.28标签发行在源码离线探针初始导航evaluate失败，未进入打包，未发布。原158项安装/升级机器报告保留，但新增凭据负面证据撤销本机资格，不重跑发布旧标签。最新公开alpha.27及沿用旧设置逻辑的版本也受影响，Release说明与使用文档提示：更换服务前先清除已存Key，再为新服务输入。修复的29需重新完整验收后发布。

## 新规则

服务身份为实际用于模型请求的规范化完整baseURL（协议/主机/端口/路径），不只比主机，防止同网关不同租户串Key。HTTPS或明确loopback HTTP；不允许用户名/密码/查询/片段。末尾斜杠规范化幂等，字段长度有界。

模型名称变化且服务相同可保留Key。服务变化且未明确输入新Key则清除旧密文；同时clear和replace拒绝。界面改地址也清空未保存Key输入，避免刚为A输入的Key跟着地址改动去B；保存前明确提示，取消不改磁盘。

model.json v1保留schemaVersion、credentialScope与密文。老无版本文件在读取时按其已保存地址解释旧密文，不自动改文件；首次明确保存写新格式。若外部修改baseURL但scope不匹配，public报告不匹配/不可用，secret在解密前拒绝；不改原密文。未来schema/损坏文件拒绝读取和保存，原字节保留，错误不包含原内容。OS安全存储不可用仍不得明文回退。该元数据绑定不是对同一OS用户恶意修改文件的密码学防护，DPAPI边界保持原状。

## 真实验证与剩余范围

3项规范化/策略/非法输入单元检查，真实Electron设置界面与两个loopback服务检查旧配置生成、换服务零请求拒绝、新Key三次Harness调用、取消字节保留、外部scope不匹配和未来schema字节保留。正式稿从不自动接受候选。只使用合成Key，不输出header原值，不称真实供应商/系统IME通过。安装与发行继续按同版本精确字节验证。

完整OPS-01仍包含多模型配置、文字与图像能力分别选择和可见失败，后续应使用独立profile ID与各自加密Key，任务冻结当时的服务/模型/预算。图像服务不能借文字profile的Key或被文字模型名称推断成可画图；连接测试必须作者明确发起、固定非正文输入、错误不带响应体。本安全切片不能代替完整能力接入，也不提前将OPS-01标完成。
