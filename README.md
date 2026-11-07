# Weave

Weave 是本地优先的长篇中文网文创作工作台。正文、设定、规划、审查证据和提交历史保存在可读文件中；模型服务可替换，作者保留定稿权。

## 当前状态

- 已接入合同与章纲、正文起草、可信审查、独立阅读效果审查、局部修订、长篇记忆、检索、方法卡、作者偏好和本地 UI。
- 1M 窗口是模型能力上限，项目用自己的 `contextBudgetTokens`（默认 120k）决定实际输入；`weave config show|set|migrate` 可查看与调整，`weave doctor` 会用服务商 usage 校准 `charsPerToken` 并在偏差超过 20% 时提示。
- 想法收件箱保存在 `ideas/`；`weave idea promote` 只生成候选或草稿，经 pending 裁决后才走目标现有保存路径，任何时候都不会自动写 `ledger/` 或正式 canon。
- 驾驶舱提供下一步状态机、上下文预算页与分段页；`/api/chapters/:n/context/budget` 列出 included/omitted/withheld/degraded 及每项 token 与是否 required。
- 番茄平台档案、热点快照和发布资料属于外部参考，不会自动改写 Canon 或故事计划。
- 工程测试只证明接线、数据边界和门禁行为，**不证明正文更受读者欢迎**。真实模型基线与盲评状态见 `bench/BASELINE.md`；番茄 holdout 的真实复跑和人工评分仍未完成。
- 产品目标见 `goal-and-requirements.md`，跨任务约束见 `docs/specs/effect-first/SPEC.md`，外部工具调研见 `docs/research/fanqie-tooling-and-skill-components.md`。

## 环境与检查

当前验证环境为 Node.js 24.14.1。安装依赖并运行完整类型检查与工程测试：

```bash
npm install
npm run check
```

下文的 `weave` 表示 `npm run weave --`。模型密钥只从 `WEAVE_API_KEY` 环境变量读取。

## 快速开始

```bash
weave init ../my-book --title "我的长篇" --model <model> --base-url <openai-compatible-url> --workflow p05 --platform fanqie
weave --root ../my-book status
weave --root ../my-book ui
```

典型章节流程（两段式：先打磨阅读效果，正文定型后再跑可信验证链，避免反复重跑抽取/审计）：

```bash
# 1. 打磨段（低成本，可多轮迭代）
weave --root ../my-book contract check 1
weave --root ../my-book write 1
weave --root ../my-book check 1
weave --root ../my-book effect-review 1
# 如需针对效果建议或关键章生成候选片段：weave revise 1 --findings e1 / weave key-candidates 1 → weave merge 1 --revision <id>

# 2. 冻结验证段（正文定型后一次性过可信门禁）
weave --root ../my-book extract 1
weave --root ../my-book audit 1
weave --root ../my-book review 1
weave --root ../my-book finalize 1
```

可信审查可以阻断定稿；阅读效果审查只产生 warning/info，不会因建议未处理而阻断作者定稿。

分段生成为**显式 opt-in**，不是零配置默认路径；需要先批准场景节拍与分段计划：

```bash
weave --root ../my-book beats generate 1
weave --root ../my-book beats approve 1
weave --root ../my-book segments plan 1
weave --root ../my-book segments approve 1
weave --root ../my-book write 1 --strategy segmented
```

分段失败时可从段边界恢复（`write --strategy segmented --resume <runId>`）；定稿门禁不变。效果基线与放量门槛见 `bench/BASELINE.md`，当前真实数据未采集，默认仍是 `prose-first`。基线脚本默认 `--repeat 3`，顶层报告取中位数；冒烟时可显式 `--repeat 1`。

## 外部 story-deslop 组件

`story-deslop` 已从隔离夹具接入 `effect-review`，但默认关闭。只有显式提供固定来源的组件目录才会执行：

```bash
weave --root ../my-book effect-review 1 --external-deslop-root /path/to/oh-story-claudecode
weave --root ../my-book external inspect --component-root /path/to/oh-story-claudecode
weave --root ../my-book external test-deslop /path/to/chapter.md --component-root /path/to/oh-story-claudecode
```

组件目录不再默认指向仓库测试夹具。Weave 校验上游 commit、MIT 许可和内容哈希；外部结果保留独立 finding ID 和来源，上游 blocking 降为 warning，不自动改稿。其他候选组件目前只有调研与存在性检查，不是通用 Skill 注册表。

## 热点：半自动离线流程

当前不会访问番茄网站、复用登录态或自动抓榜。流程是：

1. 作者从榜单导出或粘贴为 CSV/支持的 Markdown；CSV 可使用 `rank,title,author,genre,tags,status,wordCount,metricValue,url` 列。
2. 导入时记录实际采集日期、榜单、频道和指标口径：

   ```bash
   weave --root ../my-book hotspot import ./fanqie.csv --captured-at 2026-11-07 --ranking "都市榜" --channel all --metric "在读"
   ```

3. 用 `hotspot list` / `show` 查看快照，用 `hotspot compare <previousId> <currentId>` 比较相同口径的两次样本，用 `hotspot candidates <snapshotId>` 提取重复题材或标签。

比较结果只描述导入样本，不代表平台份额、完读率或正文质量。实时抓取需要另行评审登录态、频率、页面权限和合规约束。
