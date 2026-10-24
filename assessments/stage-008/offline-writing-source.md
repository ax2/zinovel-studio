# alpha.26 离线写作源码验证

合成两部作品，通过实际 Electron 窗口和官方 Harness 测试手工输入、Ctrl+S、切书、任务隔离、重启与阅读。使用 frontend-testing-debugging 流程；Browser 插件及 browser 技能不可用，沿用仓库 Playwright/Electron。全部材料、模型凭据为专用合成数据。

作者窗口 CSP 拒绝 fetch；另用同一 Chromium session.fetch 证明 HTTP 拦截器实际取消请求，并核对一次计数。模型由独立受控 loopback 服务接收，第一次挂起，作者继续保存；切书取消原任务后，在另一书手写保存。回到原书另发任务得到 HTTP503，实际记录 failed。两书正文精确不变、没有接受候选、另一书任务列表为空，模型载荷不含另一书正文/资料标记。

完整退出宿主并关闭服务后重新启动，原书继续手写保存，实际阅读窗口显示最新文本，零 pageerror。当前回执为 screenshots/stage-008/offline-writing/offline-writing-smoke.json，四组检查通过，providerRequests=2、switchedTaskStatus=cancelled、failedTaskStatus=failed、foreignBookTextSent=false、rendererRequestsDenied=1。查看了1783×1154桌面作者窗口和纸色阅读窗口截图，正文及保存状态正常；未验证窄屏。

探针开发历史没有删除：首次清理 owned 未初始化遮蔽原错；第二次初始导航竞争导致 reload 等待 load 超时；改为先等真实书卡再重载至 domcontentloaded。第三次把切书后的预期取消误断为失败；核对任务生命周期后分成取消和独立503两分支。随后成功；新增网络拒绝自检首次发现 CSP 在拦截器之前拒绝 fetch，因此拆成 renderer CSP 和独立 session.fetch 两项，最终通过。原始日志在 .cache/alpha26-offline-*，不据这些探针错误声称产品缺陷或首次即通过。

本轮接入源码CI、标签发行CI、实际安装回归与同版本发行清单门禁。接入本身不代表 alpha.26 安装或CI通过：尚未形成该版安装资格。

首次接入CI40084758421在窄窗口未展开“创作参考”，定位生成按钮超时；没有发生生成或正文断言失败。补用与现有作者测试相同的真实展开操作，固定窗口1000×900进行本机复核，实际内容视口986×863、缩放1.25，四组完整通过。当前两张代表图已更新为该视口；前述1783×1154是先前宽窗口观察，原始记录在缓存日志，不把它混为本轮尺寸。CI重验仍待完成。

范围限制：未断开整机网络、未阻断全部 CLI 网络、未验证系统代理或 OS 飞行模式；未证明所有工具的跨书越权拒绝，只验证默认载荷和任务归属；本轮未覆盖真实系统IME、自动保存故障、离线撤销及真实模型文学质量。LIB-08/OPS-06/OPS-07保持原状态，106项矩阵与稳定门禁不变。
