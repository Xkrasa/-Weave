---
id: extraction-grounding-rules
type: task-spec
title: 抽取与审计提示固化四条依据规矩
status: implemented
parent: weave-effect-first-architecture
depends-on: []
references:
  - weave-maliang-optimization-plan
  - weave-research-maliangwriter-competitive-analysis
tags:
  - extraction
  - trust-core
---

# 抽取与审计提示固化四条依据规矩

## 任务目标

把抽取与审计阶段共用的四条依据规矩写进系统提示，约束模型行为口径：正文没写的不补、不猜；推不出来的数不编，宁缺不凑；与既有账本/设定冲突时引用双方原句，不擅自裁决；每条记录的证据引文必须能在正文逐字定位。

## 实现边界

- `src/core/extraction.ts` 系统提示与 `src/core/audit.ts` 的 `AUDIT_SYSTEM_PROMPT` 追加四条规矩的 prompt 表述，两处口径一致。
- 不改代码逻辑：证据引文的逐字定位校验已存在（不匹配进 `rejected`），本任务只保证 prompt 与校验口径对齐，避免提示鼓励模型给出代码会拒绝的记录。
- prompt 文本变更要能被 runs 记录追溯（沿用现有 prompt 版本记录方式）。

## 必须遵守

- 只改 prompt，不引入任何新机制：待裁决队列属于 `extraction-pending-adjudication`，报告字段属于 `assembled-context-report`，本任务不碰。
- 四条规矩是软约束的表述，不得借机把任何 finding 升级为阻断。

## 验收

分两类，不得混同：

- **确定性验收**：现有抽取与审计测试全绿；构造引文与正文不匹配的输入，记录进 `rejected`（复用现有单测路径）。
- **行为验收**：用现有 bench seed 跑若干章抽取，对比改动前后「无依据记录」「凑数记录」的出现情况，结果留痕进 `runs/`。行为验收不阻塞合并，但结论要在对应 issue 关闭时引用。

## 非目标

- 不改 `AssembledContext` 结构，不动装配逻辑。
- 不承诺消除模型编造——prompt 只能压低概率，确定性拦截靠既有校验。
