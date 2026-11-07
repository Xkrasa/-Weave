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

`src/core/ideas.ts` 提供：

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

promoteIdea(root, ideaId, target, options?): Promise<PromotionProposal>
savePromotionProposal(root, proposal): Promise<string>
loadPromotionProposal(root, ideaId): Promise<PromotionProposal | null>
applyPromotion(root, ideaId, proposal): Promise<IdeaView>
listStaleIdeas(root): Promise<IdeaView[]>
```

- `promoteIdea` 只读目标、生成差异与建议文本；不写目标文件，但会把提案存到 `.weave/idea-proposals/<id>.json` 并作为一条未裁决 pending 暴露。
- `applyPromotion` 调用目标现有保存函数；若目标需要批准，只写“草稿/候选”态，不写“已批准”。
- 应用成功后写 `promotion`：`targetPath`、`targetHash`、`promotedAt`、`approvedBy: 'author'`，并把 `status` 改为 `promoted`。
- `promotionState` 由目标文件当前 hash 与 `promotion.targetHash` 实时比较得出；不使用持久化的 `markPromotionStale`。目标被回改、重建或重新批准后即显示 `stale`，不自动重新应用。

## 目标落点

| target | 落点 | 写入语义 |
| --- | --- | --- |
| `plan` | `plans/rolling.json` | `savePlanDraft` 写滚动计划草稿；批准仍走现有计划批准 |
| `contract` | `plans/candidates/chapters/XXX.json` | 生成 `OutlineCandidate`（`status: draft`、`model: idea:<id>`），把想法正文追加进合同 `goal` 并带 `【想法 <id>：<标题>】` 标记；`outline apply` 后才可能进入正式合同 |
| `outline` | `plans/candidates/chapters/XXX.json` | 与 `contract` 共用同一 `OutlineCandidate`，同样只写候选 |
| `canon` | `canon/<idea-id>.candidate.md` | 只写 `.candidate.md`；作者确认后才写正式 canon |
| `promise` | `plans/volumes/XXX.json` | `savePlanDraft` 写卷计划草稿，向 `readerPromises` 追加一条；不自动批准 |

- `contract` / `outline` 需要 `chapter` scope；`promise` 需要 `volume` scope，且该卷必须已有计划文件。
- `plan` 使用想法的 chapter scope 或 `revealAfterChapter` 决定候选章号。
- **任何 target 都不允许直接写 `ledger/`；`ledger` 一律拒绝。**

## 待裁决集成

复用 `src/core/pending.ts` 的存储与决策日志：

- `PendingKind` 增 `'idea-promotion'`；`PendingChoice` 增 `'promote'`。
- pending id 固定为 `idea-promotion-<ideaId>`，payload 由 `.weave/idea-proposals/<id>.json` 提供；`listIdeaPromotionPendings` 扫描提案文件。
- `decidePending` 增分支：`promote` → 动态导入并调用 `applyPromotion`；`dismiss` → 只记录驳回，想法保持原状态。
- 决策同时写入 `recordIdeaPromotionDecision` 的审计日志（`idea-promote` / `idea-dismiss`），带 ideaId、目标路径、理由。
- 现有 `ledger-conflict` / `audit-missed` 的语义与测试不变；UI 的 `/api/pending` 额外返回 `ideaPromotions`，`/api/pending/decide` 接受不带 `chapter` 的 `promote` / `dismiss`。

## 失效检测

- `listIdeas` 计算 `promotionState: 'active' | 'stale' | 'none'`，对比目标文件当前 hash 与 `promotion.targetHash`。
- 目标被回改、重建或重新批准后，想法显示 stale，提示“晋升目标已变化，请重新评估”。
- stale 不自动回滚目标，也不自动把想法移回收件箱。
- 想法地图只把显式 `usage` 或已定稿的 `links.chapters` 计为“已使用”；晋升本身不证明想法进入正文。

## CLI

```bash
weave idea promote <id> --to plan|contract|outline|canon|promise [--target <path>]
weave idea apply <id>
weave idea pending
weave idea dismiss <id> --reason 理由
weave idea stale
```

## 验收

- `promote` 输出目标、当前 hash、建议文本和 diff；目标文件在 `apply` 前不变。
- `apply` 到 contract/outline 只产生 `plans/candidates/chapters/XXX.json` 候选，必须走现有 `outline apply` 才成为合同；不会自动批准。
- `apply` 到 canon 只产生 `<id>.candidate.md`，正式 canon 不变。
- `apply` 到 plan/promise 只写 `savePlanDraft` 的草稿态，批准标记不出现。
- 应用后 `git status` 不出现 `ledger/` 变更。
- `promote` 后 `weave idea pending` 能看到 `idea-promotion-<id>`；`dismiss` 只关闭 pending，不修改目标文件。
- 手动修改目标文件后，`list` 显示 `stale`；再次 `promote` 需要重新生成 diff。
- pending 决策日志可追溯：谁、何时、对哪个目标、应用了哪条想法。
- 现有 pending 测试与 CLI 行为不回归。

## 非目标

- 不做“一键自动写入所有计划/设定”。
- 不复制合同、计划、章纲的批准逻辑；一律调用现有服务。
- 不把想法晋升成 ledger 事实或既成剧情。
