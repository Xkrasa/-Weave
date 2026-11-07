---
id: idea-map-ui
type: task-spec
title: 想法地图与驾驶舱想法页签
status: ready
parent: weave-effect-first-architecture
depends-on:
  - idea-inbox-core
  - idea-promotion-pipeline
  - idea-context-feedback
  - chapter-cockpit-read-model
references:
  - weave-next-iteration-plan
  - planning-authoring-ui
tags:
  - ideas
  - ui
  - map
---

# 想法地图与驾驶舱想法页签

## 任务目标

让作者看见“想法有没有被用、用在哪、哪一卷还空着”：右栏可捕获和分诊，顶栏可打开全书想法地图；地图只读统计，不自动晋升、不自动改写。

## 读模型

`GET /api/ideas/map` 返回：

```ts
interface IdeaMap {
  totals: { inbox: number; promoted: number; archived: number; stale: number }
  byVolume: Array<{
    volume: number
    promoted: number
    used: number
    unused: number
    stale: number
    highPriorityUnused: Array<{ id: string; title: string }>
  }>
  byCharacter: Array<{ name: string; ideaIds: string[] }>
  byTag: Array<{ tag: string; ideaIds: string[] }>
}
```

“已使用”的判定（保守，不猜语义）：

1. 想法 `links.chapters` 含已定稿章节；或
2. 晋升目标为已批准计划/合同/章纲，且该目标已被至少一个定稿章节引用；或
3. 作者在 UI 手动标记“已使用”。

无法判定时归入 `unused`，不把“可能用过”算成已用。

## 右栏“想法”页签

- 顶部捕获框：`Ctrl+I` 聚焦，回车保存；显示“5 秒内可撤销”提示。
- 列表分组：收件箱 / 已晋升 / 已归档；每项显示标题、scope、priority、spoiler 徽章、`promotionState`。
- 操作：
  - 晋升 → 打开晋升弹窗（target 选择 + diff 预览 + 应用/取消）；
  - 归档；
  - 跳转到关联章节或计划。
- 晋升弹窗复用 `idea-promotion-pipeline` 的 proposal；应用前必须作者点击，不默认勾选。

## 顶栏“想法地图”

- 与现有“盲评 / 搜索 / 拆书 / 体检 / 导出”并列。
- 按卷展开：已晋升、已使用、未使用、过期；高优先级未使用置顶。
- 点击条目跳到对应章节/计划/想法详情。
- 不做力导向图、不做动画；用列表 + 简单条形统计即可。

## 验收

- 捕获框回车后 5 秒内出现在列表，无需刷新整页。
- 收件箱、已晋升、已归档数量与 `/api/ideas/map` 一致。
- 晋升弹窗能看到目标 diff；未点“应用”时目标文件不变。
- 地图按卷显示覆盖率；无法判定用途的想法归入 `unused`，不虚报“已使用”。
- 点击地图条目能跳到正确章节/计划；跳转失败有明确提示。
- `Ctrl+I` 不与现有 `Ctrl+K` 搜索、`Ctrl+S` 保存冲突。
- 现有驾驶舱布局与右栏页签切换不回归。

## 非目标

- 不做知识图谱、力导向图、动画仪表盘。
- 不自动晋升、不自动标记“已使用”、不自动删除想法。
- 不把想法地图当成阅读效果证据。
