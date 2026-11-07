---
id: planning-authoring-ui
type: task-spec
title: 提供故事规划与候选创作界面
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - story-planning-model
  - rolling-outline-generation
  - tiered-chapter-generation
references:
  - bounded-story-memory
  - reader-effect-review
  - author-preference-learning
tags:
  - ui
  - planning
  - candidates
---

# 提供故事规划与候选创作界面

## 任务目标

让作者无需编辑原始 JSON 或记忆 CLI 命令，即可完成故事规划、滚动章纲批准、关键段候选选择和阅读效果处理。

## 界面能力

### 故事与卷弧

查看和编辑 StoryPromise、VolumeArc、CharacterArc 与 RollingPlan，明确区分草稿、已批准和修改后待批准状态。批准前展示内容变化及其会影响的后续章纲。

### 滚动章纲

按批次生成、编辑、检查和批准章纲；显示候选与当前合同的差异。生成不会隐式批准，批准不会修改定稿历史。

### 候选创作

对开头、关键选择、高潮和章末候选进行并排比较，显示目标段落、模型和选择状态。选择候选仍只写回草稿，不提供“自动定稿”快捷绕过。

### 审查与记忆

可信 blocking 和阅读效果 warning 在视觉上明确分轨。作者可以回指证据、定位正文、豁免建议，并查看当前卷承诺、伏笔和摘要水位。

## 架构边界

UI 继续调用共享核心服务，不复制批准、材料准入、候选合并或定稿状态机。无模型配置时仍可编辑规划和正文；模型失败不会丢失未保存编辑。

保持本地纯文本/Markdown 编辑，不为本任务引入富文本、云账号、多人协作或独立桌面壳。

## 验收

- 作者可以不手写 JSON 完成从卷弧到下一批已批准合同的路径。
- AI 候选与作者批准在界面上始终可区分，批准绑定当前内容哈希。
- 多候选比较和选择不改变其他段落，不直接更新账本。
- 效果 warning 不会被显示成可信 blocking，定稿风险不会被淡化。
- CLI 与 UI 对同一项目给出相同规划、合同、候选和门禁状态。
- 刷新、失败和并发编辑不会静默覆盖作者修改。

## 非目标

- 不以视觉效果、图谱动画或仪表盘数量作为本任务成功标准。
- 不在正文效果尚未验证前用 UI 扩张替代核心创作实验。
