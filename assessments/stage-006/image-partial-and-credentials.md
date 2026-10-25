# alpha.31 混合候选与凭据持久性修复

状态：完整324项、类型/规划/构建通过；图像作者实际Electron8组、模型管理6组、基础桌面10组、服务凭据隔离3组通过。当前源码基线CI仍是b428c39的40165070759 success，本批修复尚待独立CI和完整安装，不继承旧资格。历史失败与推断见image-partial-work-in-progress.md。

## 混合响应与旧回执

结构化响应数量正确时，逐项固定错误与有效候选分别保留。candidateErrors只允许原序号和受限代码，不保存坏图原文、URL、私有字段或异常栈；有效候选另存sourceIndex，数组位置与原返回序号分开，原第3项不会误标第2项。新字段进入不可变responseHash；缺省时保留旧v1算法，真实前期合成回执fixture验证原hash不变。有效项与错误必须共同覆盖请求的所有位置，拒绝重复、缺失、越界及私有额外字段。

账本28项通过，包括实际混合回执落盘后子进程退出97、缺图核对未完成、错误事实被改拒绝、匹配原字节/原位置/原错误本地补存且不请求网络；重启/采用保留预留资产身份和原序号。整批无效时也是已收到响应，零图片、逐项错误、用量和取消事实均可保存，不伪装远端未知。整体JSON/MIME/数量不符仍失败，不能称所有异常响应均能救回。

## Windows当前用户凭据

新Windows写入使用带win-dpapi-v1前缀的CurrentUser DPAPI密文，直接调用CryptProtectData/CryptUnprotectData，复用已有Koffi，不增加包。仅flags=1禁用提示，不使用LocalMachine范围；密文包含受保护的格式/版本/Key/digest，严格UTF8、长度和额外内容校验。输入缓冲、解密副本及API拥有的内存显式清零，LocalFree在finally执行；JS字符串仍属临时托管内存，不声称能证明所有进程内副本归零。API规范见[Protect](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)和[Unprotect](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)。

首次Node原生往返6项通过后，实际Electron在第一次保存时退出，credential-native-first-failure保留JSON/日志，无该次有效截图，不能把旧failure.png当新截图。Koffi文档明确[Electron不支持external buffer view](https://koffi.dev/pointers#external-buffers-views)，[Electron解释memory cage限制](https://www.electronjs.org/blog/v8-memory-cage)。移除koffi.view，改decode复制到托管内存、encode清除原生内存后，实际桌面完整通过；未降低sandbox/contextIsolation设置。第一轮Node原始日志被重跑覆盖，工具输出留有当时通过，不编造独立文件。

原生6项实际检查：短Key/中文/星外Unicode/长度边界，独立子进程写密文fsync后立即exit91再解密且没有Local State，损坏/截断/未来封装拒绝，控制符/错误Unicode拒绝，Native新格式出错不回退Electron、旧格式选正确解码器，Linux basic_text拒绝。未创建第二Windows账号做跨账号实测；用户范围由固定API调用参数与系统规范支持，不夸大为全安全审计。

保留旧Electron密文读取，不静默重加密或变明文。模型管理探针明确种入真实旧Electron密文A，经正常迁移后官方Harness A使用正确Key；普通UI新建B/C使用Native格式，重启后旧A仍可解密且B继续通过Harness正确调用。HTTP[3,6,0]，服务地址变更不转发旧Key，独立3组隔离回归也通过。已丢失旧Local State材料的历史Key不能保证恢复，保留密文并需作者重输；新封装解决后续持久性，不宣称修复既有丢失数据。

## 实际作者流程

图像真实HTTP总计[文字0,选中图像B9,未选图像C0]，全程合成Key/稿件/图片。保存文件受阻→真实关窗拒绝→只本地补存；已发送取消unknown；核对PID创建身份后实际终止并重启，新密文前后readable/roundtrip均true，第5次混合与第6次全坏请求仍用同Key成功。混合原第1/3项保留、原第3项采用，私有错误不进记录；全坏无采用按钮，重启保留hash、错误、资产身份与采用事实。费用仍按原请求说明，不把坏图当免费，不自动重试。

新增实际人物与章节选择：人物返回后通过宿主修改目标，旧采用拒绝并保留候选/说明；新任务明确读当前修订可关联正确人物。章节准备后同修订外改正文，在HTTP前拒绝且外部字节保留；探针明确修复自己的合成外改后，新任务可采用该章插图。原稿与旧资源保持，作者明确的人物修改保留。未知未来缓存时采用说明只读，普通草稿与窄窗三入口仍通过。以上是基础版本目标关联，不是参考图/年龄/衣装、多视角、定妆选定、章图位置/出版的完整验收。

已查看浅色混合/全坏结果截图，8组回执绑定实际版本、main与renderer JS/CSS/HTML；之前806px深色审阅截图继续保留，新运行截图另存同目录。素材全为自行合成，真实模型协议/费用/视觉质量、原生IME/辅助技术仍待。原106项26/49/31保持，ART条目未升级verified。

源码/标签CI、安装套件与manifest已要求本探针8组、[0,9,0]、混合恢复、凭据中断保留、人物/章节版本检查及同版asar；模型清单另要求新封装和旧密文重启兼容。preview.ready=false/reports[]，下一步先推送新CI并做实际安装/重装/卸载/alpha.3升级，方能考虑31阶段标签。完整上架目标继续未完成。
