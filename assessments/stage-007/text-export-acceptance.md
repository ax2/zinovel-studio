# PUB-01 文本合订导出验收

2026-10-24，按“章节顺序/编码/首尾核验”的既有验收条目检查，文本 TXT/Markdown 路线已经通过 alpha.17 的本机实际安装资格。PUB-01 从 in-progress 更新为 verified。此处仅验收文字合订，不提升独立HTML整体、带资源快照、EPUB/DOCX/PDF或网站发布。

| 条目 | 可追踪证据与结果 |
| --- | --- |
| 明确选章及顺序 | tests/publication-storage.test.mjs 与 scripts/smoke-publication-ui.mjs：只选两章、反转顺序、未选第三章/私人资料不进入产物；真实安装版相同界面操作通过 |
| 原文编码和首尾 | tests/publication.test.mjs 核对全部首末正文字符串、卷标题不重复、末段完整；tests/publication-export.test.mjs 实际TXT/MD字节、BOM/CRLF/生僻字/emoji、首末段顺序全部通过 |
| 坏原文不改写 | 编码8项负向回归及安装版 installed-utf8-integrity.json：损坏UTF-8拒绝读取/导出，原字节保留 |
| 冻结与来源 | 捕获后正式稿、表单改变不进入旧副本，重启后实际导出仍读原hash；保存错误/外部冲突拒绝，不猜测章节 |
| 实际目录写入 | 安装版 installed-publication-ui-smoke.json 逐文件核对字节/sha；真实Windows原生目录额外探针选中文空格目录，TXT及清单通过，源稿不变 |
| 不覆盖与取消 | 原生目录取消不创建文件；重复导出ID拒绝覆盖、无关文件保留；生成新子目录，逐文件核对后才显示完成 |
| 实际安装 | assessments/release/v0.1.0-alpha.17/installer-smoke.json，精确本机EXE哈希d73dba9269091592c417ccb039435ac5cfefee38859a077d92cae2229c9b5ab7，116条检查通过，重装/卸载/alpha.3升级保稿 |

回执：assessments/release/v0.1.0-alpha.17/installed-publication-ui-smoke.json、installed-publication-capture-smoke.json、installed-utf8-integrity.json；原生选择报告screenshots/stage-007/publication-native/native-export-smoke.json。阶段标签CI和公开附件需另外核对，不能用本机哈希替代。

边界：输出UTF-8，不宣称任意编码选择；快照32MiB上限暂定。无封面/插图资源，其他格式和远端发布未验收。大书极限性能、真实手机、系统中文输入法及辅助技术不因本条通过。其余PUB条目保持原状态，稳定版资格仍为false。
