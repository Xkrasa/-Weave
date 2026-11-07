---
id: chapter-ending-profile
type: task-spec
title: 章尾类型按题材统计建议
status: deferred
parent: weave-effect-first-architecture
depends-on:
  - scene-deconstruction-methods
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - deconstruct
  - style
---

# 章尾类型按题材统计建议

## 启动条件

马良方案批 4，默认搁置。仅当以下条件同时满足才启动：

1. 前六项借鉴任务（披露、总账、降级、待裁决、文风反推、装配预览）全部交付；
2. `bench` 有余力；
3. 拆书样本足够覆盖至少两个题材，能支撑按题材聚合的统计。

若启动时样本不足，本任务继续搁置，不以功能完整为由启动。

## 实现边界

- `src/core/deconstruct.ts` 增章尾分类统计：悬念揭示 / 关系反转 / 目标受阻 / 情绪落地 / 信息差，按题材聚合。
- 只出**观察型报告**：给出某章章尾类型与同题材参考分布，作为作者参考。
- `endingStrategy`（`src/core/style.ts`，现为单字段自由文本）的按题材建议从该报告推导，仍是建议不是约束。

## 必须遵守

- 不进生成约束、不进 review 门禁、不影响定稿判定——对应 `goal-and-requirements.md` 非目标（不得成为统一配额或硬门禁）。
- 题材标签与样本偏差是把「别人的节奏」当规范的主要风险，报告必须标注样本来源与数量。

## 验收

- 对同一章输出建议类型 + 参考依据，且不影响定稿判定。

## 非目标

- 不做章尾类型配额、不做自动改写章尾。
