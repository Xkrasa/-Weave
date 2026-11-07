---
id: quantity-ledger-balances
type: task-spec
title: 数值总账：变化到结余逐章累计
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - extraction-grounding-rules
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - ledger
  - trust-core
---

# 数值总账：变化到结余逐章累计

## 任务目标

数值（灵石、银两、库存等）是最容易被读者抓错、也最容易被模型随手改坏的事实。按「变化 → 结余」逐章累计并校验，发现「从 100 变 30 却只花了 20」这类字符串事实无法表达的错误。

## 现状

`src/core/types.ts:225` 的 `LedgerFact` 只有 `subject/predicate/object` 字符串，`possession` 无数量与结余语义。

## 实现边界

- `LedgerFact` 增可选 `quantity?: { delta: number; balance: number; unit: string }`，整数最小单位，不用浮点；schema 变更走 `src/core/migrate.ts`。
- `src/core/extraction.ts`：数值类变化必须同时给 delta 与 balance；基线不明时只报 delta 并标 `unverified`，禁止反推结余。
- `src/core/story-ledger.ts`：新增 `checkBalances(root, throughChapter)`，按 `subject + predicate + unit` 汇总，校验 `prevBalance + delta === balance`。
- `src/core/audit.ts`：新增 finding 维度 `quantity-break`，输出三值（上章结余 / 本章变化 / 本章结余）附证据引文。

## 必须遵守

- finding 不阻断定稿：数值属事实但不属合同硬节点，进 findings 交作者裁决。
- 无法校验时记 `unverified`，不得默认通过。
- 同一物品多种单位、跨章易主会让归并键出错：`subject` 允许稳定 id 而非别名。

## 验收

- 构造三章测试，第二章结余故意错 5，`weave audit` 必出 `quantity-break`；正确数据不出 finding。
- 基线不明的 delta 记 `unverified`，不产生凑数 balance。

## 已知限制（2026-11-07 交付）

归并键仍是 `subject + predicate + unit` 字符串：同一人物用别名（林岚/林姑娘）会被当成两个账户，「稳定 id 而非别名」未实现，待出现真实别名错账案例再引入 registry 映射，不预做。

## 非目标

- 不做汇率、单位换算、浮点数量。
- 不自动改正文或自动改账本。
