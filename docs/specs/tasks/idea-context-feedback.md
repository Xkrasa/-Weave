---
id: idea-context-feedback
type: task-spec
title: 晋升想法受控回灌写作与审查
status: ready
parent: weave-effect-first-architecture
depends-on:
  - idea-promotion-pipeline
references:
  - weave-next-iteration-plan
  - volume-progressive-disclosure
  - context-degradation-tiers
tags:
  - ideas
  - context
  - review
---

# 晋升想法受控回灌写作与审查

## 任务目标

让已晋升的想法能反哺写作和审阅，但不变成噪声或剧透：只有命中当前章/卷、未到剧透期、且作者已晋升的想法，才作为**可选作者材料**进入上下文，并受预算上限；收件箱里的想法永不自动注入。

## 材料准入

在 `src/core/materials.ts` 的 `collectMaterialBundle` 增一类可选材料：

```ts
{
  sourceId: `idea:${idea.id}`,
  category: 'author',
  provenance: 'author',
  required: false,
  label: `作者想法：${idea.title}`,
  text: ideaBody,
  contentHash: hashText(ideaBody),
  visibility: 'author-only',
  purpose: '想法回灌',
  priority: idea.priority === 'high' ? 10 : 50,
  compact: `${idea.title}（想法，未展开）`,
}
```

规则：

1. 只取 `status === 'promoted'` 且 `promotionState === 'active'`；
2. `scope` 命中当前章或当前卷；`book` 作用域只在作者显式开启时进入；
3. `spoilerLevel === 'reveal'` 且 `chapter < revealAfterChapter` → 进 `withheld`，不进入 prompt；
4. 最多 6 条、合计 2000 token；超出按 `priority → updatedAt` 排序截断；
5. 预算不足时先降级到 `compact`，仍不足再 `omitted`；不得静默丢弃；
6. 装配报告必须出现 `idea:` 来源的 included / degraded / omitted / withheld 记录。

复用现有 `withheld` 语义（`src/core/context.ts:30-37`）和披露机制；如果项目已有 `canon/reveals.json`，想法剧透与它取更严格者。

## 写作提示

- 想法块标记为“作者意图，不是既成事实”，不得写成已发生剧情。
- 只提供想法标题 + 正文摘要；不把整份计划或未批准候选注入。
- 与合同 `mustNotHappen` 冲突时，合同优先；冲突进 `conflictWarnings`，不自动删除想法。

## 审阅反哺（软检查）

在 `src/core/review.ts` 或 `effect-review` 增一个可选检查：

- 本章是否推进了 scope 命中的 promoted 想法？
- 是否有“提出了但本章完全没用”的想法？
- 是否有想法与合同/账本冲突？

输出为 warning/info，不阻断定稿；不自动改写正文，不自动删除想法。

## CLI / API

```bash
weave context --chapter 12 --show-ideas
weave idea feedback --chapter 12
```

- `/api/context/preview` 与 `/cockpit` 预算页显示想法来源、token、withheld 原因。
- 不新增写操作；回灌是只读装配行为。

## 验收

- 收件箱想法（`status: inbox`）不出现在任何章节上下文或预览中。
- 已晋升、scope 命中、未剧透的想法出现在 `/api/context/preview`，并标记 `idea:<id>`。
- `spoilerLevel: reveal` 且未到 `revealAfterChapter` 时进入 `withheld`，prompt 中无正文；到章后自动出现。
- 超过 6 条或 2000 token 时，多出的想法进 `omitted` 或降级到 compact，报告可见。
- 想法与 `mustNotHappen` 冲突时，合同仍生效，冲突出现在 `conflictWarnings`。
- 审阅只产出软 finding，不改变定稿门禁。
- 现有材料装配、withheld、degraded 测试不回归。

## 非目标

- 不自动生成想法、不自动晋升、不自动改写计划。
- 不把想法写成 ledger 事实或定稿正文。
- 不让收件箱内容以“灵感”名义无条件注入。
