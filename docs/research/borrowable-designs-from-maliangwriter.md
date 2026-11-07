---
id: weave-research-borrowable-designs-from-maliangwriter
type: research-notes
title: 从马良写作可借鉴的设计清单（含 Weave 落点与验收）
status: draft
tags:
  - research
  - context-engineering
  - story-archives
  - design-candidates
date: 2026-11-06
---

# 从马良写作可借鉴的设计清单

> **状态（2026-11-07）**：7 个借鉴点的采纳裁决与批次编排见 `docs/plans/maliang-optimization-plan.md`；本文保留各条目的论证、风险与验收细节，实施时按方案的批次引用对应小节。
>
> 检索日期：2026-11-06。事实与证据来源见 `maliangwriter-competitive-analysis.md`（同目录），本文只做**取舍与落点**，不重复论证。
>
> 本文不是需求、不是规范。每一条都标注了成本、风险与验收方式；采纳前应先用 `bench/` 做对比，不应直接改默认行为。

## 取舍原则

只借鉴**机制**，不借鉴**产品形态**。判断标准是三条：

1. 是否补上 Weave 现有的能力空洞（而不是复制已有能力）；
2. 是否与既有硬约束相容——特别是「作者权威不可越权」「安全信息不可静默丢失」「硬约束与软目标分离」；
3. 是否能用可读文件 + 现有阶段机制实现，不引入新的运行时依赖。

据此，多 Agent 编排、积分制、参考原文注入、超限静默压缩一律不取（理由见分析笔记第七节）。

## 1. 设定按卷渐进披露（最高优先）

**对方做法**〔原文明确〕：设定可隐藏，按卷逐步开放给 AI；未到卷的设定不进上下文。

**为什么成立**：长篇的设定集是「作者知道的全集」，而模型每章只应知道「读者已读到的部分」。全量注入有两个坏处——白烧 token，且模型提前知道未揭晓的信息，容易在叙述里透支后续剧情（提前给出答案、让角色说出不该知道的话）。

**Weave 现状**：`src/core/materials.ts:34-41` 把 `premise.md` / `world.md` / `style.md` / `prohibitions.md` 一律作为 `required`、`provenance: 'author'` 的材料注入，每章全量，无披露控制。

**落点**：
- `canon/reveals.json`（新文件）：`{ "canon:world.md": 1, "canon:characters:陆沉": 12 }`，键复用现有 `sourceId` 命名，不改造 Markdown 格式。
- `src/core/materials.ts`：`collectMaterials()` 在 push canon 与角色材料前按 `contract.chapter` 过滤；未到期的项**不进 `materials`**，另存一份 `withheld` 列表返回。
- `src/core/context.ts` 的 `assembleContext` 不参与判断——披露是材料收集阶段的事实，不是预算裁剪。
- 装配报告 `included/omitted` 之外新增 `withheld`，reason 用 `not-yet-revealed`。

**必须遵守**：`sanitize`/预算逻辑不能把 withheld 当作 `budget` 省略处理，否则等于静默丢信息。`weave status` 与写作输出要显式列出「本章未开放条目」，让作者能发现误标。

**风险**：作者标错披露时点 → 模型缺信息却照写。缓解是显式清单 + 允许 `--show-withheld` 预览。

**验收**：同一本书设 `world.md` 在第 10 章开放，写第 5 章时装配报告出现 `withheld: canon:world.md`，且 prompt 中不含该文件正文；第 10 章起正常注入。

## 2. 数值总账：变化 → 结余（高优先）

**对方做法**〔原文明确〕：灵石、银两、库存按「变化 → 结余」逐章累计，必须对得上；对不上进「待确认」，**不凑数**。

**为什么成立**：数值是最容易被读者抓错、也最容易被模型随手改坏的一类事实。字符串形式的事实只能记录「谁持有什么」，无法发现「从 100 变 30 却只花了 20」。

**Weave 现状**：`src/core/types.ts:203` 的 `LedgerFact` 只有 `subject/predicate/object`，`possession` 是字符串，没有数量与结余语义。

**落点**：
- `src/core/types.ts`：`LedgerFact` 增可选 `quantity?: { delta: number; balance: number; unit: string }`，整数最小单位（不用浮点）。
- `src/core/extraction.ts`：系统提示要求数值类变化必须同时给出 delta 与 balance，且**基线不明时只报 delta 并标 `unverified`**，禁止反推。
- `src/core/story-ledger.ts`：新增 `checkBalances(root, throughChapter)`，按 `subject + predicate + unit` 汇总，校验 `prevBalance + delta === balance`。
- `src/core/audit.ts`：新增 finding 维度 `quantity-break`，输出三值：上章结余、本章变化、本章结余，附证据引文。

**必须遵守**：不阻断定稿（数值属事实但不属合同硬节点），进 findings 供作者裁决；无法校验时记 `unverified` 而不是默认通过。

