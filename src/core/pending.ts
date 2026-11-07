import path from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import type { AuditMissedItem, CoverageAudit, ExtractionReport, PendingRecord } from './stage-types.ts'
import { objectHash } from './hash.ts'
import type { LedgerFact } from './types.ts'
import { atomicWriteJson, listFiles, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { loadStage, saveStage } from './stages.ts'
import { validationError } from './errors.ts'

export type PendingChoice = 'text' | 'ledger' | 'dismiss' | 'rerun' | 'promote'
export type PendingKind = 'ledger-conflict' | 'audit-missed' | 'idea-promotion'

/** Idea promotions use the same decision log; the pending id is derived from the idea id. */
export const IDEA_PROMOTION_PREFIX = 'idea-promotion-'

export interface IdeaPromotionPending {
  pendingId: string
  ideaId: string
  target: string
  targetPath: string
}

export interface PendingDecision {
  decisionId: string
  pendingId: string
  kind?: PendingKind
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

/** 某章已裁决的 pendingId 集合；audit 与列表共用。 */
export async function decidedPendingIds(root: string, chapter: number): Promise<Set<string>> {
  const decided = new Set<string>()
  for (const decision of await loadPendingDecisions(root)) {
    if (decision.chapter === chapter) decided.add(decision.pendingId)
  }
  return decided
}

async function saveDecisions(root: string, decisions: PendingDecision[]): Promise<void> {
  await atomicWriteJson(storePath(root), { schemaVersion: 1, decisions })
}

function newDecisionId(): string {
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
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
  const decided = await decidedPendingIds(root, chapter)
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
 * Open idea promotions: every saved proposal is a pending record until the author applies
 * or dismisses it. The proposal file is the payload; the decision log is the audit trail.
 */
export async function listIdeaPromotionPendings(root: string): Promise<IdeaPromotionPending[]> {
  const dir = projectPaths(root).ideaProposals
  const decided = new Set((await loadPendingDecisions(root)).map(decision => decision.pendingId))
  const pending: IdeaPromotionPending[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const proposal = await readJsonIfExists<{ ideaId?: string; target?: string; targetPath?: string }>(
      path.join(dir, name),
    )
    if (!proposal?.ideaId || !proposal.target || !proposal.targetPath) continue
    const pendingId = `${IDEA_PROMOTION_PREFIX}${proposal.ideaId}`
    if (decided.has(pendingId)) continue
    pending.push({ pendingId, ideaId: proposal.ideaId, target: proposal.target, targetPath: proposal.targetPath })
  }
  return pending.sort((left, right) => left.ideaId.localeCompare(right.ideaId))
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
  if (pendingId.startsWith(IDEA_PROMOTION_PREFIX)) {
    return decideIdeaPromotion(root, pendingId, choice, reason)
  }
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
    decisionId: newDecisionId(),
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

async function decideIdeaPromotion(
  root: string,
  pendingId: string,
  choice: PendingChoice,
  reason: string,
): Promise<PendingDecision> {
  if (choice !== 'promote' && choice !== 'dismiss') {
    throw validationError('想法晋升裁决只能是 promote 或 dismiss')
  }
  if (!reason.trim()) throw validationError('裁决必须提供理由')
  const ideaId = pendingId.slice(IDEA_PROMOTION_PREFIX.length)
  if (!ideaId) throw validationError(`无效的想法晋升 pending：${pendingId}`)
  const existing = (await loadPendingDecisions(root)).find(decision => decision.pendingId === pendingId)
  if (existing) throw validationError(`该记录已有裁决：${pendingId}`)
  if (choice === 'promote') {
    // Dynamic import keeps the ideas <-> pending dependency one-way at module load time.
    const { applyPromotion, loadPromotionProposal } = await import('./ideas.ts')
    const proposal = await loadPromotionProposal(root, ideaId)
    if (!proposal) throw validationError(`没有待应用的晋升提案：${ideaId}`)
    await applyPromotion(root, ideaId, proposal)
    const applied = (await loadPendingDecisions(root)).filter(decision => decision.pendingId === pendingId).at(-1)
    if (!applied) throw validationError(`晋升已应用，但没有写入裁决日志：${ideaId}`)
    return applied
  }
  const decision: PendingDecision = {
    decisionId: newDecisionId(),
    pendingId,
    kind: 'idea-promotion',
    chapter: 0,
    subject: ideaId,
    choice,
    reason: reason.trim(),
    createdAt: new Date().toISOString(),
  }
  const decisions = await loadPendingDecisions(root)
  decisions.push(decision)
  await saveDecisions(root, decisions)
  await audit(root, 'idea-dismiss', decision)
  return decision
}

/**
 * Idea promotion decisions share the pending decision log, but are not tied to an
 * extraction stage: a promotion can happen before the chapter is ever generated.
 * `chapter` is 0 because the log field is chapter-bound for ledger/audit records.
 */
export async function recordIdeaPromotionDecision(
  root: string,
  input: { ideaId: string; targetPath: string; choice: 'promote' | 'dismiss'; reason: string },
): Promise<PendingDecision> {
  if (!input.reason.trim()) throw validationError('晋升裁决必须提供理由')
  const decisions = await loadPendingDecisions(root)
  const decision: PendingDecision = {
    decisionId: newDecisionId(),
    pendingId: `${IDEA_PROMOTION_PREFIX}${input.ideaId}`,
    kind: 'idea-promotion',
    chapter: 0,
    subject: input.targetPath,
    choice: input.choice,
    reason: input.reason.trim(),
    createdAt: new Date().toISOString(),
  }
  decisions.push(decision)
  await saveDecisions(root, decisions)
  await audit(root, `idea-${input.choice}`, decision)
  return decision
}

export function missedFingerprint(chapter: number, item: { summary: string; quote: string }): string {
  const fingerprint = objectHash({ summary: item.summary.trim(), quote: item.quote.trim() }).slice(0, 10)
  return `missed-${chapter}-${fingerprint}`
}

/** 某章已驳回（dismiss）的第二遍审计遗漏项 ID 集合。 */
export async function dismissedAuditMissedIds(root: string, chapter: number): Promise<Set<string>> {
  const dismissed = new Set<string>()
  for (const decision of await loadPendingDecisions(root)) {
    if (decision.chapter === chapter && decision.kind === 'audit-missed' && decision.choice === 'dismiss') {
      dismissed.add(decision.pendingId)
    }
  }
  return dismissed
}

export async function decideAuditMissed(
  root: string,
  chapter: number,
  missedId: string,
  choice: 'dismiss' | 'rerun',
  reason: string,
): Promise<{ decision: PendingDecision; item: AuditMissedItem; auditReport: CoverageAudit }> {
  const report = await loadStage<CoverageAudit>(root, 'audit', chapter)
  if (!report) throw validationError(`第 ${chapter} 章没有覆盖审计报告`)
  const items = report.secondPass.missedItems ?? []
  const item = items.find(entry => entry.missedId === missedId)
  if (!item) throw validationError(`未找到第二遍审计遗漏项：${missedId}`)
  if (!reason.trim()) throw validationError('裁决必须提供理由')
  const decisions = await loadPendingDecisions(root)
  const existing = decisions.find(
    entry => entry.chapter === chapter && entry.kind === 'audit-missed' && entry.pendingId === missedId && entry.choice === 'dismiss',
  )
  const decision: PendingDecision = existing ?? {
    decisionId: newDecisionId(),
    pendingId: missedId,
    kind: 'audit-missed',
    chapter,
    subject: item.summary,
    choice,
    reason: reason.trim(),
    createdAt: new Date().toISOString(),
  }
  if (!existing) {
    decisions.push(decision)
    await saveDecisions(root, decisions)
    await audit(root, `audit-${choice}`, decision)
  }
  if (choice === 'dismiss') {
    const dismissed = await dismissedAuditMissedIds(root, chapter)
    const remaining = items.filter(entry => !dismissed.has(entry.missedId))
    report.secondPass.missed = remaining.map(entry => entry.summary)
    report.passed =
      report.contract.missed.length === 0
      && (report.dimensions?.missed.length ?? 0) === 0
      && report.timeline.passed
      && remaining.length === 0
    await saveStage(root, 'audit', chapter, report)
  }
  return { decision, item, auditReport: report }
}
