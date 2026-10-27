# alpha.41 带图 PDF 源码验证

本切片为开发主线，未包含在公开 alpha.40，尚无41安装/升级资格。冻结资源用于封面、章首和章尾，真实输入、sourceImages 清单与原子导出复用既有出版资源链。Chromium可重新编码图像，因此PDF声明输入PNG的hash，不冒称PDF内流字节等于原始PNG；DOCX继续记录实际内嵌原字节。

## 已有证据

- [全套报告](../../../screenshots/stage-007/alpha41-pdf/illustrated-pdf/illustrated-pdf-smoke.json)：A5默认6页、A4流式5页、A5大字宽边8页，加实际作者导出3页，总22页；完整文字/页面标签/字体/图像顺序与替代文字、实际渲染的五个平坦色块/张和印刷边界独立检查。四组联系表已实际查看，无丢图、截断、页边溢出。合成超长图注可自然跨页。
- 实际源渲染器缺图/额外图/损坏图拒绝；删除真实暂存PNG报错并清理；真实renderer crash后可再渲染；主动移除CSP的合成夹具中，宿主仍拒绝真实loopback HTTP与未授权本地PNG，服务器收到0请求。单渲染器锁有效。
- [最新作者重验](../../../screenshots/stage-007/alpha41-pdf-recheck/illustrated-pdf-author-only/illustrated-pdf-smoke.json)：实际作者导出、两组独立检查通过，3页/2图。重跑前旧临时夹具缺失导致一次ENOENT，保留日志，重新生成作者资源后通过，没有修改产品以跳过检查。
- [纯文字故障回归](../../../screenshots/stage-007/alpha41-pdf-recheck/publication-pdf-failures/pdf-failures-smoke.json)：真实崩溃、实际90051.6512ms超时及各自下一次成功渲染；[纯文字布局](../../../screenshots/stage-007/alpha41-pdf-recheck/publication-pdf-layout/pdf-layout-smoke.json)保持通过，未把其65页重复全文称作带图22页。
- 本轮PDF改动后全量431测试/类型/规划通过，后续工程资产新增测试须单列最新全量结果。

共享发行PNG验证在任何await前复制输入；检查hash、单帧完整PNG、实际解码/尺寸及元数据清理，DOCX去重64MiB、PDF去重128MiB。PDF仅允许本次HTML和精确图片URL，脚本、Node和任意文件/网络均禁止；等待全部图片读取成功才打印，finally只清理本次拥有的暂存文件。TXT/MD仍前置拒绝带图快照，避免静默漏图。

## 检查修正与边界

最初独立像素检查采样落在JPEG形状边缘，改为邻近8px内真实平坦5×5色块；原产品PDF未修改。宽图CSS亚像素取整导致固定比率误差门槛不合理，改为印刷几何误差≤0.76pt（约1CSS像素），保留每张实际误差。源码QA runner需要绝对sharp路径解析，NODE_PATH未生效属QA依赖绑定问题，未更换实际产品文件协议。原失败日志保留在本机.cache及本目录选定日志。

不声称专业排版、人工文学审读、原生IME、无障碍或商店认证通过。目录、注释、EPUB与远端发布仍是余项。工作流和安装套件已加入带图PDF作者检查，但添加检查不等于已实际运行安装。
