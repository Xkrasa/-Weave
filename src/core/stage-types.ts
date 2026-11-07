import type { LedgerBelief, LedgerFact, LoopChange, RunUsage } from './types.ts'

export type StageKind = 'content-check' | 'extraction' | 'audit' | 'review' | 'effect-review' | 'timeline'

export interface EvidenceSpan {
  sourceId: string
  sourceContentHash: string
  byteStart: number
  byteEnd: number
  quote: string
  excerptHash: string
  occurrence: number
}

export interface ExtractedRecord {
  recordId: string
  kind: 'event' | 'state_change'
  dimension?: string
  summary: string
  participants: string[]
  location?: string
  storyTime?: string
  payload: Record<string, unknown>
  evidence: EvidenceSpan[]
}

export interface RejectedRecord {
  recordId?: string
  reason: string
  raw: unknown
}

export interface ExtractionReport {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  summary: string
  noEventsReason: string | null
  dimensions?: Record<string, string>
  records: ExtractedRecord[]
  timeline: TimelineEvent[]
  facts: LedgerFact[]
  beliefs: LedgerBelief[]
  loops: LoopChange[]
  rejected: RejectedRecord[]
  /** 与账本冲突、待作者裁决的记录：不是被丢弃，而是被扣下。 */
  pending: PendingRecord[]
  model: string
  usage?: RunUsage
  passed: boolean
}

export interface PendingRecord {
  pendingId: string
  chapter: number
  subject: string
  predicate: string
  object: string
  quote: string
  conflictWith: string
  priorObject: string
  reason: 'contradicts-ledger'
  raw: unknown
  createdAt: string
}

export interface TimelineEvent {
  eventId: string
  recordId?: string
  chapter: number
  summary: string
  storyDate?: string
  dayOffset?: number
  durationDays?: number
  participants: string[]
  causedBy: string[]
  type: 'main' | 'flashback' | 'parallel'
  season?: string
  ages?: Record<string, number>
  evidence: EvidenceSpan[]
}

export interface TimelineCheck {
  events: TimelineEvent[]
  errors: string[]
  warnings: string[]
  passed: boolean
}

export interface CoverageSegment {
  startByte: number
  endByte: number
  coveredBy: string[]
}

export interface CoverageAudit {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  extractionHash: string
  segments: CoverageSegment[]
  contract: {
    planned: string[]
    covered: string[]
    missed: string[]
    unplanned: string[]
  }
  dimensions?: {
    expected: string[]
    covered: string[]
    missed: string[]
  }
  uncoveredSegments: CoverageSegment[]
  noEventsReason: string | null
  timeline: TimelineCheck
  secondPass: {
    summary: string
    missed: string[]
    rejected: string[]
  }
  warnings: string[]
  quantityBreaks: import('./types.ts').QuantityBreak[]
  passed: boolean
}

export interface TimelineReport {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  events: TimelineEvent[]
  errors: string[]
  warnings: string[]
  passed: boolean
}

export interface ContentFinding {
  severity: 'blocking' | 'warning' | 'info'
  code: string
  message: string
  quote?: string
}

export interface ContentCheckReport {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  findings: ContentFinding[]
  stats: {
    characters: number
    targetWords: number
    deviation: number
    duplicateHits: number
  }
  passed: boolean
}

export interface ReviewFinding {
  findingId: string
  dimension: string
  severity: 'blocking' | 'warning' | 'info'
  description: string
  quote?: string
  evidence?: EvidenceSpan
  status: 'open' | 'planned' | 'applied' | 'verified' | 'ignored' | 'waived'
  paragraphIds?: string[]
  entityRefs?: string[]
  storylineRefs?: string[]
  waiveReason?: string
  ignoreReason?: string
  revisionId?: string
  recheckedAt?: string
  recheckNote?: string
}

export interface ReviewReport {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  extractionHash: string
  auditHash: string
  summary: string
  findings: ReviewFinding[]
  blockingCount: number
  model: string
  usage?: RunUsage
  passed: boolean
}

export interface DraftParagraph {
  paragraphId: string
  text: string
  findingIds?: string[]
}

export interface RevisionInstruction {
  findingId: string
  paragraphIds: string[]
  goal: string
}

export interface RevisionCandidate {
  schemaVersion: 1
  revisionId: string
  chapter: number
  baseDraftHash: string
  createdAt: string
  model: string
  usage?: RunUsage
  raw?: string
  findings: string[]
  instructions: RevisionInstruction[]
  contextMode?: 'legacy' | 'enriched'
  baseParagraphs: DraftParagraph[]
  paragraphs: DraftParagraph[]
  rejected: Array<{ paragraphId?: string; reason: string }>
}

export interface MergeHunk {
  paragraphId: string
  base: string
  revision: string
  manual: string
  status: 'auto' | 'conflict' | 'manual-only' | 'revision-only'
  resolution?: 'base' | 'revision' | 'manual'
  findingIds: string[]
}

export interface MergeReport {
  schemaVersion: 1
  chapter: number
  revisionId: string
  createdAt: string
  status: 'merged' | 'conflict'
  baseDraftHash: string
  mergedDraftHash: string | null
  hunks: MergeHunk[]
}
