# 上游研究与复用边界

核实日期：2026-10-22。用户明确 dsh 指 DeepSeek Harness，而非 ZiCode Studio 或某个社区 DSH Desktop。

## 官方实现已存在

- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。固定研究提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 官方桌面：[apps/desktop](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop)。包 `@deepseek-ai/dsh-desktop`，观察版本 `0.2.1-rc.2`，Electron 桌面壳。
- [许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)：MIT，Copyright 2026 DeepSeek。
- [官网](https://www.deepseek.com/download/)提供官方 Harness 桌面入口。可下载桌面和开源源码两项证据均存在。

| 已读取源码/文档 | 可借鉴机制 | 本项目处理 |
| --- | --- | --- |
| apps/desktop/src/host-process.ts | Electron Node 模式的 Host 子进程、ready/fatal/shutdown 控制消息 | 保留进程所有权与关闭语义，接入小说任务状态 |
| apps/desktop/src/preload-app.ts | 来源限制的 bridge、目录选择、宿主路径、窗口/主题 | 只暴露必要能力，替换独立品牌/协议来源 |
| apps/desktop/src/core-package-set.ts | 包清单、版本、字节数与完整性检查 | 固定最小依赖闭包，打包审计；不能随意删包破坏闭包 |
| apps/desktop/README.md | 桌面构建、独立开发目录、打包与运行时校验 | Windows 原生资格验证，独立数据目录，交付完整 EXE 目录 |
| packages/skill/*、packages/sdk/* 路径清单 | 技能、工具和共享协议所在位置 | Stage-001 阅读具体 API 并做真实探针；本阶段不虚构兼容接口 |

“基于官方”是采用其宿主机制与 Agent，不是重新实现另一个 Agent loop。小说 UI、文档事务和领域工具由本项目维护。上游主干快照是研究基准，不代表本项目已验证可安装或正式稳定版本。

## 与社区版本的区别

之前查看的 DataElement (`a170609b2c6426222cd9275d047f9409dcc753b0`) 与 Anywhere Labs (`584fb4909352d744be6b0f020db9151126796f4e`) 都是独立社区桌面实现，不作为本项目产品基线。ZiCode Studio (`a974f661188611c7a37f64b0b096bada96896c75`) 使用 Tauri 和 Pi，也不作为 Agent 或代码依赖。保留这些研究结论仅为避免混淆。

## 引入源码的实施门槛

Stage-001 在 project-owned vendor 缓存检出固定上游提交，核对 upstream.lock.json、MIT 和转移依赖许可证，记录有意修改的文件。优先版本固定的上游包和小范围桌面派生层；如果桌面代码耦合要求维护快照，记录源码来源清单及可重放补丁，不复制私人配置。

生成允许加载的内置包清单和实际依赖闭包，逐项说明小说用途。排除无关 UI/工具入口不代表可删基础设施依赖；需要替换 preset/bundle 并用启动测试证明。应用 ID、数据根、协议、更新源、图标与签名均归 ZiNovel；不能继续使用官方生产更新或上传地址。

本阶段没有运行官方桌面、安装全量依赖、调用真实模型或生成 EXE。上述机制是源码研究，不是运行时验收。
