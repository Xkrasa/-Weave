---
id: segmented-chapter-generation
type: task-spec
title: 按分段计划生成并合并草稿
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - context-window-budget-config
  - segmented-chapter-plan-model
references:
  - weave-next-iteration-plan
tags:
  - generation
  - streaming
  - segments
---

# 按分段计划生成并合并草稿

## 任务目标

在已批准的分段计划内逐段生成正文，每段独立流式、独立保存，合并后仍进入原有抽取/审计/复检/定稿门禁；解决单次输出截断、跑偏和长章不可恢复的问题。

## 现状

- `writeChapter` 只有一次 `streamChapter`（`src/core/writing.ts:98-249`）。
- `draftingStrategy` 只有 `prose-first | beat-first`；`WriteResult` 没有分段信息。
- `GenerationEvent` 只有 started/delta/usage/completed/failed/cancelled（`src/core/types.ts:175-184`）。

## 实现边界

### 写章分支

`writeChapter` 增加 `draftingStrategy: 'segmented'` 分支，前置检查保持不变：

- 大纲已批准、合同检查通过、主线与投影当前、知识边界通过；
- 加载已批准段计划并校验 `planHash / contractHash / beatContentHash`；
- 章节级上下文只装配一次，逐段复用基础材料。

### 段级上下文

`assembleContext` 增可选 `segment`：

```ts
segment?: {
  index: number
  total: number
  goal: string
  entryState: string
  exitState: string
  priorTail: string       // 上一段最后 300–500 字
  targetWords: number
  mustNotHappen: string[]
  usedMotifs?: string[]    // 已用关键句/意象，防重复
}
```

- 稳定内容（system、合同、基础材料）在前，段任务与上一段尾部在后，便于 prompt 缓存。
- 段级预算仍受 `contextBudgetTokens` 限制；若基础材料已装不下，沿用 `split-required` / `capacity-conflict`，不静默裁剪。
- 写作任务 `maxOutputTokens` 默认 4096；按 `targetWords / charsPerToken × 1.3 + 200` 估算，不超过该值。

### 逐段生成

1. 遍历计划中的段，调用 `streamChapter`；`onDelta` 转发到现有 SSE。
2. `normalizeText` 后保存 `seg-XX.md` 与段元数据。
3. 每段结束写入 run 的 partial（段边界），并发出 `segment-completed` 事件。
4. 段级校验与重试由 `segmented-chapter-checks-recovery` 定义；本任务只留接口。
5. 失败时记录失败段与原因；已完成段不重跑。

### 合并

- 段间去重、统一一个空行、合并后再 `normalizeText`。
- 计算合并稿 `contentHash`，保存草稿与 `DraftMeta`。
- 关键章仍调用现有 `generateKeyCandidates`。
- **绝不**在合并后自动执行 extract / audit / review / finalize；作者仍需走原门禁。

### 记录与事件

- `WriteResult` 增 `segments: Array<{ segmentId; status; contentHash; usage? }>`。
- `RunRecord` 增 `segments?` 与聚合 usage；`draftingStrategy: 'segmented'`。
- `GenerationEvent.type` 增 `segment-started | segment-completed | segment-retry`，序号仍单调递增。
- `/api/chapters/:n/write/stream` 原样转发新事件；前端未知事件忽略，不破坏旧客户端。

## 必须遵守

- 合并稿仍是唯一草稿真源；段文件是派生工作件，不参与定稿。
- 定稿门禁不变：阶段报告必须绑定合并稿 hash，分段不能绕过。
- 不写 ledger、不自动改合同、不自动批准段计划。
- 取消或失败时保留已完成段，但不得把它们直接拼成“正式草稿”。

## 验收

- 9000 字章节能按计划完成，单段输出不超过预留，无截断。
- 合并稿字数落在合同 `targetWords` 的 ±10% 附近；段间无 40 字以上重复。
- 合并后 `DraftMeta.contentHash` 与正文一致；`finalizeChapter` 仍要求对应阶段报告，缺一不可。
- 取消发生在第 3 段时，前 2 段保留、run 终态为 cancelled、partial 可读。
- 单次路径（prose-first）行为与 token 预算不变；未启用分段时不产生额外调用。
- SSE 事件顺序正确，usage 按段与总计都能追溯。
- `npm run typecheck` 与现有测试全绿。

## 非目标

- 不并行生成多段（段间有状态依赖）。
- 不做无人值守整书生成，不自动定稿。
- 不做透明断点续写；恢复策略由下一任务定义。
- 不用分段替代原有抽取/审计/复检链。
