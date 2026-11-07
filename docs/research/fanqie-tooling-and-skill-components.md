---
id: weave-research-fanqie-tooling-and-skill-components
type: research-notes
title: 番茄优先的外部工具与技能组件调研
status: draft
tags:
  - research
  - fanqie
  - editing-experience
  - trend-snapshots
  - skill-components
date: 2026-11-06
---

# 番茄优先的外部工具与技能组件调研

> 检索日期：2026-11-06。本文是外部项目的功能与适配调研，不是需求、平台规则、Canon 或效果证据。
>
> 核验范围：四个仓库的默认分支 README、LICENSE，以及 Oh Story 指定 skill 的 `SKILL.md`、references 和脚本。未运行外部服务，未验证实时抓取可用性，未审计完整源码，也未独立核实其市场数据、校准语料或统计结论。
>
> 对应任务已沉淀为 GitHub Issues #13–#21，并按 `to-spec` 拆分实施。#14、#16–#20 已关闭，#15 的原生 lint 与外部评估已完成，#21 的隔离适配证明与默认关闭的效果审查接线已完成；#13 的真实模型复跑和人工评分仍待作者参与。

## 一、结论

1. **初期主攻番茄，不等于把番茄经验写死成全局规则。** 应把稳定、可版本化的“平台档案”和有时效的“热点快照”分开；平台节奏、爽点和表达偏好仍是软目标。
2. **优先借鉴机制，不复制产品形态。** Weave 继续保留本地纯文本/Markdown、共享核心服务、候选批准和定稿边界，不引入第二套桌面壳、云账号、多 Agent 框架或独立 Dashboard。
3. **Oh Story 的部分 skill 可以拆成零部件，但不能整包直接接入。** 最适合先评估的是发布档案、只读 lint、热点聚合和软 rubric；`story-setup`、hooks、外部 agents、浏览器控制及正文回写不是普通方法卡，必须单独审查权限。
4. **热点是半自动离线流程，实时抓取后置。** 当前没有网络请求：作者先从榜单导出或粘贴 CSV/Markdown，再执行 `hotspot import`，之后才能做同口径 `compare` 和 `candidates`。这避免让 CDP、登录态或第三方页面稳定性阻塞核心创作实验，但不宣称已经自动获取热点。
5. **快速编辑优先做“划词 → 候选 → diff → 采纳/废弃”。** 幽灵字、连续自动补全和整本自动润色会增加成本与覆盖风险，不作为第一版。
6. **实施顺序以可验证的小步交付为准。** #14、#16–#20 已完成并关闭；#15 的原生 lint 与 #21 的只读评估均已完成，`story-deslop` 现可由 `effect-review --external-deslop-root <dir>` 显式启用。后续优先补 #13 的真实复跑和人工评分，实时热点与通用组件运行器不应成为前置依赖。

## 二、四个项目分别值得参考什么

| 项目 | 官方材料中能确认的能力 | 建议借鉴 | 不应照搬 |
| --- | --- | --- | --- |
| MirrorNovel | 可编辑大纲与三级蓝图；润色、去 AI 味、三阶段编辑引擎；差异检查后回写；本机暂存、冲突提示、章节历史与恢复；可选联网取材。桌面端仍依赖业务后端、MongoDB 和模型服务。[S1] | 修改前保留历史、差异确认、并发冲突保护、按任务分配模型、失败恢复 | Vue/Electron/Express/MongoDB 整套形态、无人值守整本生成、参考原文注入、把管理员网页下载当热点系统 |
| easy-writing | 本地桌面写作；划词润色/扩写/纠错/自定义指令；续写和幽灵字；自动保存、历史版本、查找替换；README 宣称桌面“榜单风向”有 80+ 来源，支持本地趋势、标签、CSV 和 AI 解读，浏览器模式不可用该功能。[S2] | 划词操作、快捷键、采纳/废弃、保存恢复、榜单快照导出、手写与 AI 修改分开统计 | Tauri/TipTap 技术栈、持续幽灵字、音特效等个性化外观、把抓取来源数量当数据质量 |
| webnovel-writer | 默认 `master` 是 v6 Claude Code 插件；写前上下文、写后审查和事实提交；统一最终报告；可信断点恢复；只读 Dashboard；主链与派生投影分离。[S3] | 面向作者的完成/部分完成/待处理报告、重复执行从可信断点恢复、投影健康检查 | Claude Code 宿主依赖、多 Agent 编排、把只读 Dashboard 当快速编辑器；本次未把另一个 v8 分支的能力混入结论 |
| oh-story-claudecode | 14 个 skill 覆盖扫榜、拆文、长短篇、审查、去味、发布和封面；声明式流程搭配 Node/Python 脚本、references、宿主 agents/hooks；MIT。[S4] | 将独立声明式内容、确定性检查、平台参考和输出 schema 拆成候选项 | 直接运行 `story-setup`、宿主 hooks/agents、浏览器登录态、自动改写 Canon/正文或另建一套工作台 |

