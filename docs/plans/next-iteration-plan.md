---
id: weave-next-iteration-plan
type: optimization-plan
title: 百万上下文、分段生成、章节驾驶舱与想法收件箱
status: ready
tags:
  - context-engineering
  - generation
  - ui
  - ideas
date: 2026-11-07
---

# 百万上下文、分段生成、章节驾驶舱与想法收件箱

> **状态（2026-11-07）**：本计划只完成任务拆分，尚未开始实现。任务以 `docs/specs/tasks/` 下的 task-spec 承载，状态统一从 `ready` 起步；交付后改为 `implemented`。
>
> **约束**：继续遵守 `docs/specs/effect-first/SPEC.md` 的内核——作者权威、字节级证据、不可变提交、草稿与定稿隔离、POV 信息边界、显式降级、定稿门禁不可绕过。
>
> **口径**：工程测试是回归底线，不是阅读效果证据。分段生成的效果结论必须来自真实模型 A/B，不用“能跑通”替代盲评。

## 一、裁决

| # | 议题 | 裁决 | 理由 |
| --- | --- | --- | --- |
| 1 | 1M 上下文窗口 | 默认 `contextWindow: 1_000_000`，同时新增 `contextBudgetTokens`（默认 120k）；老项目只允许显式 `weave config migrate` 升级 | 窗口是能力上限，不是填充目标；软预算控制成本、延迟与注意力稀释 |
| 2 | 长输出 | A+B 合体：先把输出预留降到每段 4096，再按“已批准节拍”分段生成，逐段确定性校验，合并后仍走原定稿门禁 | 单次输出上限无法靠窗口解决；分段把长任务变成可校验、可恢复的小任务 |
| 3 | 章节驾驶舱 | 在现有 vanilla 三栏 UI 上升级：意图条 + 证据层 + 门禁条 + 状态栏；正文用“编辑/审阅”双模式，不做富文本编辑器 | 复用现有 textarea、修订合并和证据定位；避免富文本与偏移同步的高成本 |
| 4 | 想法记录 | 新建 `ideas/`：JSON 元数据 + Markdown 正文；`inbox → promoted → feedback` 两段式；晋升只产出候选，绝不自动写 ledger/canon | 现有 `plans/canon/references/preferences` 都不是低门槛捕获入口；作者意图必须先显式晋升 |

## 二、任务清单

| 批次 | id | 标题 | 依赖 | 主要落点 |
| --- | --- | --- | --- | --- |
| A 容量 | `context-window-budget-config` | 将百万上下文窗口接入可用预算 | 无 | `project.ts`、`context.ts`、`model-policy.ts`、`cli.ts` |
| B 分段 | `segmented-chapter-plan-model` | 建立作者批准的分段计划模型 | 无 | `segments.ts`、`beats.ts`、`types.ts`、`cli.ts` |
| B 分段 | `segmented-chapter-generation` | 按分段计划生成并合并草稿 | `context-window-budget-config`、`segmented-chapter-plan-model` | `writing.ts`、`context.ts`、`segments.ts`、`ui-server.ts` |
| B 分段 | `segmented-chapter-checks-recovery` | 段级确定性校验与段边界恢复 | `segmented-chapter-generation` | `segment-checks.ts`、`runs.ts`、`types.ts`、`cli.ts` |
| B 分段 | `segmented-chapter-rollout-benchmark` | 分段生成的效果基线与放量门槛 | `segmented-chapter-generation`、`segmented-chapter-checks-recovery` | `scripts/benchmark.ts`、`bench/BASELINE.md`、README |
| C 驾驶舱 | `chapter-cockpit-read-model` | 驾驶舱聚合读模型与证据偏移 | 无 | `cockpit.ts`、`text-offsets.ts`、`ui-server.ts` |
| C 驾驶舱 | `chapter-cockpit-evidence-view` | 只读驾驶舱与证据高亮定位 | `chapter-cockpit-read-model` | `ui/index.html`、`styles.css`、`ui/cockpit.js` |
| C 驾驶舱 | `chapter-cockpit-actions` | 下一步状态机、命令面板与内联 diff | `chapter-cockpit-evidence-view`、`segmented-chapter-generation` | `ui/cockpit.js`、`ui-server.ts`、`cockpit.ts` |
| D 想法 | `idea-inbox-core` | 想法收件箱模型、存储与 CLI/API | 无 | `ideas.ts`、`project.ts`、`cli.ts`、`ui-server.ts` |
| D 想法 | `idea-promotion-pipeline` | 想法晋升、待裁决与失效检测 | `idea-inbox-core` | `ideas.ts`、`pending.ts`、`ui-server.ts` |
| D 想法 | `idea-context-feedback` | 晋升想法受控回灌写作与审查 | `idea-promotion-pipeline` | `materials.ts`、`context.ts`、`review.ts` |
| D 想法 | `idea-map-ui` | 想法地图与驾驶舱想法页签 | `idea-inbox-core`、`idea-promotion-pipeline`、`idea-context-feedback`、`chapter-cockpit-read-model` | `ui/ideas.js`、`ui-server.ts` |

## 三、依赖图

