---
id: chapter-cockpit-actions
type: task-spec
title: 下一步状态机、命令面板与内联 diff
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - chapter-cockpit-evidence-view
  - segmented-chapter-generation
references:
  - weave-next-iteration-plan
  - planning-authoring-ui
tags:
  - ui
  - workflow
  - diff
---

# 下一步状态机、命令面板与内联 diff

## 任务目标

让作者不用记命令和阶段顺序：驾驶舱根据当前状态给出唯一的“下一步”，键盘可执行；修订 diff、上下文预算和分段状态都在同一屏可见，但任何操作都不绕过原有批准与门禁。

## 下一步状态机

在 `src/core/cockpit.ts` 提供纯函数：

```ts
export type NextAction =
  | { kind: 'contract-check'; label: string }
  | { kind: 'beats-generate' | 'beats-approve'; label: string }
  | { kind: 'segments-plan' | 'segments-approve'; label: string }
  | { kind: 'write'; label: string }
  | { kind: 'stage'; stage: StageKind; label: string }
  | { kind: 'revise' | 'waive'; label: string }
  | { kind: 'finalize'; label: string }
  | { kind: 'done'; label: string }

export function nextAction(payload: CockpitPayload): NextAction
```

优先级：

1. 合同未通过 → 合同检查；
2. 无节拍 → 生成节拍；节拍未批准 → 批准节拍；
3. 启用分段且无计划 → 生成计划；计划未批准 → 批准计划；
4. 草稿为空 → 写章；
5. 有 blocking finding → 修订/豁免；
6. 阶段报告缺失或 stale → 运行对应阶段；
7. 全部通过 → 定稿；
8. 已定稿且无变更 → done。

- `Ctrl+Enter` 调用 `nextAction`；按钮文案与状态机一致。
- 状态机只决定“建议”，不自动执行；作者仍需按键。
- 定稿动作仍走 `finalizeChapter` 原校验，不允许 UI 直接写终态。

## 命令面板

- `Ctrl+P` 打开；现有 `Ctrl+K` 仍是搜索，避免冲突。
- 静态命令表：打开章节、合同检查、生成/批准节拍、生成/批准分段、写章、运行阶段、修订、豁免、定稿、导出、搜索、想法捕获。
- 子串过滤、上下键选择、回车执行、Esc 关闭；不引第三方库。
- 命令只调用已有路由或本计划新增路由，不复制业务逻辑。

## 内联 diff

- 修订 diff：把现有 `showDiff()`（`src/ui/app.js:560`）从弹窗搬到右栏/中栏，显示段落级 before/after；“采纳”仍调用 `/merge`。
- 草稿 vs 最近定稿：新增 `GET /api/chapters/:n/compare?base=commit`，返回段落级 diff 与两侧 hash；只读，不提供“覆盖定稿”。
- 冲突合并沿用现有 `/merge` 的 conflict 处理，不在前端自创合并规则。

## 上下文预算页

右栏新增“上下文”页签，数据来自 `/cockpit` 与 `GET /api/chapters/:n/context/budget`：

- 显示 `effectiveWindow`、`capacityTokens`、`usedTokens`、`remainingTokens`；
- 分组列出 included / omitted(budget) / withheld(not-yet-revealed) / degraded(budget)；
- `included[]` 每项携带 `sourceId`、`label`、`purpose`、`category`、`tokens`、`required`；
- `/api/chapters/:n/context/budget` 返回与 `/cockpit` 同一份装配结果（含 `chapter`），避免前端重算；
- 点击来源打开抽屉预览，只读，不修改材料准入。

## 分段页签

右栏新增“分段”页签：

- 列出段 id、节拍、目标字数、实际字数、状态、重试次数；
- 未批准计划只显示只读预览与“批准”按钮；
- 失败段提供“重试该段 / 从该段恢复”，调用 `segmented-chapter-checks-recovery` 的接口；
- 不提供“跳过检查直接合并”的入口。

## 验收

- 合同未通过、节拍未批准、草稿为空、有 blocking、阶段缺失、可定稿六种状态，`Ctrl+Enter` 都执行正确动作。
- 命令面板能执行至少 10 个常用动作，键盘可完成；不出现绕过门禁的命令。
- 修订 diff 可读，采纳后走原 `/merge`；草稿 vs 定稿 diff 不修改任何文件。
- 上下文页能解释“为什么这段材料没进来”（omitted/withheld/degraded 原因可读）。
- 分段页能重试失败段并从段边界恢复；批准按钮只在计划未批准时出现。
- 所有操作失败时显示原文错误，不静默吞掉。
- 现有 UI 手动验收路径与测试不回归。

## 非目标

- 不做 docx 导出、分发、排版、多标签页。
- 不自动执行“下一步”，不自动定稿。
- 不在前端重算预算、阶段状态或合并冲突；一律用服务端结果。
