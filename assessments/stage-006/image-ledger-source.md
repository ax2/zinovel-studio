# alpha.31 图像任务账本源码验证

状态：15项账本专项、10项传输专项及完整293项源码检查通过，类型/规划/构建通过；既有图像资源Electron界面5组通过。此前e15594e的源码CI40159521340已成功，但只覆盖278项传输基线，本批提交的CI需另查。没有alpha.31安装资格，image profile仍不可运行，106项26/46/34不变。

真实本机HTTP fixture在服务器收到请求时读取磁盘send-intent；只发送一次、只使用选定合成Key。真实PNG/JPEG/WebP解码、原字节hash、重启预览、作者改目标后保留候选均通过。任务记录无Key/baseURL，可见assets/items为空、正文原字节不变。外部同修订改写、错误attempt、坏UTF8/未来格式、错书/错内核、损坏blob、章节外改都拒绝并保留证据。备份恢复保留候选和来源，不能重发。

实际子进程在三个持久化检查点退出：send-intent日志写好后退出97，恢复为远端未知；receive-intent日志写好后退出97，保留已知响应hash但缺图，核对未完成，匹配原字节才可补存；候选blob写好但完成元数据前退出98，可纯本地核对完成。不只是内存抛错模拟。调用者在排队期间修改字节/用量/取消标志不会污染接收；两解码槽占满时候选排队并保留自己的字节，普通第三预览仍拒绝。

首轮专项8/9失败来自async IO方法同步抛输入错误与assert.rejects契约不一致，修正公开IO包装为async后通过。首轮原始独立日志未保留，不能声称有该失败文件；最终原始日志见image-ledger-tests.txt。完整结果见image-ledger-check.txt/build.txt。

实际Electron资源回归运行0.1.0-alpha.31、packaged=false，main bundle SHA256为3c9e37010385da27d0727093d9f543c276cfa4b39d2616ceea68b279f85fd990。导入/编辑冲突/历史采用/回收恢复/坏图/配额/重启与未知草稿5组通过；原生选图结果由探针提供，真实宿主读盘解码，不能称原生文件对话框交互。已查看桌面浅色与806px深色截图，资源元数据与预览可读，右侧垂直滚动，无水平溢出。见screenshots/stage-006/image-ledger-regression及image-ledger-assets.txt。

限制：尚无ImageTaskService、renderer IPC、适配选项激活、图像采用或生成界面。没有真实供应商、人物一致性、视觉质量或本版安装验证。并发解码等待不是全局生成任务容量/配额资格；启用前须补齐限制、关闭保护及付费候选保留路径。