```text
context-window-budget-config ─┬─> segmented-chapter-generation ─> segmented-chapter-checks-recovery ─> segmented-chapter-rollout-benchmark
segmented-chapter-plan-model ─┘

chapter-cockpit-read-model ─> chapter-cockpit-evidence-view ─> chapter-cockpit-actions
                                                   ▲
segmented-chapter-generation ──────────────────────┘

idea-inbox-core ─> idea-promotion-pipeline ─> idea-context-feedback ─> idea-map-ui
                                                        ▲
chapter-cockpit-read-model ─────────────────────────────┘
```

## 四、批次与里程碑

| 里程碑 | 交付 | 工作量 | 退出条件 |
| --- | --- | --- | --- |
| M1 容量 | A 批全部任务 | 0.5–1 天 | 新项目 1M/8k/120k；老项目不静默变更；配置与预算测试全绿 |
| M2 分段内核 | `plan-model` + `generation` + `checks-recovery` | 3–5 天 | 9000 字章节无截断；段级重试有上限；合并稿仍过原门禁 |
| M3 驾驶舱只读 | `read-model` + `evidence-view` | 2 天 | 一次请求打开章节；点击 finding 精确跳到第 N 次出现 |
| M4 想法内核 | `inbox-core` + `promotion-pipeline` | 2–3 天 | 捕获 5 秒内完成；晋升不写 ledger；目标变更显示 stale |
| M5 驾驶舱操作 | `actions` + `idea-map-ui` | 3–4 天 | Ctrl+Enter 执行正确下一步；想法地图可按卷统计覆盖率 |
| M6 放量 | `rollout-benchmark` | 2 天 | 分段 vs 单次 A/B 有留痕；成本 ≤1.25 倍；默认策略有数据依据 |

总计约 11–16 个工作日（单人、含测试）。M3/M4 可在 M2 稳定后并行。

## 五、跨任务不变量

1. **作者权威**：任何 AI 候选、想法晋升、分段计划都必须作者显式批准；不得自动写 `ledger/` 或 `canon/`。
2. **不静默丢失**：`withheld` / `degraded` / `omitted` 必须出现在装配报告与驾驶舱预算页；预算裁剪不能当作“没发生”。
3. **定稿门禁不变**：分段生成只改变起草路径；合并后仍要求抽取、审计、独立复检，`finalizeChapter` 仍绑定合并稿 hash。
4. **不静默迁移**：`contextWindow`、`maxOutputTokens`、`contextBudgetTokens` 的默认值变化只影响新项目；老项目必须显式迁移。
5. **一次一批一个变量**：分段、驾驶舱、想法分开验收；不与无关重构混合，效果实验先记录 `bench/BASELINE.md`。
6. **不做的事**：不引入富文本编辑器、不做无人值守整书生成、不做透明断点续写、不把 1M 当填充目标。

## 六、效果与基准

- 分段生成：3 章 × 3000/6000/9000 字，固定合同与已批准节拍；比较完成率、段级首次通过率、门禁通过率、总 token、墙钟时间、人工盲评偏好。
- 放量门槛：9000 字完成率 ≥95%；段级首次通过率 ≥90%；成本 ≤单次的 1.25 倍；门禁通过率不下降；至少 1 轮盲评。
- 驾驶舱与想法：以可用性验收为主（定位准确率、操作步数、捕获耗时），不伪装成阅读效果证据。
- 现有欠账：`bench/BASELINE.md` 仍是 0 次盲评、holdout 未跑、检索召回 1/3；本计划交付时不得把工程通过写成效果已证明。

## 七、本方案采用的默认值（可改）

| 项 | 默认 | 备选 |
| --- | --- | --- |
| 写作软预算 | 120k | 96k（更省）、160k（更多旧场景） |
| 每段目标字数 | 1500–2500 | 2000–3000（更少段、更长输出） |
| 单章段数上限 | 6 | 8（仅超长章） |
| 每段输出预留 | 4096 | 6148（更少重试） |
| 想法存储 | 每想法 JSON + MD | 单 MD + frontmatter（需自写 YAML 子集解析） |
| 晋升方式 | 产出候选/预填编辑器，作者应用 | 直接写目标草稿（更快但越权风险高） |

如无异议，按以上默认值实现；有异议先改对应 task-spec，再动代码。

## 八、执行顺序

1. `context-window-budget-config`（M1，先验证不回归）。
2. `segmented-chapter-plan-model` → `segmented-chapter-generation` → `segmented-chapter-checks-recovery`（M2，先跑一章真实合同的最小切片）。
3. `chapter-cockpit-read-model` → `chapter-cockpit-evidence-view`（M3，可与 M2 后半并行）。
4. `idea-inbox-core` → `idea-promotion-pipeline` → `idea-context-feedback`（M4，可与 M2/M3 并行）。
5. `chapter-cockpit-actions` + `idea-map-ui`（M5）。
6. `segmented-chapter-rollout-benchmark`（M6，最后放量）。

## 九、放量裁决（2026-11-07）

- 三组固定样本（`segmented-rollout-s/m/l`）与命令已落地，fake 模式跑通接线；真实模型、门禁与盲评数据均**未采集**。
- 因此当前裁决：保持 `--strategy segmented` 显式 opt-in，不改为默认建议。
- 升级条件仍按第六节五项门槛；数据补齐后再在本节记录裁决与证据路径。
