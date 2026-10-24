# 原生目录与独立 HTML 验证

2026-10-24，alpha.17 开发源码。Windows 原生目录选择后真实主机导出 TXT；中文、空格路径和 Junction 解析成功，清单文件 SHA/长度符合、合成原稿字节不变，进程身份退出核对通过。回执与截图见 screenshots/stage-007/publication-native/。首次操作等待超时保留 native-picker-observation-timeout.json；控件索引存在坐标偏差，重新打开对话框后由截图限定坐标确认成功。取消无输出是中途观察，不冒充首次成功。

作者界面实际 HTML 输出直接由独立 Electron44 Chromium 加载，不重新生成替代文件。目录、反向章节顺序、上下章、尾章无下一章、重载、主题字号保持均通过；390×844下没有横向溢出。Unicode、字面脚本和冻结正文通过，零 HTTP/页面错误，Node/工作台接口均不存在。全部输出字节与清单匹配。screenshots/stage-007/publication-html/ 保存桌面1287×864、390×844深色目录和正文截图。

边界：仅合成稿；尚非本版安装包资格，未测试真实手机、Edge、辅助技术和原生中文输入法，未实现 EPUB/DOCX/PDF/图像资源或远端发布。阶段工作继续，未提升 PUB 和稳定发布门禁。
