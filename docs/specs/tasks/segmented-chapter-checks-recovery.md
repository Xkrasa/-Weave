---
id: segmented-chapter-checks-recovery
type: task-spec
title: 段级确定性校验与段边界恢复
status: ready
parent: weave-effect-first-architecture
depends-on:
  - segmented-chapter-generation
references:
  - weave-next-iteration-plan
  - stream-recovery
tags:
  - generation
  - recovery
  - validation
---

# 段级确定性校验与段边界恢复

## 任务目标

用便宜、可解释的确定性检查拦住段级明显错误（过短、重复、违反禁止项），并把恢复限制在段边界：已完成段不重跑，失败段可单独重试，绝不把半段文本直接拼接。

## 段级检查

`src/core/segment-checks.ts`：

| 检查 | 规则 | 失败动作 |
| --- | --- | --- |
| 长度 | `0.7×target ≤ chars ≤ 1.4×target` | 重试，附目标字数 |
| 头尾重复 | 与上一段尾部规范化后重叠 ≥40 字 | 自动裁掉重叠，不重试 |
| 禁止项 | `mustNotHappen` 关键词命中 | 重试，附命中句 |
| 视角 | POV 人名/代词出现 | 软警告 |
| 退出状态 | `exitState` 关键词命中 | 软警告 |
| 关键人物 | 本段 `goal` 涉及人物出现 | 软警告 |

- 硬失败只有长度、重复、禁止项；其余只进 `checks.warnings`。
- 不把 `exitState` 当字面匹配硬门禁；它是语义状态。
- 每段最多重试 2 次；重试 prompt 必须包含失败原因、目标字数、上一段尾部和禁止项。
- 达到上限后标记该段 `failed`，停止本章，不继续生成后续段。

## 恢复模型

扩展 `src/core/types.ts`：

```ts
export interface RunRecovery {
  fromRunId: string
  partialPath: string
  strategy: 'regenerate' | 'resume-segments'
  completedSegments?: string[]
  nextSegmentId?: string
}
```

- `findRecoverableRun`（`src/core/runs.ts`）新增识别：最后 run 为 failed/cancelled，且存在未完成段。
- `weave write 12 --resume <runId>`：从第一个未完成段继续，已完成段保留且不重跑。
- 恢复运行使用新 `runId`，旧 run 终态不被篡改；新 run 记录 `recovery.fromRunId`。
- partial 只在段边界追加；绝不从半段文本续写。
- 如果段计划、合同或节拍在失败后变化，拒绝恢复，要求重新批准计划。

## 事件

- `segment-retry`：包含 `segmentId`、`attempt`、`reason`。
- `segment-completed`：包含 `segmentId`、`contentHash`、`usage`。
- 取消/失败终态事件与现有 run 语义一致。

## 验收

- 构造 40 字重叠的连续两段，合并后重叠被裁掉且正文语义不重复。
- 构造超短段，触发一次重试；重试仍失败时该段标记 failed，后续段不生成。
- 第 3 段失败后 `--resume` 从第 3 段开始，前 2 段 contentHash 不变。
- 半段取消后 partial 可读，但不会被直接当成草稿或续写输入。
- 修改合同/节拍后恢复被拒绝，提示重新批准分段。
- 旧 `regenerate` 恢复行为与测试不回归。

## 非目标

- 不做语义级或 LLM 级硬门禁；语义问题交给后续 review。
- 不做自动改写、自动重写循环或无限重试。
- 不做跨段并行恢复，不做透明断点续传。
