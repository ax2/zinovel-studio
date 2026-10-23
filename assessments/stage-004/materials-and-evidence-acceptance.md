# 人物字段、场景细纲与证据导航验收

2026-10-23 按原条目条件评估，不等于 Stage-004 或完整产品完成。

| 条目 | 原验收行为 | 实际证据与结论 |
| --- | --- | --- |
| WORLD-02 | 欲望/缺陷/声音/外貌均可手改 | smoke-materials 通过所有人物语义字段实际输入、保存、进程重启、别名检索和历史载入；存储单元测试覆盖冲突及备份恢复。通过此条目。 |
| PLAN-04 | 场景目标/阻碍/选择/结果可编辑 | smoke-materials 逐项填写 scene 的全部字段与正文关联并保存，八类资料重启保持；字段语义与上限由同一领域校验约束。通过可编辑细纲条目，场景看板与拖拽同步另属 PLAN-05，未完成。 |
| MEM-04 | 事实能跳转到具体章节段落 | smoke-evidence 实际跨章返回、正文加前缀后准确选择原引文、重复/缺失引文不猜位置；跳转不改稿、不消除待复核。通过此条目，不代表自动事实提取或全书连续性审查完成。 |

证据：tests/materials.test.mjs、tests/material-evidence.test.mjs、scripts/smoke-materials.mjs、scripts/smoke-evidence.mjs；screenshots/stage-004/materials 与 evidence，及 screenshots/stage-004-compact/evidence 的真实桌面报告。人物字段/手工证据在本机 alpha.6 已做安装后测试；精确导航为后续源码增量，尚待 alpha.7 安装复测。

高性能开发机与 GitHub Windows runner 不是低端设备验收。中文输入脚本与 Unicode 校验不是完整 IME/辅助技术验收。AI fixture 只证明协议与交互，不证明真实模型文学质量。所有其他功能保留各自未完成状态。
