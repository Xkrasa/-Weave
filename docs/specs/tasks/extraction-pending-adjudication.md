---
id: extraction-pending-adjudication
type: task-spec
title: 抽取冲突进待裁决队列而非静默丢弃
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - extraction-grounding-rules
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - extraction
  - trust-core
---

# 抽取冲突进待裁决队列而非静默丢弃

## 任务目标

模型抽错有两种：格式非法该丢；与账本冲突则是「可能正文写错了，也可能账本旧了」——只有作者能裁决。直接拒绝等于静默扔信息，直接采纳等于让错账污染主线。冲突类记录进待裁决队列，交作者裁决。

## 现状

`src/core/extraction.ts`（约 L264-271）只有 `records / rejected` 两类，证据不合法的记录整条进 `rejected`，`passed = rejected.length === 0`。UI 只暴露 findings 的 waiver/ignore（`src/core/waivers.ts`）。

## 实现边界

- `ExtractionReport` 增 `pending: PendingRecord[]`，字段含 `raw`、`conflictWith`（既有 factId/loopId）、`quote`、`reason`。
- 三类分流：结构非法 → `rejected`；证据无效 → `rejected`；**与账本/合同冲突** → `pending`（不阻断 `passed`，但计入待办）。
- 裁决入口复用 `waivers.ts` 的写法：落 decisions 记录、可重放投影，保持「派生可重建」。
- `src/core/ui-server.ts` 暴露待裁决队列；`weave audit` 顶部聚合展示；超过阈值提示批量处理。

## 待裁决期间的注入语义（必须定义，不得留空）

- 未裁决的 `pending` 记录**不进 ledger 投影**——裁决前它不是事实。
- 但下一章的 `weave status` 与装配报告必须对涉及同一 subject 的未决 pending 以 warning 显式呈现，直至裁决完成；裁决后 rebuild 结果与手工修正一致。
- 不得出现「队列在积压、写作无感知」的状态——那等于带着「角色已死还是活着」的未决冲突续写。

## 验收

- 构造「正文写角色已死、账本记录存活」的章节：抽取产出 `pending` 而非 `rejected`；裁决后 `rebuild` 与手工修正一致。
- 存在同 subject 未决 pending 时写下一章，status / 装配报告出现 warning。

## 交付裁决（2026-11-07）

- **分流范围收窄为单值状态谓词**（status/condition/injury/health/alive/dead）：location、possession 每章合法变化，纳入会把队列灌满；数量类冲突由 `quantity-ledger-balances` 的 `quantity-break` 覆盖。与「合同」的冲突暂不进队列（合同检查另有门禁）。
- **待裁决事实计入维度覆盖**：否则被扣下的状态变化会让 audit 的必检维度判定失败、间接阻断定稿，违反「pending 不阻断」。裁决只决定入账与否，不扣覆盖。
- 未决冲突在 `weave status`、`weave context` 装配报告与 write 输出三处以 warning 呈现，裁决后消警；不进 prompt、不影响 contextHash。

## 非目标

- 不自动裁决、不根据 pending 改写 canon 或正文。
- 不把 pending 当作阻断定稿的条件。
