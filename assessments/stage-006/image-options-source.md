# alpha.31 图像响应模式配置与宿主准备

新增明确imageOptions.responseMode：default-base64表示不发送response_format，request-base64明确请求b64_json。null/缺省保持未确认，拒绝未知字段、URL模式、混入文字配置；不按模型名猜测，保存/重启不发送图片请求。协议整体runnable=false仍保留，即使已保存模式也尚未开放实际生成；当前模式是配置准备，不冒充供应商兼容保证。

ModelSettings.image经过同一激活指针/storeId/配置身份核对，拒绝借用旧文字服务；主进程实例化ImageJobService，普通关闭与恢复关闭入口增加待处理图像检查。尚未注册图像IPC或生成界面，尚无实际运行中图像任务的窗口关闭验收，不能只凭源码把关闭保护标verified。

新增模型存储1项（该模块共10项）验证两种模式保存/更新/重启/清除、保留独立Key、字段拒绝、无修改和未启用事实；完整312项、类型/规划/构建通过。实际Electron模型管理6组通过：从未确认选择request-base64，通过普通表单保存，实际重启后保留模式与图像Key，文字A3/B6和图像C0请求；含真实Windows safeStorage及官方Harness。新增desktopBundleSha256将回执绑定21899253b1da84bf0b42ef55b0d22913ca56e014b991c607dfa18d710575471d，version=0.1.0-alpha.31/packaged=false。

已查看1426×923浅色图像模式表单和806×803深色模型管理截图，页面垂直滚动、无水平溢出。首次模式截图控制在下方截断，修正探针先scrollIntoViewIfNeeded，重跑后实际查看可见选项；产品未改布局。桌面基础10组回归通过，包括中文/Unicode往返、正常关闭重启保稿、外部冲突、OS加密、实际子Harness两工具、选区采用撤销/重做、隔离IPC与窄窗抽屉。

原始tests/check/build/ui/desktop txt及JSON与代表截图单独归档。仍无31安装/图像IPC/作者候选生成界面、真实供应商或原生IME资格。下一步接候选面板、明确发送费用确认、目标版本选择、取消/补存/审阅/采用/重启，以及实际运行中关闭保护与完整安装发行。106项26/46/34保持。
