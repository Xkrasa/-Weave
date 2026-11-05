import type { RunUsage } from './types.ts'

export type StageKind = 'content-check' | 'extraction' | 'audit' | 'review' | 'timeline'

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
  records: ExtractedRecord[]
  timeline: TimelineEvent[]
  rejected: RejectedRecord[]
  model: string
  usage?: RunUsage
  passed: boolean
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
  uncoveredSegments: CoverageSegment[]
  noEventsReason: string | null
  timeline: TimelineCheck
  secondPass: {
    summary: string
    missed: string[]
    rejected: string[]
  }
  warnings: string[]
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
  status: 'open' | 'waived'
  waiveReason?: string
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
