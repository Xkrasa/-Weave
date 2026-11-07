---
id: segmented-chapter-plan-model
type: task-spec
title: 建立作者批准的分段计划模型
status: ready
parent: weave-effect-first-architecture
references:
  - weave-next-iteration-plan
tags:
  - generation
  - beats
  - segments
---

# 建立作者批准的分段计划模型

## 任务目标

把“一章要写多长”拆成可批准、可校验、可追溯的段计划：每段对应已批准的场景节拍，有明确目标字数、进入状态、退出状态和禁止项；没有批准计划就不进入分段生成。

## 输入与真源

- 当前章合同：`targetWords`、`mustNotHappen`、POV、场景信息（`src/core/types.ts:85-115`）。
- 已批准节拍：`requireApprovedBeats`（`src/core/beats.ts:184-199`）。
- 现有草稿与主线状态只用于校验，不参与段计划内容。

分段计划是作者意图，不是故事事实；不得写入 ledger，也不得自动成为合同。

## 输出契约

`src/core/segments.ts`：

```ts
export interface ChapterSegment {
  segmentId: string          // seg-01
  index: number
  beatIds: string[]          // 至少 1 个已批准节拍
  goal: string
  entryState: string
  exitState: string
  targetWords: number        // 中文字符数
  mustNotHappen: string[]
  status: 'planned' | 'generating' | 'draft' | 'checked' | 'approved' | 'failed'
  textPath?: string
  contentHash?: string
  runId?: string
}

export interface ChapterSegmentPlan {
  schemaVersion: 1
  chapter: number
  planHash: string
  contractHash: string
  beatContentHash: string
  targetWords: number
  segments: ChapterSegment[]
  createdAt: string
  approvedAt?: string
  approvedBy?: 'author'
}
```

存储：

```text
.weave/segments/chapter-001/plan.json
.weave/segments/chapter-001/seg-01.md
```

- `projectPaths` 增 `segments`；`initProject` 创建目录。
- `SceneBeat` 增可选 `segmentId?: string`、`targetWords?: number`（`src/core/beats.ts:19-26`）。
- `DraftingStrategy` 增 `'segmented'`（`src/core/beats.ts:16`），`RunRecord.draftingStrategy` 同步扩展（`src/core/types.ts:378`）。

## 分段规则

1. 每个 segment 至少覆盖 1 个已批准 beat；beat 不能跨段重复。
2. 默认每段 1500–2500 中文字；`contract.targetWords` 按 beat 权重分配（`turn` / 高潮段 1.3，过渡段 0.8）。
3. 各段 `targetWords` 之和落在 `contract.targetWords` 的 ±10%。
4. 段数上限 6；超过则报错并建议拆章或减少节拍。
5. 第一段 `entryState` 取合同 `openingState`；最后一段 `exitState` 取合同 `endingState`；中间段前后衔接。
6. 分段由确定性函数生成，不调用模型。

## 批准语义

- `approveSegmentPlan` 绑定 `planHash`、`contractHash`、`beatContentHash`。
- 合同、节拍或段内容任一变化，计划自动变为未批准（`status: draft` 或 `modified`）。
- `requireApprovedSegmentPlan` 在生成前校验三者 hash；不匹配直接报错，不降级放行。

## CLI

```bash
weave segments plan 12          # 生成建议，不批准
weave segments show 12
weave segments set 12 --file plan.json
weave segments approve 12
weave segments skip 12
```

## 验收

- 没有已批准节拍时，`segments plan` 明确报错，不生成计划。
- 同一合同与节拍多次生成，`planHash` 稳定；段数、目标字数、首尾状态符合规则。
- 未批准计划不能进入生成；`approve` 后 `planHash` 与当前内容一致。
- 修改合同、节拍或段内容后，旧批准失效并提示重新批准。
- `segments show` 能列出每段节拍、目标字数、状态，不泄露未批准的内部候选。
- 现有 beats 测试与 CLI 行为不回归。

## 非目标

- 不用 LLM 自动切分场景；本任务只做确定性计划。
- 不自动批准、不自动生成正文、不跨章规划。
- 不把分段计划写成合同或 ledger 事实。
