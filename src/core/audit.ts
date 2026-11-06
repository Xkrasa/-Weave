import type { ChapterContract, ModelConfig } from './types.ts'
import type {
  CoverageAudit,
  CoverageSegment,
  ExtractedRecord,
  ExtractionReport,
  TimelineReport,
} from './stage-types.ts'
import { loadCharacters } from './contract.ts'
import { deriveExpectedDimensions, evaluateDimensions } from './extraction.ts'
import { validateTimeline } from './timeline.ts'
import { draftHash, resolveEvidence, saveStage } from './stages.ts'
import { objectHash } from './hash.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { conflictError, validationError } from './errors.ts'

const AUDIT_SYSTEM_PROMPT = [
  '你是覆盖审计器，只寻找第一遍抽取漏掉的重要事件、状态变化、时间表达和合同节点。',
  '不要重复第一遍已经列出的事件，不要编造正文中没有的内容。',
  '只输出一个 JSON 对象，不要输出解释或 Markdown 围栏。',
].join('\n')

export async function runCoverageAudit(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  extraction: ExtractionReport,
  config: ModelConfig,
  signal: AbortSignal,
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
  const covered = planned.filter(node => coveredByRecords(extraction.records, node))
  const missed = planned.filter(node => !covered.includes(node))
  const unplanned = extraction.records
    .filter(record => record.kind === 'event')
    .filter(record => !planned.some(node =>
      record.summary.includes(node)
      || record.evidence.some(span => span.quote.includes(node)),
    ))
    .map(record => record.recordId)
  const expectedDimensions = await deriveExpectedDimensions(root, contract)
  const dimensions = evaluateDimensions(expectedDimensions, extraction)
  const registry = await loadCharacters(root)
  const timeline = validateTimeline(extraction.timeline ?? [], registry)
  const secondPass = await runSecondPass(root, chapter, contract, draft, extraction, config, signal)
  const warnings: string[] = []
  if (uncoveredSegments.length > 0) warnings.push(`有 ${uncoveredSegments.length} 个段落没有证据覆盖`)
  if (unplanned.length > 5) warnings.push(`有 ${unplanned.length} 条未列入合同的事件，需人工确认`)
  if (dimensions.missed.length > 0) warnings.push(`未交代必检维度：${dimensions.missed.join('、')}`)
  warnings.push(...timeline.warnings)

  const audit: CoverageAudit = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    extractionHash: objectHash(extraction),
    segments,
    contract: { planned, covered, missed, unplanned },
    dimensions,
    uncoveredSegments,
    noEventsReason: extraction.noEventsReason,
    timeline,
    secondPass,
    warnings,
    passed:
      extraction.passed
      && missed.length === 0
      && dimensions.missed.length === 0
      && timeline.passed
      && secondPass.missed.length === 0
      && secondPass.rejected.length === 0
      && (extraction.records.length > 0 || Boolean(extraction.noEventsReason)),
  }
  await saveStage(root, 'audit', chapter, audit)
  return audit
}

async function runSecondPass(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  extraction: ExtractionReport,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<{ summary: string; missed: string[]; rejected: string[] }> {
  const taskConfig = resolveTaskConfig(config, 'extraction')
  const model = taskConfig.model
  const prompt = [
    `第 ${chapter} 章合同：`,
    JSON.stringify(contract, null, 2),
    '',
    '第一遍记录摘要：',
    JSON.stringify(extraction.records.map(record => ({
      recordId: record.recordId,
      summary: record.summary,
      quote: record.evidence.map(span => span.quote),
    })), null, 2),
    '',
    '正文：',
    draft,
    '',
    '只输出结构：',
    JSON.stringify({
      summary: '第二遍审计结论',
      missed: [{ summary: '第一遍漏掉的事件', quote: '正文逐字引文', occurrence: 1 }],
    }, null, 2),
  ].join('\n')
  const result = await completeJsonObject({
    config: { ...taskConfig, model },
    system: AUDIT_SYSTEM_PROMPT,
    user: prompt,
    signal,
  })
  await appendUsage(root, { task: 'extraction', model, usage: result.usage })
  const raw = result.raw
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('覆盖审计结果缺少 summary')
  const rawMissed = Array.isArray(raw.missed) ? raw.missed : []
  const missed: string[] = []
  const rejected: string[] = []
  for (const item of rawMissed) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (!entry || typeof entry.summary !== 'string' || typeof entry.quote !== 'string') {
      rejected.push('第二遍返回了缺少 summary 或 quote 的遗漏项')
      continue
    }
    try {
      resolveEvidence(
        draft,
        chapter,
        entry.quote,
        typeof entry.occurrence === 'number' ? entry.occurrence : undefined,
      )
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : String(error))
      continue
    }
    missed.push(entry.summary.trim())
  }
  return { summary, missed, rejected }
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
  const check = validateTimeline(extraction.timeline ?? [], registry)
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

function coveredByRecords(records: ExtractedRecord[], node: string): boolean {
  return records.some(record =>
    record.summary.includes(node)
    || record.evidence.some(span => span.quote.includes(node))
    || JSON.stringify(record.payload).includes(node),
  )
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
