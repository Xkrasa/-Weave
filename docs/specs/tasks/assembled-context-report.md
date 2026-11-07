---
id: assembled-context-report
type: task-spec
title: 装配报告三分类字段一次定型
status: implemented
parent: weave-effect-first-architecture
depends-on: []
references:
  - weave-maliang-optimization-plan
tags:
  - context-engineering
  - trust-core
---

# 装配报告三分类字段一次定型

## 任务目标

`AssembledContext` 报告分类一次定好，后续任务只填值、不再改结构：`included`（进入 prompt）/ `omitted`（预算不足或 `unknown-provenance` 丢弃，维持现状）/ `withheld`（披露未到，`reason: 'not-yet-revealed'`）/ `degraded`（降级档，预留空位）。避免披露、降级、预览三个任务先后三次改同一处结构。

## 实现边界

- 类型定义在 `src/core/context.ts:24-33`（`AssembledContext` 及 `omitted` 的 reason 联合类型 `'budget' | 'unknown-provenance'` 均在此文件），**不在** `src/core/stage-types.ts`。
- 新增 `withheld: Array<{ sourceId: string; reason: 'not-yet-revealed' }>` 与 `degraded: Array<{ sourceId: string; reason: 'budget' }>` 字段；本任务完成后两者恒为空数组，由 `volume-progressive-disclosure` 与 `context-degradation-tiers` 分别填充。
- 所有报告消费者（写作输出、UI、runs 落盘）容忍空数组，不因新字段破坏现有流程。

## 必须遵守

- `withheld` / `degraded` 不是 budget 省略：sanitize 与预算逻辑不得把这两类并入 `omitted` 的 `'budget'` reason，对应「安全信息不可静默丢失」。
- 报告中每一条排除或降级都必须原因可读。

## 验收

- 单测覆盖：三类字段存在、reason 取值正确、空数组时字段仍输出。
- 现有装配相关测试全绿。

## 非目标

- 不实现披露过滤（`volume-progressive-disclosure`）与降级逻辑（`context-degradation-tiers`）。
- 不改预算算法与排序。
