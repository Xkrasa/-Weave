---
id: style-range-derivation
type: task-spec
title: 文风区间从作者定稿反推
status: implemented
parent: weave-effect-first-architecture
depends-on: []
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - style
  - author-authority
---

# 文风区间从作者定稿反推

## 任务目标

`canon/style.json` 的手填区间是作者**以为**的自己，与他**实际**写的常有偏差，且有冷启动成本。从作者定稿量值反推区间，作为**建议值**供作者采纳。

## 现状

`src/core/style.ts` 只读取 `style.json`（默认 8–40 字、对话占比 0.05–0.65）；`src/core/methods.ts` 已有 `sentences / averageSentenceLength / dialogueRatio` 统计并对照区间，但没有从定稿反推区间，也没有标点维度。

## 实现边界

- `src/core/style.ts` 新增 `deriveStyleRange(samples)`：复用 `methods.ts` 统计，取分位数（P25–P75）而非均值，输出建议值。
- 增加 `dashRatio`、`questionMarkRatio` 等标点频率字段——破折号过量是典型的 AI 味特征，也是 `content-check` 类正则管不到的量。
- 建议值写 `.weave/style-candidate.json`（含推导来源章节），`weave style adopt` 后才写 `canon/style.json`；`weave style` 命令已存在，只加子命令。

## 必须遵守

- AI 推导值不得自动标 `author`：`canon/style.json` 只有作者确认后才变——对应「作者权威不可越权」。
- 近期章节若刻意偏离风格（如战斗章），分位数会把异常当常态：允许只用作者标记的「代表章」样本，且必须显示推导来源章节。

## 验收

- 同一批样本重复推导结果稳定。
- adopt 前 `canon/style.json` 不变；adopt 后 `methods.ts` 的区间校验按新值生效。

## 非目标

- 不自动 adopt，不周期性静默刷新候选。
- 不做「风格迁移生成」或按参考作品生成风格区间。
