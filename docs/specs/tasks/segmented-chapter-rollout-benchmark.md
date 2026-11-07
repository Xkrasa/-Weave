---
id: segmented-chapter-rollout-benchmark
type: task-spec
title: 分段生成的效果基线与放量门槛
status: ready
parent: weave-effect-first-architecture
depends-on:
  - segmented-chapter-generation
  - segmented-chapter-checks-recovery
references:
  - weave-next-iteration-plan
  - effect-evaluation-harness
tags:
  - generation
  - benchmark
  - rollout
---

# 分段生成的效果基线与放量门槛

## 任务目标

在分段生成进入默认路径前，用真实模型和可复现实验回答三个问题：是否更少截断、是否更少门禁失败、是否值得多花的成本。没有数据就不放量。

## 实验设计

复用 `scripts/benchmark.ts` 与 `bench/BASELINE.md` 的记录方式，新增三组固定样本：

| 组 | 目标字数 | 段数 | 说明 |
| --- | --- | --- | --- |
| S | 3000 | 2 | 普通章 |
| M | 6000 | 3–4 | 长章 |
| L | 9000 | 4–6 | 压力章 |

每组固定同一合同、同一已批准节拍、同一模型与温度；只改变 `draftingStrategy`（`prose-first` vs `segmented`）。每配置至少跑 3 次，记录中位数与失败样本。

重复由 `scripts/benchmark.ts` 内建：

- `benchmark run` 默认 `--repeat 3`；第一次保持原有输出目录，后续写入 `repeat-2/`、`repeat-3/`，`pairs` 仍读第一次目录。
- 顶层 `report.json` / `report.md` 用中位数聚合数值（章节数、耗时、token、失败段等），并写明 `repeats` 与“数值为中位数”，不把重复当成更多章节。
- 只做冒烟时可显式 `--repeat 1`；`--repeat` 必须是 ≥1 的整数。

## 指标

- 完成率：无截断、无空正文、无中途失败的比例。
- 段级首次通过率：不需要重试的段占比。
- 合并后门禁：`content-check` / `extract` / `audit` / `review` 的 blocking 数与通过率。
- 成本：总 token、输入/输出 token、墙钟时间。
- 质量：至少 1 轮盲评，比较同章两版；记录偏好与理由，不用单一总分。
- 稳定性：重复段落、意象重复、段间接缝人工抽检。

## 放量门槛

同时满足才允许从“显式 `--strategy segmented`”升级为默认建议：

1. L 组完成率 ≥95%；
2. 段级首次通过率 ≥90%；
3. 合并稿门禁通过率不低于单次路径；
4. 总成本 ≤单次路径的 1.25 倍；
5. 至少有 1 轮盲评留痕，且未出现“分段明显更差”的一致结论。

未达标时保持显式 opt-in，并在 README/CLI help 标注实验状态。

## 文档与记录

- 更新 `bench/BASELINE.md`：日期、模型、样本、命令、原始结果路径。
- 在 `docs/plans/next-iteration-plan.md` 记录放量裁决。
- 在 CLI help 写明：分段需要已批准节拍与已批准段计划，不是零配置默认路径。

## 验收

- 三组样本可一键复跑，默认 3 次并被聚合为中位数；命令与随机种子固定。
- 报告能区分“工程通过”和“阅读效果”：没有盲评就明确写未验证。
- 成本与门禁数据来自真实 `usage` 和真实阶段报告，不用估算替代。
- 放量结论与数据一致；未达标时默认路径不变。
- 现有 `npm run bench` 与基线格式兼容。

## 非目标

- 不用生成次数、平均分或模型自评替代作者盲评。
- 不在数据不足时把分段设成默认，不做营销式结论。
- 不为了指标降低定稿门禁或跳过审计。
