import type { ChapterContract } from './types.ts'
import type {
  CoverageAudit,
  CoverageSegment,
  ExtractedRecord,
  ExtractionReport,
  TimelineReport,
} from './stage-types.ts'
import { loadCharacters } from './contract.ts'
import { validateTimeline } from './timeline.ts'
import { draftHash, saveStage } from './stages.ts'
import { objectHash } from './hash.ts'
import { conflictError } from './errors.ts'

export async function runCoverageAudit(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  extraction: ExtractionReport,
): Promise<CoverageAudit> {
  const segments = paragraphSegments(draft)
  for (const segment of segments) {
    for (const record of extraction.records) {
      if (record.evidence.some(span => overlaps(span.byteStart, span.byteEnd, segment.startByte, segment.endByte))) {
        if (!segment.coveredBy.includes(record.recordId)) segment.coveredBy.push(record.recordId)
      }
    }
  }
  const uncoveredSegments = segments.filter(segment => segment.coveredBy.length === 0)
  const planned = contract.mustHappen.filter(Boolean)
  const covered = planned.filter(node => coveredByText(draft, extraction.records, node))
  const missed = planned.filter(node => !covered.includes(node))
  const unplanned = extraction.records
    .filter(record => record.kind === 'event')
    .filter(record => !planned.some(node =>
      record.summary.includes(node)
      || record.evidence.some(span => span.quote.includes(node)),
    ))
    .map(record => record.recordId)
  const registry = await loadCharacters(root)
  const timeline = validateTimeline(extraction.records.length > 0
    ? timelineFromExtraction(extraction, chapter)
    : [], registry)
  const warnings: string[] = []
  if (uncoveredSegments.length > 0) warnings.push(`有 ${uncoveredSegments.length} 个段落没有证据覆盖`)
  if (unplanned.length > 5) warnings.push(`有 ${unplanned.length} 条未列入合同的事件，需人工确认`)
  warnings.push(...timeline.warnings)

  const audit: CoverageAudit = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    extractionHash: objectHash(extraction),
    segments,
    contract: { planned, covered, missed, unplanned },
    uncoveredSegments,
    noEventsReason: extraction.noEventsReason,
    timeline,
    warnings,
    passed:
      extraction.passed
      && missed.length === 0
      && timeline.passed
      && (extraction.records.length > 0 || Boolean(extraction.noEventsReason)),
  }
  await saveStage(root, 'audit', chapter, audit)
  return audit
}

export async function runTimelineReport(
  root: string,
  chapter: number,
  draft: string,
  extraction: ExtractionReport,
): Promise<TimelineReport> {
  if (extraction.draftHash !== draftHash(draft)) {
    throw conflictError('抽取报告绑定的草稿已变化；请重新运行 weave extract')
  }
  const registry = await loadCharacters(root)
  const check = validateTimeline(timelineFromExtraction(extraction, chapter), registry)
  const report: TimelineReport = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    events: check.events,
    errors: check.errors,
    warnings: check.warnings,
    passed: check.passed,
  }
  await saveStage(root, 'timeline', chapter, report)
  return report
}

function timelineFromExtraction(extraction: ExtractionReport, chapter: number) {
  return (extraction.timeline ?? []).map(event => ({ ...event, chapter }))
}

function paragraphSegments(draft: string): CoverageSegment[] {
  const segments: CoverageSegment[] = []
  const pattern = /[^\n]+/g
  let cursor = 0
  for (const match of draft.matchAll(pattern)) {
    const text = match[0]
    const index = draft.indexOf(text, cursor)
    if (index < 0) continue
    const startByte = Buffer.byteLength(draft.slice(0, index), 'utf8')
    segments.push({
      startByte,
      endByte: startByte + Buffer.byteLength(text, 'utf8'),
      coveredBy: [],
    })
    cursor = index + text.length
  }
  return segments
}

function coveredByText(draft: string, records: ExtractedRecord[], node: string): boolean {
  if (draft.includes(node)) return true
  return records.some(record =>
    record.summary.includes(node)
    || record.evidence.some(span => span.quote.includes(node))
    || JSON.stringify(record.payload).includes(node),
  )
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
