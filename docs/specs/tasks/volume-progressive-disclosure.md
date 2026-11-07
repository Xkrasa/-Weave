---
id: volume-progressive-disclosure
type: task-spec
title: 设定按卷渐进披露
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - assembled-context-report
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - context-engineering
  - canon
---

# 设定按卷渐进披露

## 任务目标

长篇设定集是「作者知道的全集」，模型每章只应知道「读者已读到的部分」。未到披露章的 canon 与角色材料不进上下文，省 token 并防止模型提前透支未揭晓信息。

## 现状

`src/core/materials.ts` 的 `collectMaterialBundle` 把 `premise.md` / `world.md` / `style.md` / `prohibitions.md` 一律作为 `required`、`provenance: 'author'` 每章全量注入，无披露控制。

## 实现边界

- `canon/reveals.json`（新文件）：`{ "canon:world.md": 1, "canon:characters:陆沉": 12 }`，键复用现有 `sourceId` 命名，不改 canon Markdown 格式。
- `collectMaterialBundle` 在 push canon 与角色材料前按 `contract.chapter` 过滤；未到期项不进 `materials`，写入 `AssembledContext.withheld`（`reason: 'not-yet-revealed'`）。
- 披露判断是材料收集阶段的事实，`assembleContext` 不参与判断、不参与预算。
- `weave status` 与写作输出显式列出「本章未开放条目」，支持 `--show-withheld` 预览被扣留内容。

## 必须遵守

- 预算与 sanitize 逻辑不得把 `withheld` 当作 budget 省略处理。
- 作者标错披露时点时，显式清单是唯一发现途径，不得静默。

## 验收

- 同一本书设 `world.md` 在第 10 章开放：写第 5 章时装配报告出现 `withheld: canon:world.md`，且 prompt 不含该文件正文；第 10 章起正常注入。
- 本任务改变生成输入，按效果实验契约记录 `bench/BASELINE.md` 基线并用 `scripts/benchmark.ts` 对比，不与无关改动混批。

## 非目标

- 不做「仅名称」降级档（`context-degradation-tiers`）。
- 不做按读者视角的自动剧透检测。
