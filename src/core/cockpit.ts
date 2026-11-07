import path from 'node:path'
import type { ChapterContract, DraftMeta, MaterialDecision, RunRecord } from './types.ts'
import type {
  ContentCheckReport,
  CoverageAudit,
  ExtractionReport,
  ReviewReport,
  RevisionCandidate,
  StageKind,
} from './stage-types.ts'
import type { ContractCheckRecord } from './contract.ts'
import { checkPath, contractHash, loadContract, requirePassingContractCheck, chapterFileStem } from './contract.ts'
import { draftHash, loadStage, readDraft } from './stages.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { projectPaths, loadModelConfig } from './project.ts'
import { contextCapacityTokens, effectiveContextWindow } from './config.ts'
import { assembleChapterContext } from './materials.ts'
import { estimateTokens } from './context.ts'
import { readSegmentPlan, segmentTextPath, type SegmentPlanView, type ChapterSegment } from './segments.ts'
import { readBeatCandidate, type BeatCandidateView } from './beats.ts'
import { countProseChars } from './segment-checks.ts'
import { assertNoPendingImpacts } from './impact.ts'
import { assertProjectionCurrent } from './projections.ts'
import { assertLedgerProjectionCurrent } from './ledger-projection.ts'
import { loadDraftMeta } from './runs.ts'
import { projectStatus, type ProjectStatus } from './services.ts'
import { buildOffsetTable, locateQuote, resolveEvidence, type OffsetTable } from './text-offsets.ts'
import { WeaveError } from './errors.ts'