### 一个容易混淆的点

MirrorNovel 官方材料能支持“联网取材”和受限的管理员番茄书籍参考功能，但本次核对的材料**不能支持“它有完整热点榜单系统”这一结论**。热点榜单的直接参考主要来自 easy-writing 与 Oh Story 的 `story-long-scan`；webnovel-writer 的已核对 README 也未把扫榜或划词快速编辑列为核心能力。[S1][S2][S3][S5]

## 三、Oh Story 技能的组件化判断

### 3.1 `story-long-scan`：适合拆成“热点快照与聚合”，不适合直接变成常驻爬虫

官方流程的输入是平台、频道、新书或成熟大盘及作者条件；输出包括按日期分目录的原始榜单、聚合报告和选题决策。它明确区分平台热度口径，优先从多榜单、多作品的重复模式形成候选，也允许作者提供榜单或退回历史知识。[S5]

番茄参考文件进一步说明：

- 阅读榜、新书榜和书库“最热”是不同样本；公开页面主要提供“在读”等字段，不能据此声称掌握完读率、追读或订阅转化。
- 默认排行榜按题材等额取样，每类前 20 本，因此本数和占比受采样设计影响，不能直接解释为平台题材份额。
- 番茄脚本采集依赖 `/browser-cdp` 和已登录 Chrome；作者提供数据是正式降级路径，不是次等伪功能。[S5]

**Weave 适配建议**：

- 第一版只实现作者提供数据的导入、标准化、聚合和快照对比。
- 每条快照保存来源、时间、平台、榜单、频道、筛选、热度口径、采样限制和数据质量。
- 趋势只比较同平台、同榜单、同口径的数据；热点只生成 reference 身份的选题候选，作者批准后才进入规划。
- 实时连接器和 CDP 权限另审，不绕过登录、付费、验证或访问限制。

### 3.2 `story-publish`：较适合成为独立的平台发布档案候选

该 skill 只读作品材料，输出 `发布资料-<平台>.md`，逐字段区分“已确认、建议、待确认、待平台核实”，不登录后台、不自动发布，也有格式检查脚本。[S7]

其番茄参考具有明确的核验日期和范围：元信息为 2026-10-29，长篇标签、短故事、书名与简介分别来自不同日期和页面。文件还明确列出 App、其他账号等级、实际提交结果及简介下限等未核实事项。[S7]

**Weave 适配建议**：

- 复用“字段状态 + 来源与核验日期 + 当前后台优先”的治理方式。
- 只从已批准故事材料生成候选；缺失值留空，不为了填满表单编故事。
- 平台档案更新不得静默改变已确认书名、简介或标签，也不反向改写 Canon。
- 具体字数、标签和账号规则只能保存在带日期的平台档案中，不能固化为永久真理。

### 3.3 `story-deslop`：脚本可评估为 lint，原严重度不能直接继承

