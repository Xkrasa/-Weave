---
id: weave-issue13-baseline-execution
type: execution-checklist
title: Issue #13 真实基线执行清单
status: ready-for-human
tags:
  - bench
  - blind-eval
  - checklist
date: 2026-11-09
---

# Issue #13 真实基线执行清单

> **权威边界**：子任务状态与勾选以 GitHub Issue #13 为准，本文只放操作步骤与判定标准。执行过程中不要更新本文的"状态"，只勾选步骤；结果写回 `bench/BASELINE.md` 与 issue。
>
> **前置硬要求**（Issue 原文）：真实模型调用前必须由作者确认**模型、预算、材料范围**。未确认前不要跑 `--mode real`。

## 步骤 0：确认三件事（只有你能定）

- [ ] **模型**：沿用 `cn:glm-5.3`，还是换一个（换模型则整批重跑，不能跨模型比较）
- [ ] **预算**：本批允许的调用次数 / 金额上限（见下方成本口径）
- [ ] **材料范围**：只用 `bench/seeds/` 原创种子；真实旧稿另行标记来源与授权，**不与合成语料混报**

## 步骤 1：环境自检（5 分钟，零成本）

```powershell
# 代理是否在线、模型名是否可见
Invoke-RestMethod http://127.0.0.1:7863/v1/models | ConvertTo-Json -Depth 4 | Select-String 'glm'

# 密钥只从环境变量读（不要写进任何文件）
$env:WEAVE_API_KEY = "<你的 key>"

# 仓库自检：模型未配置时也应能手工写作
node bin/weave.mjs doctor
```

- [ ] 代理返回模型列表
- [ ] `doctor` 无 blocking 项

## 步骤 2：13.2 当前管线复跑（机器时间约 10 分钟）

目的：环境描写 prompt 修改后，用同一玄幻种子重跑当前默认策略，保留可比输出。

**只改一个变量**。可选对照二选一，不要同时改两个：

- A. 渲染器对照：`json`（默认） vs `mission`（环境变量 `WEAVE_PROMPT_RENDERER=mission`）
- B. 策略对照：`prose-first` vs `segmented`（后者已交付但默认关闭）

```powershell
# 当前默认（跑两次，用于 13.4 的"至少重复一次"）
node scripts/benchmark.ts run --suite craft --seed broken-cultivation --mode real `
  --base-url http://127.0.0.1:7863/v1 --model cn:glm-5.3 `
  --timeout-ms 180000 --max-output 8192 --repeat 2 `
  --out bench/runs/real-craft-broken-cultivation-20261109

# 对照（示例：渲染器）
$env:WEAVE_PROMPT_RENDERER = "mission"
node scripts/benchmark.ts run --suite craft --seed broken-cultivation --mode real `
  --base-url http://127.0.0.1:7863/v1 --model cn:glm-5.3 `
  --timeout-ms 180000 --max-output 8192 --repeat 2 `
  --out bench/runs/real-craft-broken-cultivation-mission
Remove-Item Env:WEAVE_PROMPT_RENDERER
```

- [ ] 两次运行 `mode: real`、0 次失败、原始 JSON 落在 `bench/runs/`（该目录被 gitignore，需自己备份）
- [ ] 记录：字数、耗时、tokens、重试次数、开篇环境段落密度

## 步骤 3：13.3 匿名对照 + 人工评分（你的时间 10–25 分钟）

```powershell
# 生成打乱顺序的对照，mapping 密封
node scripts/benchmark.ts pairs `
  --a bench/runs/real-craft-broken-cultivation-20261109 `
  --b bench/runs/real-craft-broken-cultivation-mission `
  --out bench/runs/pairs-broken-20261109

# 导入盲评会话
node bin/weave.mjs eval import bench/runs/pairs-broken-20261109 --title "玄幻开篇 json vs mission"