**风险**：同一物品多种单位、跨章易主会让归并键出错；需允许 `subject` 用稳定 id 而非别名。

**验收**：构造三章测试，第二章结余故意错 5，`weave audit` 必须出 `quantity-break`；正确数据不出 finding。

## 3. 「仅名称 / 精简」降级档（中高优先）

**对方做法**〔原文明确〕：设定、角色、悬念各自可设「完整 / 仅名称」，官方明说这是省 token 的大头；总开关关掉则整体退化为「只给名称和摘要」。

**为什么成立**：Weave 现在是「全量或丢弃」两态。丢弃会让模型不知道某个角色存在（进而写出错位），而只给名字几乎不占预算却能保住「存在性」。这是**用极低成本买一层安全**。

**Weave 现状**：`src/core/context.ts:56-70` 按 `relevance → priority` 排序后塞预算，塞不下就 `omitted`，没有中间形态。

**落点**：
- `src/core/types.ts`：`Material` 增 `compact?: string`（角色卡 → 「姓名 + 一句话身份」；设定 → 「名称 + 类型」）。
- `src/core/context.ts`：预算不足时对 **non-required** 材料先降级为 `compact`，仍不足才 `omitted`；`AssembledContext` 新增 `degraded: Array<{ sourceId, reason: 'budget' }>`。
- `src/core/materials.ts`：为角色、设定、伏笔生成 compact 形态（这几类已有结构化字段，成本低）。

**必须遵守**：`required` 默认不降级；`unknown provenance` 仍直接阻断；`split-required` / `capacity-conflict` 的显式失败语义不变——降级只能发生在可选材料上，且**必须出现在报告里**，否则就是静默压缩。

**风险**：降级后模型误以为该角色只有名字而没有状态，可能写得更保守。缓解：compact 文案明确写「（本章未展开）」或由作者逐项允许降级。

**验收**：把预算压到只够 required，装配报告出现 `degraded` 列表，prompt 保留角色名但无完整卡；提高预算后恢复完整。

## 4. 抽取冲突进「待裁决」而非直接丢弃（中优先）

**对方做法**〔原文明确〕：正文与既有设定矛盾时列出原句，由作者决定以哪边为准，不擅自改正文；推不出来的数进「待确认」。

**为什么成立**：模型抽错有两种。**格式非法**该丢；**与账本冲突**则是「可能正文写错了，也可能账本旧了」——这是只有作者能裁决的事。直接拒绝等于把信息静默扔掉，与「安全信息不可静默丢失」相悖；直接采纳又会让错账污染主线。

**Weave 现状**：`src/core/extraction.ts:266-528` 只有 `records / rejected` 两类，证据不合法的记录整条进 `rejected`，`passed = rejected.length === 0`。UI 只暴露 findings 的 waiver/ignore（`src/core/waivers.ts`）。

**落点**：
- `src/core/stage-types.ts`：`ExtractionReport` 增 `pending: PendingRecord[]`，字段含 `raw`、`conflictWith`（既有 factId/loopId）、`quote`、`reason`。
- `src/core/extraction.ts`：三类分流——结构非法 → `rejected`；证据无效 → `rejected`；**与账本/合同冲突** → `pending`（不阻断 `passed`，但计入待办）。
- 裁决入口复用 `waivers.ts` 的写法，落 `decisions` 记录并重放投影，保持「派生可重建」。
- `src/core/ui-server.ts` 暴露待裁决队列。

**风险**：队列会积压，变成新的负担。缓解：只对「冲突」类进队列，且默认在 `weave audit` 顶部聚合展示；超过阈值时提示批量处理。

**验收**：构造「正文写角色已死、账本记录存活」的章节，抽取产出 `pending` 而非 `rejected`；裁决后 `rebuild` 结果与手工修正一致。

## 5. 文风区间从本人定稿反推（中优先）

**对方做法**〔原文明确〕：不是让模型「感受风格」，而是量出句长、段落长度、对话占比、标点频率，给数值区间。

**为什么成立**：`canon/style.json` 的手填区间是作者**以为**的自己，与他**实际**写的常有偏差；手填还有冷启动成本。

**Weave 现状**：`src/core/style.ts` 只读取 `style.json`（默认 8–40 字、对话占比 0.05–0.65）；`src/core/methods.ts:187-257` 已有 `sentences / averageSentenceLength / dialogueRatio` 统计并对照区间，但**没有从定稿反推区间**，也没有标点维度。

**落点**：
- `src/core/style.ts`：新增 `deriveStyleRange(samples)`，复用 `methods.ts` 的统计，取分位数（如 P25–P75）而非均值，输出**建议值**。
- 增加 `dashRatio`、`questionMarkRatio` 等标点频率字段——破折号过量是对方点名的 AI 味特征，也是 `content-check` 类正则管不到的量。
- 建议值写入 `.weave/style-candidate.json`，由作者 `weave style adopt` 才写 `canon/style.json`。

**必须遵守**：AI 推导值不得自动标 `author`；`canon/style.json` 只有作者确认后才变。

