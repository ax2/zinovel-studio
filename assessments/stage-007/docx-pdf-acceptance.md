# PUB-03 DOCX/PDF 导出单项验收

范围修正：此报告记录alpha.24的纯文字子项，不能代替design/publishing.md中图片/目录/注释等完整要求。alpha.25复评后PUB-03恢复in-progress，详见[完整范围复评](publication-scope-reassessment.md)；下列历史实际通过证据继续保留。

2026-10-24，按既有“分页/字体/中文真实渲染验证”验收条件检查，alpha.24本机安装139项与alpha.3升级通过，源码CI40077751136完整success。PUB-03可标verified；这是纯文字导出条件，不代表整个出版流程或完整上架。

| 条目 | 实际证据 |
| --- | --- |
| 冻结输入与公开范围 | 两格式仅用校验后的冻结选章，反向章序、捕获后改稿、未选章和私有资料排除；安装版publication-ui.json逐文件hash核对 |
| 原生文档与编辑 | DOCX真正段落、Title/Heading1、页码域；安装导出由Word实际编辑保存，独立比对9→10段、原文前缀和源hash不变 |
| 中文与字体 | PDF独立解析字体/Unicode和PDFium栅格；DOCX由独立原生Kit和Word读取，罕见字/emoji计数准确，回退字体由阅读器决定 |
| 分页与长文本 | PDF长文A4/A5三组21/8/65页；DOCX Letter/A4/A5三组6/6/28页，超长题名/网址/尾段完整，所有字形在纸张内、页码逐页精确；总览和代表页实际查看 |
| 安装后实际产物 | alpha.24/pdf-output.json、docx-output.json及native-word-*报告；实际安装EXE产出、阅读器各3页，不使用源码文件替代 |
| 失败与不覆盖 | 取消不建目录，独立目标/临时文件/hash原子提交；PDF打印失败后清理重试、源宿主实际崩溃/90秒超时拒绝；不将源故障探针扩大为安装版故障注入 |
| 精确发行候选 | alpha.24本机installer-smoke.json139项，upgrade-smoke.json；本机EXE SHA a001f8db1c05a8ba480bb46b0c0213120746dfd53f9088845da6c1a1ed53cf5d。公开CI字节须另行完整验证 |

证据入口：design/publication-docx.md、design/publication-pdf.md、assessments/release/v0.1.0-alpha.24/README.md、screenshots/stage-007/publication-docx-layout/layout-smoke.json及publication-pdf-layout。公共DOCX/Word改存文件不作为仓库附件，仅保留合成图片、摘要和验证报告。

边界：纯文字，无图片/封面/目录域嵌入；没有DOCX/PDF导入，不等于PDF/UA或专业出版认证。8MiB内容和受控布局限制明确。真机移动Word、原生IME、P95/大书、字体授权完整审查与商店认证另列待办。其他PUB状态不变。