# 打开界面，顶栏「盲评」逐组打分
node bin/weave.mjs ui
```

评分时只回答三件事：**更想继续读哪边 / 平局 / 在哪里弃读**，可留备注。

- [ ] 每组都给出判定（含平局），不留空
- [ ] 评分完成前不解封 `mapping.json`
- [ ] 完成后出报告：`node bin/weave.mjs eval report <sessionId>`
- [ ] 若同时想看番茄目标读者的观感，另跑 `--seed fanqie-rewind-ten-minutes`，但它是 **holdout**：只看结论，不据此调参

## 步骤 4：13.4 基线报告（30 分钟）

写回 `bench/BASELINE.md`，只记事实，不写文学结论：

- [ ] 实验条件：模型、参数、种子、管线版本（当前 `main` 提交哈希）
- [ ] 样本范围：章数、字数、重复次数；明确"单模型单种子，不足以比较模型"
- [ ] 原始输出位置：`bench/runs/<dir>`（本地路径，注明未入库）
- [ ] 评分结果：逐组偏好数、平局数、弃读点分布；**评分不足时明确写"不能计算胜率"**
- [ ] 成本与耗时：机器时间、tokens、重试
- [ ] 限制：合成前文只验证检索/记忆，不作文学证据
- [ ] 更新"盲评状态"小节里的"当前收集到的人工评分：N 对"

## 步骤 5：13.5 作者效率信号（随真实写作持续记录）

不是跑一次就完，是在你自己的项目里用一轮：

- [ ] 选 1 个真实章节，走 `write` → 读候选 → 采纳或手改
- [ ] 记录三项：**候选采用与否**、**人工修改时长**、**接受这一章的成本**（耗时 + tokens）
- [ ] 记录落在你的工作笔记；**弱信号不自动转成作者规则**，如需沉淀为偏好，走 `preferences` 的候选-确认流程

## 单独一批（不在 #13 内，按需启动）：分段放量

`bench/BASELINE.md` 已定 S/M/L 三组与 5 条放量门槛。它需要 **2 策略 × 3 次 × 3 组 = 18 次运行**，是这批里最贵的部分，建议等 #13 完成、确认预算后再单开：

```powershell
node scripts/benchmark.ts run --suite segmented-rollout --strategy prose-first --mode real `
  --base-url http://127.0.0.1:7863/v1 --model cn:glm-5.3 `
  --timeout-ms 180000 --max-output 8192 --repeat 3 `
  --out bench/runs/segmented-rollout-prose
```

门槛（全部满足才考虑改默认路径）：L 组完成率 ≥95%、段级首次通过率 ≥90%、合并稿门禁通过率不低于单次路径、总成本 ≤1.25 倍、至少 1 轮盲评留痕。

## 红线（违反任何一条，这批数据作废）

1. 不用 `--mode fake` 输出冒充效果证据；
2. 不用模型自评分代替人工评分；
3. 不在评分完成前解封 mapping；
4. 不因单次胜率翻转默认值或回滚；
5. 不把字数差异换算成质量差异；
6. 不让 holdout 种子参与调参；
7. 不改生成策略——#13 只补实验材料与数据闭环。

## 成本口径（相对值，按你代理的计费换算）

| 批次 | 运行次数 | 机器时间 | 备注 |
| --- | --- | --- | --- |
| 步骤 2（cultivation ×2 版本 ×2 次） | 4 | ~10 min | craft 4 章/次，基线单次约 150s |
| 步骤 3 盲评 | 0 | 人工 10–25 min | 4–8 组 |
| 步骤 4 报告 | 0 | 人工 ~30 min | 纯整理 |
| 分段放量（可选） | 18 | 1.5–3 h | 6000–9000 字/次，成本最高 |

## 完成后回写清单

- [ ] Issue #13：勾选 13.2 / 13.3 / 13.4 / 13.5（13.5 可先留开）
- [ ] `bench/BASELINE.md`：盲评状态、番茄 holdout 状态、限制小节
- [ ] 若结论触碰默认值：**不自动改**，在 issue 里留一条待裁决记录
- [ ] `README.md`「当前状态」若口径变化，同轮更新（避免文档与事实冲突）
