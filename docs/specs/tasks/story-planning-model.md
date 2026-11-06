---
id: story-planning-model
type: task-spec
title: 建立故事承诺与卷弧规划模型
status: draft
parent: weave-effect-first-architecture
depends-on:
  - effect-evaluation-harness
tags:
  - story-promise
  - volume-arc
  - character-arc
---

# 建立故事承诺与卷弧规划模型

## 任务目标

让系统拥有比单章合同更高层、同时比自由文本更可控的故事结构，使正文能够围绕读者承诺、卷级矛盾和人物选择持续推进。

## 数据边界

新增以下可读、可版本化数据：

### StoryPromise

记录目标读者、题材、核心幻想、独特卖点、主要情绪体验和主角长期欲望。它回答“这本书为什么值得读”，不记录每章具体剧情。

### VolumeArc

记录本卷主矛盾、对手或阻力升级、主角关键选择、高潮兑现、卷末不可逆变化，以及需要推进的故事线和 ReaderPromise。卷弧是作者软规划，除明确标记的合同硬节点外不自动成为 blocking。

### CharacterArc

记录人物长期欲望、恐惧、核心误判、声音特征、关系方向和成长代价。当前位置、伤病、物品、现实关系和某章误信仍由 Fact/Belief 账本负责；CharacterArc 不复制动态状态。

### RollingPlan 与 ReaderPromise

RollingPlan 覆盖未来约 10–30 章，最近约 3 章详细、远处保持可调整。ReaderPromise 描述向读者许诺的答案或体验，Payoff 记录其兑现计划与正文证据；它们与 OpenLoop 的伏笔语义分开，不设统一爽点配额。

## 出处与批准

每份规划具有 `status: draft | approved`、来源、内容哈希和批准信息。AI 生成内容初始为 `draft/generated`，只有作者显式批准后才成为 `approved/author` 材料。

批准的是某个具体内容哈希；批准后再次修改会回到待批准状态。旧批准版本保留，以便审计规划变化。

## 与现有模型的关系

ChapterContract 仍是单章硬约束入口。卷弧和 RollingPlan 不替代合同，也不能绕过合同检查、事实账本或定稿门禁。既有项目没有这些文件时必须继续可读、可写，新增字段采用渐进迁移。

## 验收

- 新模型可以表达核心卖点、卷级高潮、人物弧和滚动计划，且不重复动态账本状态。
- AI 生成规划未经批准不会以 `author` 身份进入权威上下文。
- 修改已批准规划会使旧批准失效，历史版本仍可追溯。
- OpenLoop 与 ReaderPromise/Payoff 在 schema 和查询中保持不同语义。
- 无规划文件的旧项目无需一次性补录即可继续工作。
- 规划材料的来源、批准状态和哈希会进入后续运行记录。

## 非目标

- 不在本任务中实现 AI 章纲生成命令。
- 不用固定章节间隔或爽点数量判定规划合格。
- 不自动把规划中的未来事件写入事实账本。