**风险**：近期章节若本身偏离风格（比如刻意写战斗章），分位数会把异常当常态。缓解：只用作者标记为「代表章」的样本，或显示推导来源章节。

**验收**：同一批样本重复推导结果稳定；adopt 前 `canon/style.json` 不变；adopt 后 `methods.ts` 的区间校验按新值生效。

## 6. 「本章装配可见」预览（中优先，偏可解释性）

**对方做法**〔原文明确〕：写作页上下文面板实时显示预计 token、各维度条目数（设定 22 / 角色 16）、实际带入的章纲卷纲徽标，并对照平台上限与模型窗口两条线。

**为什么成立**：与「运行记录能解释一次生成使用了哪些材料、模型、参数和策略」直接对应。作者在点发送前就能看出「这次没带卷纲，难怪跑偏」。

**Weave 现状**：`AssembledContext` 已含 `included / omitted / estimatedTokens`，但只在生成后落盘，写作前不可见；UI 无预览入口。

**落点**：
- `src/core/ui-server.ts` 增只读接口 `/api/context/preview?chapter=N`，复用 `collectMaterials` + `assembleContext`，不改生成路径。
- `src/ui/app.js` 在写作区显示 token 条、材料分组计数与 omitted/withheld/degraded 三类清单。
- CLI 侧加 `weave context --chapter N`（若能复用现成命令则不加）。

**风险**：预览与实际发送不一致会误导。必须保证预览与 `write` 走**同一函数同一参数**，并把 `contextHash` 一起显示以便比对。

**验收**：预览显示的 `contextHash` 与实际写入 run 记录的一致。

## 7. 章尾类型的按题材建议（低优先，实验性）

**对方做法**〔原文明确〕：章尾诊断识别「没用的收尾」，结合热门作品章尾统计，**按题材**建议更合适的章尾类型，而不是一律删升华。

**为什么成立**：Weave 的 `endingStrategy` 是一句自由文本（默认「以具体动作或未解问题收束，不用总结句」），对不同题材其实是不同答案——悬疑要留钩子，日常流要收在关系变化上。

**Weave 现状**：`src/core/style.ts:12` 单字段；`src/core/deconstruct.ts` 已有拆书统计，但未产出章尾画像。

**落点**：`deconstruct.ts` 增章尾分类（悬念揭示 / 关系反转 / 目标受阻 / 情绪落地 / 信息差），按题材聚合为方法卡；`review` 只作建议，不阻断。

**必须遵守**：不得成为统一配额或硬门禁（`goal-and-requirements.md` 非目标第 3 条）。

**风险**：题材标签与样本偏差，容易把「别人的节奏」当规范。先做观察型报告，不做生成期约束。

**验收**：对同一章输出建议类型 + 参考依据，且不影响定稿判定。

## 优先级与依赖

| # | 借鉴点 | 收益 | 成本 | 依赖 | 建议顺序 |
| --- | --- | --- | --- | --- | --- |
| 1 | 按卷渐进披露 | 高（省钱 + 防剧透） | 低 | 无 | 先做 |
| 2 | 数值总账 | 高（补事实空洞） | 中 | 1 无关；需 schema 变更 | 先做 |
| 3 | 仅名称降级 | 中高（保存在性） | 中 | 依赖 1 的报告字段 | 次之 |
| 4 | 待裁决队列 | 中（防信息静默丢失） | 中高 | 需 UI/CLI 裁决入口 | 次之 |
| 5 | 文风反推 | 中 | 低 | 复用 `methods.ts` | 随时 |
| 6 | 装配预览 | 中（可解释性） | 低 | 复用 `assembleContext` | 随时 |
| 7 | 章尾画像 | 低 | 中 | 需拆书样本 | 后置 |

**共同约束**：1、3、6 都会改动 `AssembledContext` 的报告字段，建议一次性把 `withheld / degraded / omitted` 三分类定好再加功能，避免三次改同一处结构。

## 不借鉴与理由（摘要，完整论证见分析笔记第七节）

| 项 | 理由 |
| --- | --- |
| 7+1 多 Agent 编排 | Weave 用阶段（writing/extraction/review/planning）+ commit 账本已实现同等分工，且可审计；引入协调 Agent 会削弱「作者权威不可越权」与单次生成可解释性 |
| 积分制、订阅绑定导入 | 与本地优先、无模型也能写作的定位相悖 |
| 参考作品原文段落注入上下文 | `goal-and-requirements.md` 已列为非目标 |
| 超限自动静默压缩 | 对方文档自承「超出部分自动压缩、AI 可能看不全」；Weave 现有 `capacity-conflict` 显式失败更安全 |
| 「过 AI 检测」承诺 | 对方自己也不承诺；Weave 不做此类声明 |
| 仿写四入口（设定/大纲/正文/架构） | Weave 的拆书 + 方法卡边界更严，已覆盖且不注入原文 |
