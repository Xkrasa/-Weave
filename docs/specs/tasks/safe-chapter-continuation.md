---
id: safe-chapter-continuation
type: task-spec
title: 恢复安全的上一章正文衔接
status: draft
parent: weave-effect-first-architecture
depends-on:
  - effect-evaluation-harness
tags:
  - pov
  - continuity
  - context
---

# 恢复安全的上一章正文衔接

## 任务目标

让下一章知道上一章实际如何收束，并在可证明安全时看到少量定稿结尾原文，从而改善动作、位置、情绪和语言衔接，同时不削弱 limited POV 的信息边界。

## 输入与真源

衔接状态只能来自：

- 上一章当前主线选择的定稿正文；
- 与该提交绑定的抽取、事件、事实和信念；
- 上一章与当前章合同中的 POV、时间、地点和场景关系。

上一章合同的 `endingState` 只能用于判断计划连续性，不能作为实际结局注入。

## 输出契约

生成一种明确的衔接材料：

```text
mode: prose | summary
actualEnding: 从定稿证据恢复的实际收束状态
excerpt?: 有来源提交和证据范围的短结尾
visibility: 可见性判断及依据
fallbackReason?: 未使用原文的原因
```

原文默认只取结尾约 300–800 字，并保留来源提交、章节和证据范围。材料标记为 `finalized-history`，不得被当成当前章新事实。

## 安全策略

只有在同一 limited POV、连续场景且所选结尾能够由当前 POV 可见证据覆盖时，才允许使用 `prose` 模式。跨 POV、全知泄露风险、时间或场景跳跃、证据不足、秘密无法排除时，一律使用 `summary` 模式。

summary 只能包含定稿抽取中当前 POV 可见的实际事件、状态与情绪线索，不回填作者版秘密或其他角色认知。任何检查失败都采取保守降级，而不是放行原文。

## 效果实验

通过 `continuation: safe-prose | summary-only` 对比正文衔接改善。安全测试先于文学评测；一旦发生 POV 泄漏，prose 路径不得视为可发布。

## 验收

- limited POV 的 prompt 能获得上一章实际收束状态，而不是只有标题和静态认知。
- 满足保守条件的连续场景包含短定稿结尾，且能回指来源提交和证据。
- 跨 POV、含秘密、证据不足和非连续场景自动退回摘要。
- 上一章合同写了但正文未发生的 `endingState` 不进入实际衔接。
- 取消或修改上一章主线提交后，旧衔接材料失效。
- A/B 报告分别记录衔接质量与 POV 泄漏，不用文学收益抵消安全问题。

## 非目标

- 不把上一章全文无差别注入 prompt。
- 不承诺模型摘要能够证明“绝无秘密”；无法验证时选择摘要并进一步限制内容。
