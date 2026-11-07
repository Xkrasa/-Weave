import path from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import type { ExtractionReport, PendingRecord } from './stage-types.ts'
import type { LedgerFact } from './types.ts'
import { atomicWriteJson, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { loadStage, saveStage } from './stages.ts'
import { validationError } from './errors.ts'

export type PendingChoice = 'text' | 'ledger'

export interface PendingDecision {
  decisionId: string
  pendingId: string
  chapter: number
  subject: string
  choice: PendingChoice
  reason: string
  createdAt: string
}

interface DecisionStore {
  schemaVersion: 1
  decisions: PendingDecision[]
}

function storePath(root: string): string {
  return path.join(projectPaths(root).metadata, 'pending-decisions.json')
}

function auditPath(root: string): string {
  return path.join(projectPaths(root).metadata, 'pending-decisions.log.jsonl')
}

export async function loadPendingDecisions(root: string): Promise<PendingDecision[]> {
  const store = await readJsonIfExists<DecisionStore>(storePath(root))
  return store?.decisions ?? []
}

async function saveDecisions(root: string, decisions: PendingDecision[]): Promise<void> {
  await atomicWriteJson(storePath(root), { schemaVersion: 1, decisions })
}

async function audit(root: string, event: string, decision: PendingDecision): Promise<void> {
  await mkdir(projectPaths(root).metadata, { recursive: true })
  await appendFile(auditPath(root), `${JSON.stringify({ event, ...decision, at: new Date().toISOString() })}\n`, 'utf8')
}

export async function listPending(
  root: string,
  chapter: number,
): Promise<{ unresolved: PendingRecord[]; resolved: PendingRecord[] }> {
  const report = await loadStage<ExtractionReport>(root, 'extraction', chapter)
  if (!report) throw validationError(`第 ${chapter} 章没有抽取报告`)
  const decided = new Set((await loadPendingDecisions(root))
    .filter(decision => decision.chapter === chapter)
    .map(decision => decision.pendingId))
  const records = report.pending ?? []
  return {
    unresolved: records.filter(record => !decided.has(record.pendingId)),
    resolved: records.filter(record => decided.has(record.pendingId)),
  }
}

/** 扫描章节的抽取 stage，聚合未裁决冲突；供 status / UI 队列使用。 */
export async function listUnresolvedPending(
  root: string,
  chapters: number[],
): Promise<Array<{ chapter: number } & PendingRecord>> {
  const decisions = await loadPendingDecisions(root)
  const decided = new Set(decisions.map(decision => decision.pendingId))
  const found: Array<{ chapter: number } & PendingRecord> = []
  for (const chapter of [...new Set(chapters)].sort((a, b) => a - b)) {
    const report = await loadStage<ExtractionReport>(root, 'extraction', chapter).catch(() => null)
    for (const record of report?.pending ?? []) {
      if (decided.has(record.pendingId)) continue
      found.push({ ...record, chapter })
    }
  }
  return found
}

/**
 * 裁决：以正文为准时把扣下的事实放回抽取 stage（补上 supersedes，指向它冲突的旧事实），
 * 重放投影后与手工修正一致；以账本为准时只记录决定，事实保持不入账。
 */
export async function decidePending(
  root: string,
  chapter: number,
  pendingId: string,
  choice: PendingChoice,
  reason: string,
): Promise<PendingDecision> {
  const report = await loadStage<ExtractionReport>(root, 'extraction', chapter)
  if (!report) throw validationError(`第 ${chapter} 章没有抽取报告`)
  const record = (report.pending ?? []).find(item => item.pendingId === pendingId)
  if (!record) throw validationError(`未找到待裁决记录：${pendingId}`)
  if (!reason.trim()) throw validationError('裁决必须提供理由')
  const decisions = await loadPendingDecisions(root)
  if (decisions.some(decision => decision.pendingId === pendingId)) {
    throw validationError(`该记录已有裁决：${pendingId}`)
  }
  if (choice === 'text') {
    const fact = record.raw as LedgerFact
    report.facts = [...report.facts.filter(item => item.factId !== fact.factId), { ...fact, supersedes: record.conflictWith }]
    await saveStage(root, 'extraction', chapter, report)
  }
  const decision: PendingDecision = {
    decisionId: `decision-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    pendingId,
    chapter,
    subject: record.subject,
    choice,
    reason: reason.trim(),
    createdAt: new Date().toISOString(),
  }
  decisions.push(decision)
  await saveDecisions(root, decisions)
  await audit(root, choice, decision)
  return decision
}