`check-ai-patterns.js` 是本地 Node 脚本，支持 `--check`、`--json`、`--fail-on=blocking|all`，只读正文并报告位置、类别和摘录；它依赖同目录 `style-whitelist.js` 和书内 `.deslop-whitelist`，规则主要写在脚本内，并非一个完全独立、配置外置的单文件模块。[S6]

它的 `SKILL.md` 已区分确定性预检、语境判断、作者授权改稿和长篇剧情修改，但当前 Weave 的约束更严格：阅读效果默认 warning/info，不能因为上游把某种句式标为 blocking 就直接阻断定稿。[S6]

**Weave 适配建议**：

- 先提取少量规则与正反例，映射为可配置、可禁用的效果 finding。
- 通用词和修辞主要看密度；保留对话、系统文本、题材和作者白名单的语境差异。
- 不复制“必须清零”的工作流，不自动改稿，不用命中数或所谓 AI 检测分数评价质量。
- 源码注释包含真人语料校准声明，但本次未核验其语料和统计，因此误报率必须在 Weave 自己的书稿与盲评流程中重新验证。

### 3.4 `story-review`：借鉴软 rubric，不引入多 Agent 审查框架

该 skill 的 full/lean 模式依赖多个宿主 agents，solo 可降级。其番茄 rubric 是叠加在通用审查上的参考层，强调开局、翻页动力、题材匹配、手机阅读与情绪反馈；原文明确这些只作参考、需要原文证据，完读率必须靠实际数据验证。[S8]

**Weave 适配建议**：只把有证据的维度和“平台档案叠加通用审查”的方式转成软配置，不照搬 agents、S1–S4 阻断体系或节奏数字。其中的密度参考不是番茄算法，也不能变成 Weave 配额。

### 3.5 `story` / Dashboard：只参考交互，不再建工作台

`story` 负责自然语言路由，`dashboard-server.mjs` 提供本地文件浏览、文本编辑、冲突保护保存和确认删除，默认只监听 `127.0.0.1`。[S9]

Weave 已有本地 UI、自动保存、hash 冲突保护、修订候选和搜索，因此只需要对照补交互缺口，例如划词工具、快捷键和候选采纳，不应再引入第二个文件服务器或项目格式。

### 3.6 首版不作为普通组件接入的内容

- `story-setup`、宿主 hooks、外部 agents 和自动部署；
- `browser-cdp`、登录态复用和实时网页控制；
- `story-long-write` 的目录结构、追踪底账与正文回写状态机；
- `story-cover` 的生图工具和外部 API；
- 任何会绕过 Weave 材料准入、POV、批准、账本或定稿流程的脚本。

这些能力并非永远不能做，而是需要独立的权限、安全和架构决策，不能伪装成一张方法卡。

## 四、建议的数据与权限边界

### 4.1 平台档案与热点快照分开

**平台档案**相对稳定，至少应有：平台、版本、来源、核验日期、适用范围、软审查维度、发布字段及人工核实项。

**热点快照**是外部 reference，至少应有：抓取或导入时间、来源、榜单与筛选、指标口径、采样限制、原始条目、缺失与解析异常。快照不会自动修改 `StoryPromise`、卷弧、合同或账本。

### 4.2 快速编辑复用修订候选

划词操作的最小输入应是：章节、选区、`baseDraftHash`、操作类型和可选自定义指令；最小输出是独立修订候选。作者看到 diff 后选择采纳或废弃，采纳仍只写回草稿，过期 hash 必须冲突失败。

润色、扩写、纠错和自定义指令都不得借“快速”绕过 POV、合同硬节点、材料出处、其他段落保护或定稿门禁。

### 4.3 外部组件先声明权限，再考虑通用注册表

候选组件至少需要记录：

- 组件类型：方法卡、lint、平台档案、prompt 或工作流；
- 上游仓库、commit、许可证和内容哈希；
- 输入输出 schema；
- 文件读写、网络、模型、浏览器和子进程权限；
- `draft / approved / disabled` 状态及来源证据。

**不要先造通用 Skill 执行平台。** 先为一个只读组件完成隔离适配证明；出现多个真实同类组件后，再抽象注册表和统一调用器。