export interface GateView {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface GateReport {
  chapter: number
  ready: boolean
  gates: GateView[]
}

export interface FindingView {
  findingId: string
  source: 'review' | 'content-check'
  dimension: string
  severity: 'blocking' | 'warning' | 'info'
  description: string
  status: string
  quote?: string
  /** Original byte fields are kept so older clients and evidence cards still work. */
  byteStart?: number
  byteEnd?: number
  occurrence?: number
  charStart?: number
  charEnd?: number
  line?: number
  matched?: boolean
  waiveReason?: string
  revisionId?: string
}

export interface RevisionSummary {
  revisionId: string
  createdAt: string
  status: 'candidate' | 'merged' | 'conflict'
  paragraphs: number
  findings: string[]
  baseDraftHash: string
  selection?: {
    operation: string
    selectedText: string
    replacement: string
    occurrence: number
  }
  charStart?: number
  charEnd?: number
  line?: number
  matched?: boolean
}

export interface CockpitContextItem {
  sourceId: string
  label: string
  purpose: string
  category: string
  tokens: number
  required: boolean
}

export interface CockpitContext {
  model: string
  charsPerToken: number
  effectiveWindow: number
  capacityTokens: number
  usedTokens: number
  remainingTokens: number
  included: CockpitContextItem[]
  omitted: Array<{ sourceId: string; reason: string }>
  withheld: Array<{ sourceId: string; reason: string }>
  degraded: Array<{ sourceId: string; reason: string }>
  error?: string
}

export interface StageSummary {
  passed: boolean
  draftHash: string
}

export interface SegmentStat {
  segmentId: string
  chars: number
  status: 'planned' | 'generating' | 'draft' | 'checked' | 'approved' | 'failed'
}

export interface CockpitStages {
  contentCheck: StageSummary | null
  extraction: StageSummary | null
  audit: StageSummary | null
  review: StageSummary | null
}

export interface CockpitPayload {
  chapter: number
  contract: {
    data: ChapterContract | null
    hash: string | null
    check: ContractCheckRecord | null
  }
  draft: {
    text: string
    contentHash: string
    meta: DraftMeta | null
  }
  gates: GateReport
  findings: FindingView[]
  truncated?: boolean
  revisions: RevisionSummary[]
  segmentPlan?: SegmentPlanView
  segmentStats?: SegmentStat[]
  beats: BeatCandidateView
  stages: CockpitStages
  finalized: boolean
  /** Mainline revision when the chapter is finalized; 0 otherwise. */
  revision: number
  context: CockpitContext
  run?: RunRecord
  neighbors: { prev: number | null; next: number | null }
  /** Server-computed single next step; the UI never guesses the stage order. */
  nextAction: NextAction
}

export type NextAction =
  | { kind: 'contract-check'; label: string }
  | { kind: 'beats-generate' | 'beats-approve'; label: string }
  | { kind: 'segments-plan' | 'segments-approve'; label: string }
  | { kind: 'write'; label: string }
  | { kind: 'stage'; stage: StageKind; label: string }
  | { kind: 'revise' | 'waive'; label: string }
  | { kind: 'finalize'; label: string }
  | { kind: 'done'; label: string }

/**
 * Pure state machine: recommends one action, never executes it. Finalize stays on the
 * server so UI shortcuts cannot bypass approvals or gate checks.
 */
export function nextAction(payload: Omit<CockpitPayload, 'nextAction'>): NextAction {
  const gate = (id: string): GateView | undefined => payload.gates.gates.find(item => item.id === id)
  if (!gate('contract')?.ok || !gate('contract-check')?.ok) {
    return { kind: 'contract-check', label: '运行合同检查' }
  }
  const beats = payload.beats.status
  if (beats === 'missing') return { kind: 'beats-generate', label: '生成场景节拍' }
  if (beats === 'draft' || beats === 'modified') return { kind: 'beats-approve', label: '批准场景节拍' }

  const segmented = payload.segmentPlan?.status !== undefined && payload.segmentPlan.status !== 'missing'
    ? payload.segmentPlan.status !== 'skipped'
    : payload.run?.draftingStrategy === 'segmented'
  if (segmented) {
    const segmentStatus = payload.segmentPlan?.status ?? 'missing'
    if (segmentStatus === 'missing') return { kind: 'segments-plan', label: '生成分段计划' }
    if (segmentStatus === 'draft' || segmentStatus === 'modified') {
      return { kind: 'segments-approve', label: '批准分段计划' }
    }
  }

  if (!gate('draft')?.ok) return { kind: 'write', label: '写本章' }

  const blocking = payload.findings.some(finding =>
    finding.severity === 'blocking' && finding.status !== 'ignored' && finding.status !== 'waived')
  if (blocking) return { kind: 'revise', label: '处理阻塞问题（修订或豁免）' }

  for (const [gateId, stage] of [
    ['content-check', 'content-check'],
    ['extraction', 'extraction'],
    ['audit', 'audit'],
    ['review', 'review'],
  ] as const) {
    const stageGate = gate(gateId)
    if (stageGate && !stageGate.ok) return { kind: 'stage', stage, label: `${stageGate.label}：${stageGate.detail}` }
  }

  if (!payload.finalized) return { kind: 'finalize', label: '定稿' }
  const otherBlocking = payload.gates.gates.find(item => !item.ok)
  return otherBlocking
    ? { kind: 'done', label: `需要先处理：${otherBlocking.label}` }
    : { kind: 'done', label: '本章已完成' }
}

export const MAX_COCKPIT_FINDINGS = 200

export async function buildChapterCockpit(root: string, chapter: number): Promise<CockpitPayload> {
  const [status, draftResult, contractResult, stages, config, segmentPlan, beats, run, revisions, meta] = await Promise.all([
    projectStatus(root),
    readDraft(root, chapter).then(
      text => ({ ok: true as const, text }),
      () => ({ ok: false as const, text: '' }),
    ),
    loadContract(root, chapter).then(
      data => ({ ok: true as const, data }),
      () => ({ ok: false as const, data: null }),
    ),
    loadStages(root, chapter),
    loadModelConfig(root).catch(() => null),
    readSegmentPlan(root, chapter).catch(() => ({ status: 'missing' } as SegmentPlanView)),
    readBeatCandidate(root, chapter).catch(() => ({ status: 'missing' } as BeatCandidateView)),
    latestWritingRun(root, chapter),
    listRevisionSummaries(root, chapter),
    loadDraftMeta(root, chapter),
  ])

  const contract = contractResult.ok ? contractResult.data : null
  const draft = draftResult.text
  const contentHash = draftHash(draft)
  const check = contract
    ? await readJsonIfExists<ContractCheckRecord>(checkPath(root, contract.chapter)).catch(() => null)
    : null
  const table = buildOffsetTable(draft)
  const findings = collectFindings(stages, table, draft)
  const truncated = findings.length > MAX_COCKPIT_FINDINGS
  const finalized = status.chapters.find(item => item.chapter === chapter)

  const base: Omit<CockpitPayload, 'nextAction'> = {
    chapter,
    contract: {
      data: contract,
      hash: contract ? contractHash(contract) : null,
      check,
    },
    draft: {
      text: draft,
      contentHash,
      meta,
    },
    gates: await buildGates(root, chapter, contract, draft, stages),
    findings: truncated ? findings.slice(0, MAX_COCKPIT_FINDINGS) : findings,
    ...(truncated ? { truncated: true } : {}),
    revisions,
    segmentPlan,
    ...(segmentPlan.plan ? { segmentStats: await computeSegmentStats(root, chapter, segmentPlan.plan.segments, run) } : {}),
    beats,
    stages: stageSummaries(stages),
    finalized: Boolean(finalized),
    revision: finalized?.revision ?? 0,
    context: await buildContext(root, contract, config),
    ...(run ? { run } : {}),
    neighbors: neighborsOf(status, chapter),
  }
  return { ...base, nextAction: nextAction(base) }
}

async function computeSegmentStats(
  root: string,
  chapter: number,
  segments: ChapterSegment[],
  run: RunRecord | undefined,
): Promise<SegmentStat[]> {
  const runtimeStatus = new Map((run?.segments ?? []).map(record => [record.segmentId, record.status]))
  const stats: SegmentStat[] = []
  for (const segment of segments) {
    const text = (await readTextIfExists(segmentTextPath(root, chapter, segment.segmentId)).catch(() => null)) ?? ''
    stats.push({
      segmentId: segment.segmentId,
      chars: countProseChars(text),
      status: runtimeStatus.get(segment.segmentId) ?? segment.status,
    })
  }
  return stats
}

function stageSummaries(stages: LoadedStages): CockpitStages {
  return {
    contentCheck: stages.contentCheck
      ? { passed: stages.contentCheck.passed, draftHash: stages.contentCheck.draftHash }
      : null,
    extraction: stages.extraction
      ? { passed: stages.extraction.passed, draftHash: stages.extraction.draftHash }
      : null,
    audit: stages.audit
      ? { passed: stages.audit.passed, draftHash: stages.audit.draftHash }
      : null,
    review: stages.review
      ? { passed: stages.review.passed, draftHash: stages.review.draftHash }
      : null,
  }
}

interface LoadedStages {
  contentCheck: ContentCheckReport | null
  extraction: ExtractionReport | null
  audit: CoverageAudit | null
  review: ReviewReport | null
}

async function loadStages(root: string, chapter: number): Promise<LoadedStages> {
  const [contentCheck, extraction, audit, review] = await Promise.all([
    loadStage<ContentCheckReport>(root, 'content-check', chapter),
    loadStage<ExtractionReport>(root, 'extraction', chapter),
    loadStage<CoverageAudit>(root, 'audit', chapter),
    loadStage<ReviewReport>(root, 'review', chapter),
  ])
  return { contentCheck, extraction, audit, review }
}

function collectFindings(stages: LoadedStages, table: OffsetTable, draft: string): FindingView[] {
  const findings: FindingView[] = []
  stages.review?.findings.forEach((finding, index) => {
    const location = finding.evidence
      ? resolveEvidence(draft, finding.evidence, table)
      : finding.quote
        ? locateQuote(draft, finding.quote, 1, table)
        : null
    findings.push({
      findingId: finding.findingId || `review-${index + 1}`,
      source: 'review',
      dimension: finding.dimension,
      severity: finding.severity,
      description: finding.description,
      status: finding.status,
      ...(finding.quote ? { quote: finding.quote } : {}),
      ...(finding.evidence
        ? {
            byteStart: finding.evidence.byteStart,
            byteEnd: finding.evidence.byteEnd,
            occurrence: finding.evidence.occurrence,
          }
        : {}),
      ...(location ? locationFields(location) : {}),
      ...(finding.waiveReason ? { waiveReason: finding.waiveReason } : {}),
      ...(finding.revisionId ? { revisionId: finding.revisionId } : {}),
    })
  })
  stages.contentCheck?.findings.forEach((finding, index) => {
    const location = finding.quote ? locateQuote(draft, finding.quote, 1, table) : null
    findings.push({
      findingId: `content-${finding.code || 'finding'}-${index + 1}`,
      source: 'content-check',
      dimension: finding.code,
      severity: finding.severity,
      description: finding.message,
      status: 'observed',
      ...(finding.quote ? { quote: finding.quote } : {}),
      ...(location ? locationFields(location) : {}),
    })
  })
  const rank = { blocking: 0, warning: 1, info: 2 } as const
  findings.sort((left, right) =>
    rank[left.severity] - rank[right.severity]
    || (left.charStart ?? Number.MAX_SAFE_INTEGER) - (right.charStart ?? Number.MAX_SAFE_INTEGER)
    || left.findingId.localeCompare(right.findingId))
  return findings
}

function locationFields(location: ReturnType<typeof resolveEvidence>): {
  charStart: number
  charEnd: number
  line: number
  matched: boolean
} {
  return {
    charStart: location.charStart,
    charEnd: location.charEnd,
    line: location.line,
    matched: location.matched,
  }
}

async function listRevisionSummaries(root: string, chapter: number): Promise<RevisionSummary[]> {
  const dir = path.join(projectPaths(root).revisions, chapterFileStem(chapter))
  const draft = await readDraft(root, chapter).catch(() => '')
  const table = buildOffsetTable(draft)
  const summaries: RevisionSummary[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.merge.json')) continue
    const candidate = await readJsonIfExists<RevisionCandidate & { selection?: RevisionSummary['selection'] }>(path.join(dir, name))
    if (!candidate) continue
    const merge = await readJsonIfExists<{ status: 'merged' | 'conflict' }>(
      path.join(dir, `${candidate.revisionId}.merge.json`),
    )
    const selection = candidate.selection
    const location = selection
      ? locateQuote(draft, selection.selectedText, selection.occurrence, table)
      : null
    summaries.push({
      revisionId: candidate.revisionId,
      createdAt: candidate.createdAt,
      status: merge ? (merge.status === 'merged' ? 'merged' : 'conflict') : 'candidate',
      paragraphs: candidate.paragraphs.length,
      findings: candidate.findings,
      baseDraftHash: candidate.baseDraftHash,
      ...(selection ? { selection } : {}),
      ...(location ? locationFields(location) : {}),
    })
  }
  summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return summaries
}

async function latestWritingRun(root: string, chapter: number): Promise<RunRecord | undefined> {
  return (await latestWritingRuns(root)).get(chapter)
}

/** Scans the runs directory once so chapter lists do not read every run per chapter. */
export async function latestWritingRuns(root: string): Promise<Map<number, RunRecord>> {
  const latest = new Map<number, RunRecord>()
  for (const name of await listFiles(projectPaths(root).runs)) {
    if (!name.endsWith('.json')) continue
    const run = await readJsonIfExists<RunRecord>(path.join(projectPaths(root).runs, name))
    if (!run || run.task !== 'writing') continue
    const current = latest.get(run.chapter)
    if (!current || run.startedAt.localeCompare(current.startedAt) > 0) latest.set(run.chapter, run)
  }
  return latest
}

async function buildContext(
  root: string,
  contract: ChapterContract | null,
  config: Awaited<ReturnType<typeof loadModelConfig>> | null,
): Promise<CockpitContext> {
  const fallback: CockpitContext = {
    model: config?.model ?? '',
    charsPerToken: config?.charsPerToken ?? 1,
    effectiveWindow: config ? effectiveContextWindow(config) : 0,
    capacityTokens: config ? contextCapacityTokens(config) : 0,
    usedTokens: 0,
    remainingTokens: config ? contextCapacityTokens(config) : 0,
    included: [],
    omitted: [],
    withheld: [],
    degraded: [],
  }
  if (!contract || !config) return fallback
  try {
    const assembled = await assembleChapterContext(root, contract, { modelConfig: config })
    const decision: MaterialDecision = assembled.decision
    const charsPerToken = assembled.context?.charsPerToken ?? config.charsPerToken
    const usedTokens = assembled.context?.estimatedTokens ?? decision.requiredTokens
    const capacityTokens = assembled.context ? decision.capacityTokens : fallback.capacityTokens
    return {
      ...fallback,
      capacityTokens,
      charsPerToken,
      usedTokens,
      remainingTokens: Math.max(0, capacityTokens - usedTokens),
      included: (assembled.context?.included ?? []).map(item => ({
        sourceId: item.sourceId,
        label: item.label,
        purpose: item.purpose,
        category: item.category,
        tokens: estimateTokens(item.text, charsPerToken),
        required: item.required,
      })),
      omitted: assembled.context?.omitted
        ?? (decision.decision === 'ready' ? decision.omitted : decision.omissions),
      withheld: assembled.context?.withheld ?? [],
      degraded: assembled.context?.degraded ?? [],
    }
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof WeaveError ? error.message : error instanceof Error ? error.message : String(error),
    }
  }
}

