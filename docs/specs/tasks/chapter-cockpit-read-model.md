---
id: chapter-cockpit-read-model
type: task-spec
title: 驾驶舱聚合读模型与证据偏移
status: implemented
parent: weave-effect-first-architecture
references:
  - weave-next-iteration-plan
  - planning-authoring-ui
tags:
  - ui
  - api
  - evidence
---

# 驾驶舱聚合读模型与证据偏移

## 任务目标

用一个只读接口把打开一章所需的状态一次取回，并把账本/审查里的**字节偏移**准确转换成浏览器可用的**字符偏移**，让“点击 finding 跳到正文原句”不再依赖 `indexOf` 猜位置。

## 现状

- 现有 UI 打开章节要多次请求：`/api/chapters/:n`、`/contract`、`/gates`、`/findings`、`/revisions`、`/history`（`src/core/ui-server.ts:124-503`）。
- `EvidenceSpan` 使用 `byteStart` / `byteEnd` / `quote` / `occurrence`（`src/core/stage-types.ts:5-13`）。
- `locateQuote` 用 `editor.value.indexOf(quote)`，忽略 `occurrence`，同一句出现多次会定位到第一处（`src/ui/app.js:492-503`）。

## 实现边界

### 聚合读模型

新增 `src/core/cockpit.ts`：

```ts
export interface CockpitPayload {
  chapter: number
  contract: { data: ChapterContract; hash: string; check: CheckReport }
  draft: { text: string; contentHash: string; meta: DraftMeta | null }
  gates: GateReport
  findings: FindingView[]
  revisions: RevisionSummary[]
  segmentPlan?: SegmentPlanView
  context: {
    effectiveWindow: number
    capacityTokens: number
    usedTokens: number
    omitted: Array<{ sourceId: string; reason: string }>
    withheld: Array<{ sourceId: string; reason: string }>
    degraded: Array<{ sourceId: string; reason: string }>
  }
  run?: RunRecord
  neighbors: { prev: number | null; next: number | null }
}
```

- `GET /api/chapters/:n/cockpit` 返回上述结构；旧路由全部保留，避免破坏 CLI/测试。
- 一次读取草稿、合同、检查、门禁、finding、revision；不得在 finding 循环里重复读文件。
- revision 只返回摘要（id、状态、段落数、时间），全文按需走原路由。
- 响应过大时（如 finding > 200）截断并标记 `truncated: true`，提示用筛选路由。

### 字节→字符偏移

新增 `src/core/text-offsets.ts`：

```ts
export function buildOffsetTable(text: string): {
  byteToChar: (byteOffset: number) => number
}

export function resolveEvidence(text: string, span: EvidenceSpan): {
  charStart: number
  charEnd: number
  line: number
  matched: boolean
}
```

- 用 `TextEncoder` 逐 code point 累计 UTF-8 字节长度，建立前缀表；二分查找。
- 必须支持 CJK（3 字节）、emoji（4 字节，含代理对）、ASCII、组合字符。
- `resolveEvidence` 优先用 `quote + occurrence` 定位第 N 次出现，校验与 `byteStart` 一致；不一致时标记 `matched: false`，不静默跳到错误位置。
- `line` 为 1-based，前端用于滚动估算。
- 偏移转换在服务端完成；`FindingView` / `RevisionView` 增 `charStart` / `charEnd` / `line` / `matched`，原始字节字段保留。

## 验收

- 打开一章只发 1 个 `/cockpit` 请求；旧路由仍可用。
- 同一句在正文出现 3 次时，`occurrence: 2` 解析到第 2 次，`charStart` 与 `byteStart` 相互校验一致。
- 含 CJK、emoji、英文混排的正文，所有 span 的字符偏移都能精确选中原文。
- 引文被作者改过、无法匹配时返回 `matched: false`，前端提示“定位失效”，不跳到错误位置。
- 聚合接口不产生 N+1 读取；100 条 finding 的响应在可接受范围内。
- `npm run typecheck` 与新增 `test/cockpit.test.ts` 全绿。

## 非目标

- 不在本任务做任何写操作、批准、合并或定稿按钮。
- 不实现前端界面；只提供读模型与偏移工具。
- 不引入缓存层或数据库新表；先保证正确性。
