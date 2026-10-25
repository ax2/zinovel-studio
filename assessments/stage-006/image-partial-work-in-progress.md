# alpha.31 混合响应与崩溃凭据：进行中

后续更新：本文件保留修复前调查。Windows自包含DPAPI、混合UI及基础人物/章节目标已通过源码实测，当前324项/图像8组；见[修复证据](image-partial-and-credentials.md)。同版CI与实际安装仍待，不把以下历史失败改写为当时已通过。

基线b428c39的完整Development checks40165070759已success，image-partial-baseline-ci.json留证；覆盖正常图像作者5组及312项，不能替代本批未提交的混合响应改动。

当前源码：内联响应数量正确时逐项校验，保存有效图片的sourceIndex和固定错误清单；不保存坏图原文/URL/私有字段。有效项按数组位置访问，另外保留原返回序号，不能把第3项重新标成第2项。candidateErrors及sourceIndex只在存在时进入responseHash，旧v1回执的原hash保留。全坏的结构化响应也持久化为已收到，不冒充未知，不产生可采用图片。整体JSON/MIME/数量不符仍按原固定错误失败，尚未实现这些异常的救回策略。

已通过：账本28项（含实际旧v1合成回执原hash、混合回执/采用/重启、全坏响应、重复/缺失/越界位置与私有字段拒绝、实际进程退出后匹配原字节/原位置/原错误补存）；传输新增混合PNG/WebP与坏base64的真实HTTP检查，原坏图单项测试改为断言零有效候选和受限错误，原数量不符仍拒绝。三个相关模块在旧回执测试加入前48项通过，随后账本28项通过；完整套件尚未重跑。首次43项中的1失败为旧测试仍要求坏单项抛整批异常，原始image-partial-first-tests.txt保留，不以新语义放宽图像或资源上限。

混合UI已接逐项结果及原序号，探针新增第5次混合请求、第6次全坏请求、采用原第3项与完整重启核对，manifest要求6组/HTTP[0,6,0]/mixedBatchRecovery=true。该探针目前失败：实际主进程终止并重启后，新任务在独立模型与系统凭据核对时拒绝，尚未进入第5次HTTP，因此没有混合UI或安装通过资格。不得设置该flag或开启preview.ready。

## 凭据崩溃复现

三轮实际失败分别归档first-ui-failure、second-ui-failure、crash-credential-failure。第三轮仅使用本测试的合成Key与密文做本机布尔探针，不导出明文或密文：强制终止前available/readable/roundtrip全true；新进程available/roundtrip为true，原合成密文readable=false。业务调用准确拒绝在解密核对之前，不向图像端点发送错误Key。诊断新增固定阶段名，仍不反射codec原异常。

中断前与刚重启时，测试dataRoot的Local State未观察到os_crypt.encrypted_key；失败等待后文件出现os_crypt的audit_enabled/encrypted_key字段，仅记录字段名。两次缺省fingerprint导致原探针wrappedKeyChanged=false没有证明意义，已改为null，不据此声称key未变或已证明具体写盘时序。

与固定版本[Electron44.7 safeStorage源码](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_safe_storage.cc)及[BrowserProcessImpl源码](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/browser_process_impl.cc)相符的推断：同步safeStorage使用OSCrypt，持有Local State偏好中的加密材料；偏好正常退出会CommitPendingWrite，首次保存后立即崩溃可能先于持久化。当前证据已证明旧密文崩溃后不能读，精确偏好写盘时序尚未做跟踪，不把推断写成所有版本/所有用户必然如此。

下一步先实现并实际验证Windows当前用户、自包含、带版本前缀的DPAPI凭据封装，复用已有Koffi而非增加依赖；保留旧Electron密文解码兼容，不能静默改成明文。再从全新合成环境实际重复强制中断、验证原Key可继续用于第5/6次调用，补混合UI/全量检查和完整安装。已丢失旧加密材料时不能承诺恢复原Key或在探针中重新输入同Key掩盖问题。保持原中断步骤与失败证据。

当前只是源码推进，无31安装/发行资格，106项26/49/31不变。先修凭据崩溃持久性，再完成混合批次证据、人物/章节UI目标及阶段安装发行；完整视觉/出版/上架范围继续保留。
