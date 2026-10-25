# 数据、存储与版本

## ADR-005：开放文件为主数据，可重建数据库为索引

一个书库可位于用户选择的目录；每部书是可独立搬移的目录。应用自身数据与小说内容分离。默认不把用户书库放进公开程序仓库。

```text
library/<book-id>/
  book.json                         ID、标题、类型、风格、schemaVersion
  structure.json                    卷章场景顺序，UUID 与显示章号分离
  planning/                         创意、试写、总纲、卷纲、近期细纲
  manuscript/<chapter-id>.md         正文唯一主文件，UTF-8
  metadata/chapters/<chapter-id>.json 场景边界、状态、内容摘要、版本
  world/characters/                 人物定义和状态变化
  world/locations/                  地点、区域、路线、地图关联
  world/rules/                      世界规则及例外
  world/entities/                   组织、物品、能力、术语
  story/threads/                    主支线
  story/foreshadowing/               伏笔及证据
  story/timeline/                   叙述顺序与故事时间
  canon/                           已接受事实及出处
  research/                        来源登记与有权保存的资料
  assets/                          原图、选定图、缩略图、地图数据、清单
  reviews/                         批注、通读范围、修改及复读记录
  publishing/                      发布快照、目标、回执，不含密钥
  .zinovel/                        写前日志、版本快照、锁、可重建索引
```

题名/章号可改，ID 不变；重排只改 structure，不重命名所有文件。章节 Markdown 是正文权威，结构文件是目录权威；元数据摘要与数据库均派生。外部编辑器可读写正文，应用检测后合并。导出时才使用作者想要的数字文件名。

## 核心实体

| 实体 | 必要字段/关系 |
| --- | --- |
| Book | id、schemaVersion、title、language、genres、targetScale、styleProfile、author、seriesId? |
| Volume / Chapter | id、parentId、orderKey、title、draftState、revision、contentHash |
| Scene | id、chapterId、anchor、POV、地点、storyTime、目标、冲突、局面变化 |
| Character | id、名字/别名、人物卡、voiceProfile、状态事件、关系边 |
| CanonFact | subject、predicate、value、validTime、knowledgeScope、status、evidence[] |
| Thread | type=main/sub、ownerIds、goal、chapterRefs、returnWindow、resolutionState |
| Foreshadow | plannedAnchors、actualEvidence、reinforcements、payoffWindow、resolutionEvidence |
| TimelineEvent | storyTime/uncertainty、narrativeOrder、participants、location、causes[] |
| Map | 图层、地点 ID、坐标系统、distanceUnit、路线、底图 assetId |
| Asset | id、sha256、mime、dimensions、purpose、linkedEntities、source、rights、revision |
| Review | reviewerType、完整/抽读范围、contentHashes、问题锚点、解决/复读状态 |
| ChangeProposal | baseRevision、baseHash、锚点、操作、候选、锁定项、上下文引用、状态 |
| Publication | target、snapshotId、章节集合与哈希、资源清单、授权范围、remoteReceipt |

## 事实和计划

设定状态：proposed → accepted；正文证据明确的事实标 established，修改后可变 superseded/conflicted。accepted 是作者批准的设定，established 是正文已经写出的事实，两者不可混同。故事真相、角色认知与读者认知分别存 knowledgeScope。跨时期改变保留 validFrom/validTo；无精确日期用相对时间和不确定区间。

伏笔计划不计为已埋；回收必须有正文锚点。正文删除或改写后，失效证据进入待复核；不自动删掉作者笔记。人物改名采用别名映射和候选命中预览，题字、本名长度、称谓和双关由作者确认。

## 写入协议

1. 应用拿到编辑缓冲区基线，按书获得单写入锁；跨进程锁含 owner、租约和恢复判定，不能按时间直接删除仍活跃锁。
2. 保存前比较磁盘 hash 与 expectedRevision。冲突保留本地缓冲、外部版本和共同祖先，展示三方合并。
3. 将事务意图和旧版本写到同卷日志；写临时文件、flush、替换目标并提交事务。多文件变更可恢复，不声称多次 rename 天然原子。
4. 更新目录/元数据和可重建索引。崩溃恢复读取事务状态：完成或回滚未提交组；不能留下新正文配旧正典而仍显示一致。
5. UI 区分“编辑中/正在保存/已持久化/索引待更新/冲突/失败”；磁盘满、权限拒绝和杀软占用保留缓冲，重试有上限。

IME 组合输入期间不截断拼音候选；compositionend 后提交编辑事务。版本号由领域服务分配，内容 hash 针对原始 UTF-8 字节计算；正文统计另用可配置规范，不混用 hash 规范化。

## AI 选区锚点

alpha.35落实正文提交前像：同一次manifestRecord读取取得book对象与原始book.json，正文与目录原始文本、接受回执的不存在条件进入同一内核事务expectedBefore；排队前复制输入/回执字段。事务接手前外部修改会拒绝，不能把新磁盘文本重新认作该保存的基线。受控反例和实际恢复证据见assessments/stage-002/manuscript-write-guard/README.md；不承诺任意外部写入时序的绝对原子性。规划同类修正在planning-write-guard。

提案绑定文档 ID、baseRevision、baseHash、编辑器模型位置、原文片段 hash 与前后文。位置使用编辑器确定的偏移单位，转换到 UTF-16 或字节边界时显式标注。不能以“第 N 个字符”跨中文/emoji 模糊计算。正文版本变化则尝试映射；重复文本、重叠编辑、无法唯一定位时要求重算候选，绝不盲用字符串全局替换。

接受提案是新的可撤销编辑事务，部分接受后更新剩余区块的基线或将其标旧。已发布快照不可原地改写；修订形成新发布版本。审读/摘要/索引记录来源 hash，源变更会失效，避免“已审”永久有效。

## 导入、备份和迁移

支持 UTF-8/TXT/Markdown 先行；GB18030 及 DOCX 导入后展示编码、章边界和插图预览，用户确定后创建新书。试运行不得改变原始文件；校验首尾段、总字数、顺序和缺章。现有 ZiCode 目录映射为适配器，不强迫用户先搬库。

本地版本快照不等于异盘备份。备份目录单独选择，默认完整目录增量复制并带清单；恢复到新目录验证后切换，不能覆盖唯一副本。可选私有 Git/云盘属于后续适配，公开仓库连接须明显提示稿件公开范围。

数据库删除后可重建，schema 迁移先备份和 dry-run；新版本不能打开时提供只读/导出。冲突书库、网络盘、同步盘需要显式能力探测，不承诺远程文件系统具有本地锁与原子替换语义。

## Stage-002 实际存储增量

当前 v1 卷章目录仍保存在 book.json，而非上方规划中的独立 structure.json。章节正文在 manuscript/；标记在 annotations/<chapter-id>.json，含 schemaVersion/revision/items。标记有 stable ID、kind、title/text、resolved/deletedAt、anchor（UTF-16 范围、基线 hash、引文、前后文）。锚点解析结果派生，不覆盖旧引用证据；批注写入使用原有恢复事务。场景标记不是完整场景计划实体，结构化 POV/目标/因果字段将在规划阶段接入。