## 五、任务沉淀与后续顺序

| Issue | 任务 | 当前状态 |
| --- | --- | --- |
| [#13](https://github.com/Xkrasa/-Weave/issues/13) | 番茄优先的真实书稿基线与盲评 | 离线基线已交付；真实复跑、人工评分和效果报告待作者参与 |
| [#14](https://github.com/Xkrasa/-Weave/issues/14) | 可选 `readerIntent` | 已关闭：合同、章纲、双渲染器、审查和消融已接入 |
| [#15](https://github.com/Xkrasa/-Weave/issues/15) | 可配置表达模板 lint | 原生规则已完成；#21 外部只读评估已完成 |
| [#16](https://github.com/Xkrasa/-Weave/issues/16) | `ReaderPromise/Payoff` | 已关闭：批准、定稿证据、候选确认和回改失效已接入 |
| [#17](https://github.com/Xkrasa/-Weave/issues/17) | `beat-first` 实验 | 已关闭：默认关闭，节拍辅助单遍生成和 benchmark 已接入 |
| [#18](https://github.com/Xkrasa/-Weave/issues/18) | 方法卡与场景化样本 | 已关闭：候选批准、场景样本和 scene/legacy/off 消融已接入 |
| [#19](https://github.com/Xkrasa/-Weave/issues/19) | 番茄平台档案、热点快照与发布资料 | 已关闭：全部离线；实时抓取仍未纳入范围 |
| [#20](https://github.com/Xkrasa/-Weave/issues/20) | 划词快速编辑 | 已关闭：选区候选、diff、采纳/废弃和冲突保护已接入 |
| [#21](https://github.com/Xkrasa/-Weave/issues/21) | 外部 skills 组件化适配 spike | 已完成：固定 commit、MIT、只读 JSON 和来源哈希验证；`story-deslop` 已接入 `effect-review`，默认关闭 |

剩余工作优先补 #13 的真实复跑和人工评分，不把 fake 输出、规则命中数或模型自评分当成效果证据。

## 六、#21 隔离适配证明与消费边界

本次证明固定使用 Oh Story commit `aa0f874362504c715b8efaec7938df87e70a4742`，保留 MIT 许可与出处。两个实际脚本及其依赖文件被保存为带 `UPSTREAM.md` 来源哈希的离线夹具，默认测试不需要网络，也不需要检出外部仓库。

证明覆盖：

- 上游 CommonJS 脚本在独立 `package.json` 隔离中运行，避免继承 Weave 的 ESM 类型；启动失败与上游 blocking 的正常 JSON 退出被区分处理。
- 固定中文正文产生可解析 JSON，位置、类型、摘录和 `mechanical/semantic` 分类可以回指原文；上游 blocking 仅映射为 warning，advisory 仅映射为 info。
- 输入文件执行前后哈希不变；禁用后无 finding；篡改任一上游文件哈希会明确失败；原生表达 lint 配置和正文生成路径不受影响。
- `story-deslop` 选择**原生重写优先**：Weave 的可配置规则、作用域、豁免和 warning/info 是主路径，外部脚本只作为只读参考适配，不继承 blocking 或自动改稿。
- `story-publish` 选择**仅借鉴声明式内容**：保留字段状态、核验日期和人工后台核实，不直接引入 Python 运行时。
- `story-long-scan` 选择**原生重写离线聚合**：CDP、登录态和实时抓取后置单独评审。
- `story-review` 选择**仅借鉴声明式软 rubric**：不引入宿主多 Agent 或 S1/S2 阻断体系。

这套实现仍不是通用 Skill 注册表或执行平台。当前唯一可执行消费方是 `weave effect-review <chapter> --external-deslop-root <dir>`：未传参数时完全不运行组件；传入后校验草稿与输入一致、执行前后哈希不变，把外部结果映射为独立 warning/info finding。组件缺失、哈希不符或执行失败会明确失败，无法定位的上游摘录只保留软建议、不伪造字节证据。是否继续复用其他组件必须由具体任务的直接收益决定。

## 七、许可证与内容边界

- MirrorNovel：仓库声明 **AGPL-3.0-only**。[S1]
- easy-writing：仓库声明 **AGPL-3.0**。[S2]
- webnovel-writer：仓库声明 **GPL-3.0**。[S3]
- oh-story-claudecode：仓库声明 **MIT**。[S4]

本调研未复制 MirrorNovel、easy-writing 或 webnovel-writer 的 AGPL/GPL 代码。Oh Story 的两个 MIT 脚本及其许可证已作为隔离测试夹具保留，来源、commit 和内容哈希均可复核。后续若继续复制或改写代码、规则文本、标签库或测试语料，必须按具体文件和上游许可证保留通知并评估义务；不能因为 Oh Story 是 MIT，就忽略其第三方素材、平台数据或参考作品的独立权利边界。

外部热点、榜单、拆书和平台说明始终是 reference。未经作者确认，不升级为 Canon、作者偏好或故事事实；未经合规与权限评审，不接入实时抓取、登录态、浏览器控制或任意命令执行。

## 来源清单

- **[S1]** MirrorNovel，官方 [`README.md`](https://github.com/Aerdelan/MirrorNovel/blob/2a7978121f11698ed66b9b88a808af1ce2d01ab9/README.md) 与 [`LICENSE`](https://github.com/Aerdelan/MirrorNovel/blob/2a7978121f11698ed66b9b88a808af1ce2d01ab9/LICENSE)，固定 commit `2a7978121f11698ed66b9b88a808af1ce2d01ab9`。主要核对“功能详解”“许可说明”“已知限制”。
- **[S2]** easy-writing，官方 [`README.md`](https://github.com/yilujian/easy-writing/blob/75b5b1f3704fa9ff8df42557b9bf7ec348b9135c/README.md) 与 [`LICENSE`](https://github.com/yilujian/easy-writing/blob/75b5b1f3704fa9ff8df42557b9bf7ec348b9135c/LICENSE)，固定 commit `75b5b1f3704fa9ff8df42557b9bf7ec348b9135c`。榜单来源数量是 README 宣称，本次未逐项验证。
- **[S3]** webnovel-writer，默认 `master` 的官方 [`README.md`](https://github.com/lingfengQAQ/webnovel-writer/blob/b38056ec3ae288af613c0af162d648e4a4e8825c/README.md) 与 [`LICENSE`](https://github.com/lingfengQAQ/webnovel-writer/blob/b38056ec3ae288af613c0af162d648e4a4e8825c/LICENSE)，固定 commit `b38056ec3ae288af613c0af162d648e4a4e8825c`。该分支自述为 v6。
- **[S4]** Oh Story，官方 [`README.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/README.md) 与 [`LICENSE`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/LICENSE)，固定 commit `aa0f874362504c715b8efaec7938df87e70a4742`。
- **[S5]** `story-long-scan` 的 [`SKILL.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-long-scan/SKILL.md) 与 [`references/platform-fanqie.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-long-scan/references/platform-fanqie.md)。
- **[S6]** `story-deslop` 的 [`SKILL.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-deslop/SKILL.md) 与 [`scripts/check-ai-patterns.js`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-deslop/scripts/check-ai-patterns.js)。脚本校准声明未独立复核。
- **[S7]** `story-publish` 的 [`SKILL.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-publish/SKILL.md) 与 [`references/fanqie.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-publish/references/fanqie.md)。平台信息核验日期和有限适用范围以该参考文件为准。
- **[S8]** `story-review` 的 [`SKILL.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-review/SKILL.md) 与 [`references/rubrics/fanqie.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story-review/references/rubrics/fanqie.md)。
- **[S9]** `story` 的 [`SKILL.md`](https://github.com/zenstory-ai/oh-story-claudecode/blob/aa0f874362504c715b8efaec7938df87e70a4742/skills/story/SKILL.md)，主要核对路由与 Dashboard 工作区、编辑和监听边界。
