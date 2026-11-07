---
id: task-model-policies
type: task-spec
title: 按创作任务配置模型与结构化输出
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - effect-evaluation-harness
tags:
  - model-policy
  - structured-output
  - usage
---

# 按创作任务配置模型与结构化输出

## 任务目标

让规划、正文、抽取、可信审查、效果审查和修稿使用各自合适的模型、采样与输出契约，取代所有任务共享同一温度与输出预算的隐式行为。

## 配置契约

支持按任务配置模型、base URL、temperature、最大输出、timeout 和必要 provider 参数。未配置任务继承现有默认配置，保持旧项目可读。

至少区分：

```text
planning / writing / extraction / trustedReview / effectReview / revision
```

不预设“写作必须高温”或“审查必须弱模型”。写作与效果审查优先选择经项目 benchmark 验证的模型；抽取和可信审查通常使用较低温度。配置与每次实际生效值都写入运行记录。

无模型配置仍允许建书、手工写作、浏览和导出；只有调用模型的操作给出明确配置错误。

## 结构化输出

为抽取、审计、审查和修订定义独立 schema。适配器按 provider 能力选择：

1. JSON Schema 或 structured outputs；
2. tool calling；
3. 现有 JSON 文本解析兜底。

能力不支持时不得盲目发送不兼容参数。所有路径都经过相同的本地 schema、证据和业务校验；解析成功不等于记录可信。失败提供有限修复重试并保留原始输出，不静默接受缺字段结果。

## 用量与成本

按任务汇总 prompt/completion token、缓存 token（若提供）、耗时和失败次数。可以提供 `weave usage`；只有配置模型价格后才报告货币成本，否则明确输出 token 用量而非虚构价格。

## 验收

- 假模型能分别验证写作、抽取和审查收到各自模型、温度和输出预算。
- 旧配置未填写新字段时行为兼容，运行记录能看到实际继承结果。
- structured outputs、tool calling 和文本兜底最终通过同一校验。
- 不支持的 provider 能力能明确降级，不因未知参数直接整章失败。
- 无模型项目的手工编辑和导出不受影响。
- usage 按任务聚合，未配置价格时不输出伪精确成本。

## 非目标

- 不内置对某一商业模型的质量承诺。
- 不把结构化输出当作事实正确性或文学质量保证。
