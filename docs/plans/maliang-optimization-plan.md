---
id: weave-maliang-optimization-plan
type: optimization-plan
title: 马良写作借鉴点优化方案
status: delivered
tags:
  - context-engineering
  - trust-core
  - plan
date: 2026-11-07
---

# 马良写作借鉴点优化方案

> **状态（2026-11-07）**：批 0–3 已全部交付，批 4（章尾画像）按裁决保持 deferred。各项拆分为独立 task-spec 并落地：
> 批 0 → `extraction-grounding-rules` / `assembled-context-report`；批 1 → `volume-progressive-disclosure` / `quantity-ledger-balances`；批 2 → `context-degradation-tiers` / `extraction-pending-adjudication`；批 3 → `style-range-derivation` / `context-assembly-preview`；补充缺口 → `ledger-chapter-renumber-resilience`（已验证无需修复）。批 4 → `chapter-ending-profile`、后续可选 → `context-assembly-profiles`，均留在 docs/specs/tasks/ 带「启动条件」。
> **勘误**：批 0 的报告字段定型落点是 `src/core/context.ts`（`AssembledContext` 定义处），不是本文初稿所写的 `stage-types.ts`。
>
> **输入**：`docs/research/maliangwriter-competitive-analysis.md`（事实篇，主要取 §4.2 抽取规矩与 §4.3 装配表）、`docs/research/borrowable-designs-from-maliangwriter.md`（决策篇，7 个借鉴点含落点/风险/验收）。
>
> **约束**：`goal-and-requirements.md` 三条硬约束（作者权威、安全信息不静默丢失、硬约束与软目标分离）+ `docs/specs/effect-first/SPEC.md` 不可削弱内核。
>
> **地位**：批次编排与验收口径以各 task-spec 为准，本文保留裁决记录。

## 一、采纳总览

| # | 项 | 来源 | 裁决 | 批次 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| 0a | 抽取四条硬规矩（prompt 层） | 事实篇 §4.2 | **采纳，立即做** | 批 0 | 无 |
| 0b | 装配报告三分类字段（withheld/degraded/omitted） | 决策篇「共同约束」 | 采纳（先定型结构） | 批 0 | 无 |
| 1 | 设定按卷渐进披露 | 决策篇 §1 | 采纳 | 批 1 | 0b |
| 2 | 数值总账（变化→结余） | 决策篇 §2 | 采纳 | 批 1 | schema 迁移 |
| 3 | 「仅名称/精简」降级档 | 决策篇 §3 | 采纳 | 批 2 | 0b |
| 4 | 抽取冲突进「待裁决」 | 决策篇 §4 | 采纳 | 批 2 | 无 |
| 5 | 文风区间从定稿反推 | 决策篇 §5 | 采纳 | 批 3 | 无 |
| 6 | 「本章装配可见」预览 | 决策篇 §6 | 采纳 | 批 3 | 0b |
| 7 | 章尾类型按题材建议 | 决策篇 §7 | **待验证**（观察型，不做生成约束） | 批 4 | 需拆书样本 |
| — | 多 Agent / 积分制 / 原文注入 / 静默压缩 / 过检测承诺 / 仿写四入口 | 决策篇「不借鉴」 | **否决**（理由见 §五） | — | — |

顺序依据决策篇自己的优先级表：收益高且无依赖的先做；1/3/6 都改 `AssembledContext` 报告字段，故 0b 先把三分类一次定好，避免三次改同一处结构。

## 二、批次详情

### 批 0：抽取规矩 + 报告结构定型（零依赖，先做）

**改动**：

1. `src/core/extraction.ts`（SYSTEM_PROMPT，L17 起）与 `src/core/audit.ts`（`AUDIT_SYSTEM_PROMPT`）追加四条规矩的 prompt 表述：
   - 正文没写的不补、不猜；
   - 推不出来的数不编，宁缺不凑；
   - 与既有账本/设定冲突时引用双方原句，不擅自裁决；
   - 每条记录的证据引文必须能在正文逐字定位。
2. `src/core/stage-types.ts`：`AssembledContext` 报告三分类定型——`included` / `omitted`（预算不足丢弃）/ `withheld`（披露未到，`reason: 'not-yet-revealed'`）+ 预留 `degraded`（降级档，批 2 启用）。字段结构一次定好，批 1/2/3 只填值。

**验收**：构造「正文未写某事实」的样章，抽取不产出该记录；引文不匹配的证据进 `rejected`。现有测试全绿。

**明确不做**：批 0 不引入 pending 队列机制（那是批 2 的 §4），只改 prompt 与字段。

### 批 1：按卷渐进披露 + 数值总账（收益最高）

**1a 设定披露**（决策篇 §1 落点不变）：

- `canon/reveals.json`：`{ "canon:world.md": 1, "canon:characters:陆沉": 12 }`，键复用 `sourceId`；
- `src/core/materials.ts` `collectMaterials()` 在 push canon/角色材料前按 `contract.chapter` 过滤，未到期项进 `withheld`；
- 披露判断是材料收集阶段的事实，`assembleContext` 不参与；
- `weave status` 与写作输出显式列出「本章未开放条目」，支持 `--show-withheld` 预览。

**1b 数值总账**（决策篇 §2 落点不变）：

