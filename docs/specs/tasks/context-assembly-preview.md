---
id: context-assembly-preview
type: task-spec
title: 写作前的本章装配预览
status: draft
parent: weave-effect-first-architecture
depends-on:
  - assembled-context-report
references:
  - weave-maliang-optimization-plan
  - weave-research-borrowable-designs-from-maliangwriter
tags:
  - context-engineering
  - observability
---

# 写作前的本章装配预览

## 任务目标

作者在点发送前就能看到本章装配了什么：预计 token、各维度材料计数、`omitted / withheld / degraded` 三类清单，并显示 `contextHash` 供事后比对。对应「运行记录能解释一次生成使用了哪些材料」，把可解释性从生成后提前到生成前。

## 现状

`AssembledContext` 已含 `included / omitted / estimatedTokens`（`src/core/context.ts:24-33`），但只在生成后随 run 落盘，写作前不可见；UI 无预览入口。

## 实现边界

- `src/core/ui-server.ts` 增只读接口 `GET /api/context/preview?chapter=N`：复用 `collectMaterialBundle` + `assembleContext`，不改生成路径。
- `src/ui/app.js` 在写作区显示 token 条、材料分组计数与三类清单。
- CLI 侧 `weave context --chapter N`；若能完全复用 `weave status` 的现成输出则不加新命令。

## 必须遵守

- 预览与 `write` 走**同一函数、同一参数**——预览与实际发送不一致比没有预览更糟。
- `contextHash` 必须随预览一起显示，作为「预览 = 实际」的可验证凭证。

## 验收

- 预览显示的 `contextHash` 与实际写入 run 记录的一致。
- 三类清单（含被各自任务填充的 `withheld` / `degraded`）在预览中可见。

## 非目标

- 不在预览里改配置——预设切换属于 `context-assembly-profiles`。
- 不做实时流式装配或延迟优化。
