---
id: context-assembly-profiles
type: task-spec
title: 装配配比命名预设
status: deferred
parent: weave-effect-first-architecture
depends-on:
  - context-degradation-tiers
  - context-assembly-preview
references:
  - weave-maliang-optimization-plan
  - weave-research-maliangwriter-competitive-analysis
tags:
  - context-engineering
  - authoring-ui
---

# 装配配比命名预设

## 启动条件

对应马良「三套官方配比」（大批量写正文 / 关键章节 / 纯聊创意）。搁置原因：在降级档与装配预览不存在时，预设没有可组合的机制，也没有可观察的效果。启动条件：

1. `context-degradation-tiers` 与 `context-assembly-preview` 已交付；
2. 作者实际写作中出现了「反复手动调整同一组装配开关」的记录或反馈。

若无第 2 条证据，说明预设是伪需求，继续搁置。

## 实现边界

- `.weave/context-profiles.json`：作者自定义命名预设，每个预设只是既有开关（披露范围、降级允许、章纲/卷纲范围、悬念开关等）的一组取值。
- UI 一键切换预设；切换后 `context-assembly-preview` 立即反映结果。
- 不引入新机制——预设是既有配置的组合视图，不是新的装配逻辑。

## 必须遵守

- 预设不得绕过任何硬约束：`required` 不降级、`unknown provenance` 阻断、`withheld` 报告语义在预设下不变。
- 不内置平台级默认预设下发，预设完全属于作者本地。

## 验收

- 切换预设后的装配结果与手动逐项配置完全一致（同一 `contextHash` 口径）。

## 非目标

- 不做自动选择预设或按章节类型自动切换。
