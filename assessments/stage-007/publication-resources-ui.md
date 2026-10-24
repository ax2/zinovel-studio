# alpha.25 带图发布作者流程源码验收

2026-10-24。完整225项/类型/构建、原schema1五格式源宿主与HTML/PDF/DOCX独立回归通过。新增实际流程：作者选本书图像版本 → 封面/所选章开头或结尾 → 明确公开替代文字/图注/署名 → 冻结 → 改图/回收/重启核对旧图 → HTML原生目录选择（结果替换） → 独立file阅读。源码报告screenshots/stage-007/publication-resources/publication-resources-smoke.json；没有alpha.25安装资格，不继承alpha.24。

| 检查 | 结果/范围 |
| --- | --- |
| 身份/非空/控制台 | 实际ZiNovel Studio作者窗口、正文编辑器与发布对话框存在；无pageerror、相关console error或HTTP请求 |
| 表单迁移与暂存 | schema1旧表单明确编辑后写schema2；空替代文字可暂存、关闭再开仍空，捕获被阻止直到修正；未知字段保留并锁定原有机制继续回归 |
| 明确范围 | 作者选两图和两章，第三图/第三章与原图私有source/rights/notes不进入HTML；公开图注中的script字面显示且不执行 |
| 原图/旧副本 | 原生JPEG方向6在发行图为100×160，像素不降采样；实际host替换并回收当前图，旧副本dataURL/hash不变；再次捕获因旧资源基线拒绝、无第二份假快照；宿主重启后旧图保持 |
| 预览授权 | 预览先按bookId/id/hash读取副本，再核对索引和图字节；非法索引拒绝，跨书来源在存储测试拒绝；不接受任意路径或Renderer提供图片内容 |
| 格式边界 | 带图副本仅HTML；TXT/MD/PDF/DOCX option.disabled均true，实际host直接PDF请求在目录选择前拒绝，不静默丢图；无图副本五格式仍通过 |
| 输出与取消 | 取消不产生文件；中文空格目录生成两张固定PNG和HTML目录/章节/CSS/脚本，逐文件大小/SHA匹配，原稿精确字节不变 |
| 独立阅读 | Electron44自带Chromium独立file页面，没有小说preload/Node；封面与章尾图实际解码，导航与深色偏好重载通过，无HTTP请求；不代表物理手机或其他EPUB阅读器 |
| 实际渲染 | 已查看1426×923作者选图、806×803深色冻结封面及390×844深色独立HTML章尾图，无横向溢出；长表单按容器纵向滚动，不把截图中焦点滚动位置当截断 |

首次新UI探针在Playwright option.isDisabled断言返回false时中断；已保留失败PNG/JSON和日志到.cache/alpha25-resource-ui-first-evidence及首轮日志。第二次核对原生option.disabled：HTML=false、其余4种=true，且host拒绝路径通过；未改变产品禁用规则。HTML生产者接入后旧“有图一律拒绝HTML”单测改为缺少发行图时拒绝，并新增精确图片/hash/转义/范围测试，保持验证强度。失败不改写为首次通过。

实现选择：图像选择器按展开状态读取、搜索150ms合并，单页40条，不静默更新已选版本；预览native解码排队且最多32项待处理，避免同时解码32张大图。PNG转换至多2项，始终在书稿队列外；读写不可变blob/提交核对才进共享队列。HTML每份最多128MiB去重图像保护，未实际验证该上限的大图负载/P95，不扩大225项为性能或原生IME认证。

下一步：固定源码/CI、打包原生图像/许可、实际安装后的同流程、重装/卸载保稿和公开alpha.3升级；齐备后才开放alpha.25标签预览，发行同标签需再次完整验证。EPUB、DOCX/PDF插图、目录域、人物定妆生成及完整上架仍单独待办。