- `src/core/types.ts`：`LedgerFact` 增 `quantity?: { delta: number; balance: number; unit: string }`（整数最小单位）；
- `src/core/extraction.ts`：数值变化必须同时给 delta 与 balance，基线不明只报 delta 并标 `unverified`；
- `src/core/story-ledger.ts`：`checkBalances(root, throughChapter)` 按 `subject + predicate + unit` 校验 `prevBalance + delta === balance`；
- `src/core/audit.ts`：finding 维度 `quantity-break`，输出三值（上章结余/本章变化/本章结余）+ 证据引文。

**共同验收**：决策篇 §1/§2 的验收原文（第 10 章开放 world.md → 第 5 章 prompt 无其正文；三章测试第二章错 5 → 必出 `quantity-break`）。

**约束**：数值 finding 不阻断定稿（属事实但不属合同硬节点），交作者裁决；`withheld` 不得被 sanitize/预算逻辑当作 budget 省略。schema 变更走 `src/core/migrate.ts`。

### 批 2：降级档 + 待裁决队列

- **降级档**（决策篇 §3）：`Material.compact?`；预算不足时 non-required 先降级后丢弃；`AssembledContext.degraded` 必须出现在报告里（否则即静默压缩）；required 默认不降级，`capacity-conflict` 显式失败语义不变。
- **待裁决**（决策篇 §4）：`ExtractionReport.pending[]`（`raw/conflictWith/quote/reason`）；三类分流——结构非法与证据无效仍进 `rejected`，**与账本/合同冲突**进 `pending`；裁决入口复用 `waivers.ts` 写法，落 decisions 并可重放投影；`weave audit` 顶部聚合展示。

**验收**：决策篇 §3/§4 原文（压预算出 `degraded`；「正文写已死、账本存活」产出 `pending` 而非丢弃，裁决后 rebuild 一致）。

### 批 3：文风反推 + 装配预览（低成本，随时可插队）

- **文风反推**（决策篇 §5）：`src/core/style.ts` 增 `deriveStyleRange(samples)`，复用 `methods.ts` 统计，取 P25–P75 分位数；增 `dashRatio`/`questionMarkRatio` 标点维度；建议值写 `.weave/style-candidate.json`，`weave style adopt` 后才写 `canon/style.json`。
- **装配预览**（决策篇 §6）：`ui-server.ts` 增只读 `/api/context/preview?chapter=N`，与 `write` 走同一函数同一参数，显示 `contextHash` 供比对；CLI 侧 `weave context --chapter N`（若可复用现成命令则不加）。

**验收**：决策篇 §5/§6 原文（adopt 前 canon 不变；预览 contextHash 与 run 记录一致）。

### 批 4：章尾画像（待验证，观察型）

`deconstruct.ts` 增章尾分类统计（悬念揭示/关系反转/目标受阻/情绪落地/信息差），按题材聚合，**只出观察报告**：不进生成约束、不进 review 门禁、不影响定稿判定。积累足够拆书样本后再评估是否升级为方法卡素材。决策篇 §7 的风险成立（题材标签与样本偏差），故本批默认搁置，仅在前六项全部交付且 bench 有余力时启动。

## 三、共同技术约束（每批都适用）

1. **withheld/degraded 不是 budget 省略**：任何被排除或降级的材料必须显式出现在装配报告里，原因可读——对应「安全信息不可静默丢失」。
2. **required 不降级、unknown provenance 仍阻断**、`split-required`/`capacity-conflict` 显式失败语义不变。
3. **AI 推导值（文风区间、章尾画像）不得自动标 `author`**，作者确认前不写 canon——对应「作者权威不可越权」。
4. **一次一批、一批一个变量**：批前记录 `bench/BASELINE.md` 基线，批后用 `scripts/benchmark.ts` 对比；不与无关改动混合（SPEC 效果实验契约）。
5. 批 1 的披露需要长篇种子验证（现有 `bench/seeds/long-sect`、`long-harbor` 可复用）；数值总账用三章专用测试构造，不加新 seed。
6. 所有 finding（quantity-break、降级、待裁决）默认 warning/info，不阻断定稿。

## 四、验证方式

- 每批开工前开一条 issue（锚定本方案对应批次）；按项目规则，交付后结论收割进 `docs/adr/`（尚未建立时先随代码注释落位）与相关模块注释，然后关闭并清理 issue 记录，不留过期 spec。
- 批 0/2 属可信性改动，走测试验收为主；批 1/3 涉及生成行为，加盲评对比（`blind-eval`）小样本留痕。
- 全部批次完成后，本文 `status` 改为 `delivered` 并在顶部注明各批去向；若届时已建 `docs/adr/`，则收割进 ADR 后按规则处置本文。

## 五、拒绝清单（维持决策篇裁决，不再重议）

| 项 | 理由（摘要） |
| --- | --- |
| 7+1 多 Agent 编排 | 阶段 + commit 账本已实现同等分工且可审计；协调 Agent 削弱作者权威与可解释性 |
| 积分制、订阅绑定导入 | 与本地优先、无模型也能写作相悖 |
| 参考作品原文注入上下文 | `goal-and-requirements.md` 非目标 |
| 超限自动静默压缩 | `capacity-conflict` 显式失败更安全 |
| 「过 AI 检测」承诺 | 对方自己不承诺；Weave 不做此类声明 |
| 仿写四入口 | 拆书 + 方法卡边界更严，不注入原文 |
