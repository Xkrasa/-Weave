---
id: idea-promotion-pipeline
type: task-spec
title: 想法晋升、待裁决与失效检测
status: ready
parent: weave-effect-first-architecture
depends-on:
  - idea-inbox-core
references:
  - weave-next-iteration-plan
tags:
  - ideas
  - promotion
  - pending
---

# 想法晋升、待裁决与失效检测

## 任务目标

让想法从“收件箱”进入“正式规划”时有明确去向、可预览差异、可追溯、可失效：晋升只产出候选或预填编辑器，绝不自动改合同、canon 或 ledger。

## 晋升模型

`src/core/ideas.ts` 增：

```ts
export interface PromotionProposal {
  ideaId: string
  target: 'plan' | 'contract' | 'outline' | 'canon' | 'promise'
  targetPath: string
  currentHash: string
  proposedText: string
  diff: string
  warnings: string[]
}

promoteIdea(root, ideaId, target): Promise<PromotionProposal>
applyPromotion(root, ideaId, proposal): Promise<Idea>
markPromotionStale(root, ideaId): Promise<Idea>
```

- `promoteIdea` 只读目标、生成差异与建议文本；不写目标文件。
- `applyPromotion` 调用目标现有保存函数；若目标需要批准，只写“草稿/候选”态，不写“已批准”。
- 应用成功后写 `promotion`：`targetPath`、`targetHash`、`promotedAt`、`approvedBy: 'author'`，并把 `status` 改为 `promoted`。
- 目标文件当前 hash 与 `targetHash` 不一致时，`promotionState` 为 `stale`；不自动重新应用。

## 目标落点

| target | 落点 | 写入语义 |
| --- | --- | --- |
| `plan` | `plans/` 现有计划文件 | 只写候选段或待合并草稿，批准仍走现有计划批准 |
| `contract` | `outlines/chapters/chapter-XXX.json` | 只生成合同 patch；作者在合同编辑器保存后才生效 |
| `outline` | `outlines/` 章纲文件 | 只写候选，批准仍走 `outline approve` |
| `canon` | `canon/*.md` / `characters.json` | 只生成 diff 或 `.candidate.md`；作者确认后才写正式 canon |
| `promise` | 计划内 reader promise | 只生成 promise 候选，不自动改已批准计划 |

**任何 target 都不允许直接写 `ledger/`。**

## 待裁决集成

复用 `src/core/pending.ts` 的存储与决策日志：

- `PendingKind` 增 `'idea-promotion'`；`PendingChoice` 增 `'promote'`。
- `promoteIdea` 产生一条 pending，携带 `ideaId`、`target`、`targetPath`、`currentHash`、`proposedText`。
- `decidePending` 增分支：`promote` → 调用 `applyPromotion`；`dismiss` → 只关闭 pending，想法保持 `inbox` 或按作者选择归档。
- 现有 `ledger-conflict` / `audit-missed` 的语义与测试不变。

## 失效检测

- `listIdeas` 计算 `promotionState: 'active' | 'stale' | 'none'`，对比目标文件当前 hash 与 `promotion.targetHash`。
- 目标被回改、重建或重新批准后，想法显示 stale，提示“晋升目标已变化，请重新评估”。
- stale 不自动回滚目标，也不自动把想法移回收件箱。

## CLI

```bash
weave idea promote <id> --to plan|contract|outline|canon|promise [--target <path>]
weave idea apply <id>
weave idea stale
```

## 验收

- `promote` 输出目标、当前 hash、建议文本和 diff；目标文件在 `apply` 前不变。
- `apply` 到 contract 只产生合同草稿/patch，必须作者在编辑器保存才成为合同；不会自动批准。
- `apply` 到 canon 只产生候选或 diff，正式 canon 不变。
- 应用后 `git status` 不出现 `ledger/` 变更。
- 手动修改目标文件后，`list` 显示 `stale`；再次 `promote` 需要重新生成 diff。
- pending 决策日志可追溯：谁、何时、对哪个目标、应用了哪条想法。
- 现有 pending 测试与 CLI 行为不回归。

## 非目标

- 不做“一键自动写入所有计划/设定”。
- 不复制合同、计划、章纲的批准逻辑；一律调用现有服务。
- 不把想法晋升成 ledger 事实或既成剧情。
