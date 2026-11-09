---
id: idea-inbox-core
type: task-spec
title: 想法收件箱模型、存储与 CLI/API
status: implemented
parent: weave-effect-first-architecture
references:
  - weave-next-iteration-plan
tags:
  - ideas
  - inbox
  - cli
---

# 想法收件箱模型、存储与 CLI/API

## 任务目标

提供一个零门槛的想法捕获入口：作者随手记一句，5 秒内落盘、可在 CLI/UI 看到、可编辑、可归档；捕获不调用模型、不进入上下文、不改任何故事事实。

## 现状

仓库没有 `idea / inbox / 想法 / 灵感` 的业务实现。最接近的 `plans/`、`canon/`、`references/`、`preferences/` 都需要较重编辑或批准，不适合随手记。

## 存储

新增 `ideas/`，每个想法一对文件：

```text
ideas/idea-20261107-a1b2c3.json   # 元数据
ideas/idea-20261107-a1b2c3.md     # 正文（Markdown）
```

- 元数据用 JSON，和仓库现有 `plans/`、`ledger/` 的 JSON 习惯一致；正文用 Markdown，作者可直接用任意编辑器修改。
- 创建/更新时两个文件原子写；`listIdeas` 以 JSON 为准，正文缺失时按空正文处理并提示。
- `projectPaths` 增 `ideas`；`initProject` 创建目录。

## 模型

`src/core/ideas.ts`：

```ts
export type IdeaStatus = 'inbox' | 'promoted' | 'archived'
export type IdeaScope =
  | { kind: 'chapter'; ref: number }
  | { kind: 'volume'; ref: number }
  | { kind: 'book' }
  | { kind: 'character'; ref: string }
  | { kind: 'world' }
  | { kind: 'mechanic' }

export interface Idea {
  id: string
  schemaVersion: 1
  title: string
  status: IdeaStatus
  tags: string[]
  scope: IdeaScope
  priority: 'high' | 'normal' | 'low'
  spoilerLevel: 'none' | 'hint' | 'reveal'
  revealAfterChapter?: number
  links: { promiseIds: string[]; loopIds: string[]; chapters: number[] }
  promotion?: {
    target: 'plan' | 'contract' | 'outline' | 'canon' | 'promise'
    targetPath: string
    targetHash: string
    promotedAt: string
    approvedBy: 'author'
  }
  createdAt: string
  updatedAt: string
}
```

函数：

```ts
captureIdea(root, input): Promise<Idea>
listIdeas(root, filter?): Promise<Idea[]>
readIdea(root, id): Promise<{ meta: Idea; body: string }>
updateIdea(root, id, patch): Promise<Idea>
archiveIdea(root, id): Promise<Idea>
```

- `id` 用日期 + 随机短 hex，稳定不变。
- `title` 缺省取正文第一行，截断 40 字符；正文为空直接拒绝。
- `archive` 只改 `status`，不删除文件。
- 捕获不调用模型、不写 ledger、不写 canon、不进入材料装配。

## CLI

```bash
weave idea add "长老在第三卷反目" --tag 人物 --tag 反转 --scope volume:3
weave idea list [--status inbox|promoted|archived] [--tag ...]
weave idea show <id>
weave idea edit <id> --title ... --body ...
weave idea archive <id>
```

- `add` 支持 `--priority high|normal|low`、`--spoiler none|hint|reveal`、`--after <chapter>`。
- 输出包含 id、标题、状态、scope、标签，方便下一步 `promote`。

## API

```text
GET    /api/ideas?status=inbox
POST   /api/ideas
PATCH  /api/ideas/:id
DELETE /api/ideas/:id          # 归档，不物理删除
```

- 写操作沿用 `x-weave-token` 校验。
- 返回体包含元数据与正文；列表只返回元数据摘要，避免大响应。

## 验收

- `weave idea add` 在普通项目上 5 秒内完成，生成两个文件且可被 `list` 读到。
- 关闭 UI 再打开，想法仍在；直接手改 Markdown 正文后，`show` 读到新内容。
- `archive` 后文件保留、`list --status archived` 可见，默认列表不显示。
- 捕获与编辑不修改 `ledger/`、`canon/`、`plans/`，`git status` 只出现 `ideas/`。
- 空正文、非法 scope、非法 priority 被拒绝且不落半成品。
- `npm run typecheck` 与新增 `test/ideas.test.ts` 全绿。

## 非目标

- 不做晋升、不做上下文回灌、不做想法地图（后续任务）。
- 不调用模型生成或补全想法。
- 不用数据库替代纯文本文件；不引入 YAML 解析依赖。