/** `/api/chapters/:n/context/budget`: the same assembly the cockpit uses, scoped to one chapter. */
export interface ContextBudgetView extends CockpitContext {
  chapter: number
}

export async function buildContextBudget(root: string, chapter: number): Promise<ContextBudgetView> {
  const [contract, config] = await Promise.all([
    loadContract(root, chapter).catch(() => null),
    loadModelConfig(root).catch(() => null),
  ])
  return { chapter, ...(await buildContext(root, contract, config)) }
}

function neighborsOf(status: ProjectStatus, chapter: number): { prev: number | null; next: number | null } {
  const numbers = new Set<number>([
    ...status.chapters.map(item => item.chapter),
    ...status.drafts,
    chapter,
  ])
  const sorted = [...numbers].sort((left, right) => left - right)
  const index = sorted.indexOf(chapter)
  return {
    prev: index > 0 ? sorted[index - 1]! : null,
    next: index >= 0 && index < sorted.length - 1 ? sorted[index + 1]! : null,
  }
}

export async function buildChapterGates(root: string, chapter: number): Promise<GateReport> {
  const [contract, draft, stages] = await Promise.all([
    loadContract(root, chapter).catch(() => null),
    readDraft(root, chapter).catch(() => ''),
    loadStages(root, chapter),
  ])
  return buildGates(root, chapter, contract, draft, stages)
}

