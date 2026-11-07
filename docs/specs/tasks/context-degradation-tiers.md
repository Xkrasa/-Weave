---
id: context-degradation-tiers
type: task-spec
title: 可选材料的「仅名称」降级档
status: draft
parent: weave-effect-first-architecture
depends-on:
  - assembled-context-report
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - context-engineering
  - budget
---

# 可选材料的「仅名称」降级档

## 任务目标

当前装配是「全量或丢弃」两态：丢弃会让模型不知道某角色存在，而只给名字几乎不占预算却能保住存在性。预算不足时对 non-required 材料先降级为紧凑形态，仍不足才丢弃，用极低成本买一层安全。

## 现状

`src/core/context.ts` 按 `relevance → priority` 排序（约 L72-73）塞预算，塞不下的进 `omitted`，没有中间形态。

## 实现边界

- `Material` 增 `compact?: string`（角色卡 → 「姓名 + 一句话身份」；设定 → 「名称 + 类型」），`src/core/materials.ts` 为角色、设定、伏笔生成 compact 形态（这几类已有结构化字段）。
- `src/core/context.ts`：预算不足时对 non-required 材料先降级为 `compact`，仍不足才 `omitted`；降级项写入 `AssembledContext.degraded`。
- compact 文案明确标注「（本章未展开）」，避免模型把紧凑形态当成角色全部状态。

## 必须遵守

- `required` 默认不降级；`unknown provenance` 仍直接阻断；`split-required` / `capacity-conflict` 显式失败语义不变。
- 降级只能发生在可选材料上，且必须出现在装配报告里——不在报告里的降级就是静默压缩。

## 验收

- 把预算压到只够 required：装配报告出现 `degraded` 列表，prompt 保留角色名但无完整卡；提高预算后恢复完整注入。
- 现有容量冲突测试语义不变。

## 非目标

- 不做总开关二元降级（马良方案的「关 = 精简装配」已被否决）。
- 不做分级裁剪算法或新的预算策略，降级只插在现有「塞不下才丢弃」之前。
