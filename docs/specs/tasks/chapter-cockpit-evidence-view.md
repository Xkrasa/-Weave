---
id: chapter-cockpit-evidence-view
type: task-spec
title: 只读驾驶舱与证据高亮定位
status: implemented
parent: weave-effect-first-architecture
depends-on:
  - chapter-cockpit-read-model
references:
  - weave-next-iteration-plan
  - planning-authoring-ui
tags:
  - ui
  - evidence
  - layout
---

# 只读驾驶舱与证据高亮定位

## 任务目标

把现有“编辑器 + 检查器”升级为一眼能看懂状态的章节驾驶舱：左侧章节进度、中央意图与正文、右侧证据；点击 finding 能精确跳到正文原句，审阅时高亮、编辑时不受干扰。

## 界面结构

沿用现有三栏网格（`src/ui/styles.css:41`）：

```text
topbar: 项目 · 模型/窗口徽章 · 预算条 · 运行状态
左栏: 章节列表 + 六阶段状态点（合同→节拍→分段→草稿→检查→定稿）+ 过滤器
中栏: 意图条 → 正文区（编辑/审阅双模式）→ 门禁条 → 状态栏
右栏: 问题 / 证据 / 版本 / 节拍 / 上下文（想法页签由 idea-map-ui 增加）
```

### 左栏

- 每个章节显示 6 个状态点：通过、进行中、阻塞、未开始。
- 过滤器：全部 / 有阻塞 / 生成失败 / 可恢复。
- 复用现有 `renderShell()` 与 `openChapter()`，不重建列表状态机。

### 意图条

- 只读显示合同摘要：目标、障碍、转折、结尾状态、`readerIntent.purpose/payoff/hook`、关键 `mustNotHappen`。
- “编辑合同”复用 `showContractEditor()`（`src/ui/app.js:130`）。
- 折叠后保留一行摘要，避免挤压正文。

### 正文双模式

```html
<div class="editor-wrap">
  <div id="draft-view" class="draft-view hidden"></div>
  <textarea id="draft"></textarea>
</div>
```

- **编辑模式**：沿用现有 textarea、自动保存、选区分级改写。
- **审阅模式**：隐藏 textarea，显示 `#draft-view`，用相同字体/行高/内边距渲染带 `<mark>` 的正文。
- `Ctrl+E` 切换；切换时保留滚动位置。
- 不做 textarea 上覆盖高亮层：自动换行和滚动很难完全对齐，双模式把错位风险降为零。

### 高亮与定位

- 用 `/cockpit` 返回的 `charStart/charEnd/line` 渲染 `<mark data-highlight-id>`；`escapeHtml` 后再切段，防 XSS。
- 点击 mark → 打开右栏证据卡（finding/revision 摘要、引文、来源）。
- 点击右栏 finding → 切到审阅模式、滚动到对应 mark；编辑模式下用 `setSelectionRange(charStart, charEnd)`。
- `matched: false` 时显示“定位失效：正文已改动”，不跳到猜测位置。
- 严重级别用 class 区分：blocking（红）、warning（金）、info（蓝），不只靠颜色，附图标/文字。

### 门禁条与状态栏

- 门禁条 6 个 chip：合同检查、内容检查、提取、审计、审查、定稿；状态 pending/running/passed/blocked/stale。
- 状态栏：字数、估算 token、保存时间、blocking 数、上下文 `used/capacity`。
- 本任务只读：按钮可触发已有路由，但不新增“自动定稿”或绕过检查的入口。

## 前端组织

- `src/ui/app.js` 已约 900 行，新增逻辑拆到 `src/ui/cockpit.js`、`src/ui/evidence.js`，在 `index.html` 以 module 或顺序脚本引入。
- 复用 `api()`、`escapeHtml()`、`toast()`、`showModal()`；不引入前端框架。
- 键盘：`Ctrl+E` 切换审阅；`J/K` 上/下一个 finding；`Esc` 关闭抽屉。
- 现有 `Ctrl+S` 保存、`Ctrl+K` 搜索保持不变。

## 验收

- 打开章节后，左栏进度、意图条、门禁条、右栏问题与正文在同一屏可见，不需要在多个弹窗间跳转。
- 点击任一 finding，正文精确选中对应第 N 次出现；含同一句多次出现时不跳错。
- 审阅模式高亮位置与编辑模式选区一致；切换模式后滚动位置不跳变。
- textarea 编辑、自动保存、选区分级改写行为与改造前一致。
- `matched: false` 的 finding 不被高亮，显示明确提示。
- 长文（9000 字）下滚动与高亮无明显卡顿；mark 渲染不破坏段落空白。
- 现有 UI 手动验收路径（打开/保存/修订/合并/盲评）不回归。

## 非目标

- 不做富文本编辑器、不做 Markdown 预览、不做多人协作。
- 不在审阅模式内直接编辑；编辑仍回 textarea。
- 不在本任务做命令面板、内联 diff、分段重试（下一任务）。
