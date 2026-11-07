---
id: ledger-chapter-renumber-resilience
type: task-spec
title: 账本对章节重编号的重放韧性
status: draft
parent: weave-effect-first-architecture
depends-on: []
references:
  - weave-maliang-optimization-plan
  - weave-research-maliangwriter-competitive-analysis
tags:
  - ledger
  - trust-core
---

# 账本对章节重编号的重放韧性

## 任务目标

验证并（如有必要）修复：插入、移动、删除章节导致重编号后，账本与伏笔的引用链仍能正确重放，不产生孤儿引用或错位事实。这是马良第 4 条抽取规矩（「章节被修改后档案标记过期并重整；拆/并/插/跨卷移动时引用跟着走」）的结构半边，未进入原方案批次，作为独立缺口补上。

## 现状与风险

`src/core/story-ledger.ts:29-30` 的 `eventIdFor` 把章号编进事件 id：`event-${chapter}-${recordId}`；`supersedes` 与证据链跨章引用这些 id。当前章号变化（插章、移章、删章）后：

- 重放是否仍指向正确事件，没有测试覆盖；
- 引用旧章号的 id 是否变成孤儿，没有验证。

## 实现边界

- **测试先行**：构造插一章 / 移动一章 / 删一章三种场景，断言 `rebuild` 后 `supersedes` 链与 evidence 指向正确事件、无孤儿 id。
- 若测试证明重放断裂，修复取最小改动：优先「重编号时批量迁移 id」或「引用与章号解耦」二选一，不两者都做。
- 不改既有 `eventIdFor` 格式，除非测试证明必须。

## 验收

- 三种章号变更场景 rebuild 后账本与手工预期一致。
- 现有 ledger / rebuild 测试全绿。

## 非目标

- 不做回收站（`versions/` 已留历史）。
- 不做拆章/并章的自动语义迁移——若测试暴露此类断裂，先记录为已知缺口再单独立任务。
