---
id: context-window-budget-config
type: task-spec
title: 将百万上下文窗口接入可用预算
status: ready
parent: weave-effect-first-architecture
references:
  - weave-next-iteration-plan
tags:
  - context-engineering
  - budget
  - config
---

# 将百万上下文窗口接入可用预算

## 任务目标

让 1M 窗口真正可用，同时不被“窗口越大就塞得越多”反噬：把模型能力上限（`contextWindow`）和项目写作预算（`contextBudgetTokens`）分开，并让作者能看见、能修改、能校验。

## 现状

- 新项目默认 `contextWindow: 32768`、`maxOutputTokens: 4096`（`src/core/project.ts:133-136`），模型支持 1M 也用不上。
- 容量公式把输入压到 `contextWindow - maxOutputTokens - safetyMarginTokens - fixedTokens`（`src/core/context.ts:62-63`）；`maxOutputTokens` 越大，输入反而越小。
- `contextWindow` 只用于本地预算，不发给服务商；实际发送的是 `max_tokens`（`src/core/model.ts:154`）。
- 中文场景下 `charsPerToken: 1.6` 偏乐观：3000 字只估 1875 token，容易低估。
- CLI 没有 `config` 命令（`src/cli.ts:167-265`）。

## 实现边界

### 配置模型

- `src/core/types.ts`：`ModelConfig` 增 `contextBudgetTokens?: number`；`taskModels` 的每任务覆盖同步支持该字段。
- `src/core/project.ts`：`InitOptions` 增 `contextBudgetTokens?: number`；新项目默认 `contextWindow: 1_000_000`、`maxOutputTokens: 8_192`、`contextBudgetTokens: 120_000`。
- `src/core/model-policy.ts`：`resolveTaskConfig` 透传 `contextBudgetTokens`，写作任务可单独设置。

### 预算公式

```ts
const effectiveWindow = Math.min(
  config.contextWindow,
  config.contextBudgetTokens ?? config.contextWindow,
)
const capacityTokens =
  effectiveWindow - config.maxOutputTokens - config.safetyMarginTokens - fixedTokens
```

- `effectiveWindow` 与 `capacityTokens` 必须出现在装配结果、`/api/context/preview` 与驾驶舱预算页。
- `split-required` / `capacity-conflict` 的判定语义不变，只是分母换成 `effectiveWindow`。
- 默认不把 `contextBudgetTokens` 设成 1M；1M 只在显式“全书检索/大纲重构”任务中作为上限。

### 配置命令

```bash
weave config show
weave config set --context-window 1000000 --max-output 8192 --context-budget 120000 --chars-per-token 1.5
weave config migrate
```

- 只允许白名单字段；校验 `maxOutputTokens + safetyMarginTokens < effectiveWindow`；非法值直接拒绝。
- `config show` 输出模型、窗口、软预算、输出预留、剩余输入容量。
- `config migrate` 只对当前项目显式执行，打印变更前后值；不得在读取配置时自动升级。

### 中文 token 校准

- 实现于 `src/core/token-calibration.ts`：每次 run 把 `usage.promptTokens` 与实际发送字符数写入 `.weave/token-calibration.json`。
- `observedCharsPerToken` 用 EWMA（`alpha = 0.3`）更新，并夹在 `0.25–8` 之间，避免单次异常值污染估算；文件同时保存 `samples`、`updatedAt` 与最近一次 `{ promptChars, estimatedTokens, promptTokens }`。
- 装配估算取 `Math.min(config.charsPerToken, observed)`（更保守值）；没有观测时退回配置值。`assembledContext` 暴露本次使用的 `promptChars` 与 `charsPerToken`，分段 run 累加各段字符数写入 `RunRecord.estimatedPromptChars`。
- `weave doctor` 在文本与 `--json` 输出中都给出“估算 vs 实际”偏差（`calibration.deviation`，负数表示少估），偏差绝对值超过 20% 时提示作者调整 `charsPerToken`。
- 估算只基于服务商返回的 usage，不引入精确 tokenizer 依赖。

## 必须遵守

- 老项目配置不被静默改写；代码默认值变化不能改变已有项目行为。
- `contextBudgetTokens` 只影响装配预算，不改变 `required` 材料优先级，也不改变 `withheld` 语义。
- 不引入精确 tokenizer 依赖；校准只基于服务商返回的 usage。

## 验收

- 新项目 `config show` 显示 1M 窗口、120k 软预算、8k 输出预留，剩余输入容量约 110k。
- 把软预算压到 32k 后，可选材料按现有 `relevance → priority` 规则裁剪，报告出现 `omitted` / `degraded`；`required` 超限仍是 `split-required` / `capacity-conflict`。
- 老项目不执行 `config migrate` 时，行为与变更前一致；执行后值被原子写入且可回读。
- 非法 `config set`（如输出预留大于窗口）被拒绝，原配置不变。
- `weave doctor` 能显示窗口、软预算、实际用量、最近一次 token 估算偏差；超过 20% 时出现警告。
- `npm run typecheck` 与现有测试全绿。

## 非目标

- 不做自动探测服务商真实窗口，也不按模型名猜窗口。
- 不把 1M 作为默认填充目标，不做“全书一次性注入”。
- 不实现精确 tokenizer；不引入新的 token 计算依赖。