async function buildGates(
  root: string,
  chapter: number,
  contract: ChapterContract | null,
  draft: string,
  stages: LoadedStages,
): Promise<GateReport> {
  const gates: GateView[] = []
  const add = (id: string, label: string, ok: boolean, detail: string): void => {
    gates.push({ id, label, ok, detail })
  }
  if (contract) add('contract', '合同存在', true, contract.title)
  else add('contract', '合同存在', false, `第 ${chapter} 章合同缺失`)

  if (contract) {
    try {
      await requirePassingContractCheck(root, contract)
      add('contract-check', '合同检查', true, '通过且未过期')
    } catch (error) {
      add('contract-check', '合同检查', false, error instanceof Error ? error.message : String(error))
    }
  }

  const hash = draftHash(draft)
  add('draft', '草稿存在', Boolean(draft.trim()), `${countProseChars(draft)} 字`)
  add(
    'content-check',
    '内容检查',
    Boolean(stages.contentCheck && stages.contentCheck.draftHash === hash && stages.contentCheck.passed),
    stages.contentCheck ? `draft ${stages.contentCheck.draftHash.slice(0, 8)}` : '缺失',
  )
  add(
    'extraction',
    '证据抽取',
    Boolean(stages.extraction && stages.extraction.draftHash === hash && stages.extraction.passed),
    stages.extraction ? `${stages.extraction.records.length} 条记录` : '缺失',
  )
  add(
    'audit',
    '覆盖审计',
    Boolean(stages.audit && stages.audit.draftHash === hash && stages.audit.passed),
    stages.audit ? `覆盖 ${stages.audit.contract.covered.length} 项` : '缺失',
  )
  add(
    'review',
    '审查',
    Boolean(stages.review && stages.review.draftHash === hash && stages.review.passed),
    stages.review ? `${stages.review.findings.length} 条意见` : '缺失',
  )
  try {
    await assertNoPendingImpacts(root)
    add('impact', '影响面', true, '没有未处理影响')
  } catch (error) {
    add('impact', '影响面', false, error instanceof Error ? error.message : String(error))
  }
  try {
    await assertProjectionCurrent(root)
    add('content-projection', '内容投影', true, 'current')
  } catch (error) {
    add('content-projection', '内容投影', false, error instanceof Error ? error.message : String(error))
  }
  try {
    await assertLedgerProjectionCurrent(root)
    add('ledger-projection', '账本投影', true, 'current')
  } catch (error) {
    add('ledger-projection', '账本投影', false, error instanceof Error ? error.message : String(error))
  }
  return { chapter, ready: gates.every(gate => gate.ok), gates }
}
