import type { ChapterContract, ModelConfig } from './types.ts'
import type {
  EvidenceSpan,
  ExtractedRecord,
  ExtractionReport,
  RejectedRecord,
  TimelineEvent,
} from './stage-types.ts'
import { completeText } from './model.ts'
import { draftHash, parseJsonObject, resolveEvidence, saveStage } from './stages.ts'
import { validationError } from './errors.ts'

const SYSTEM_PROMPT = [
  '你是小说事实抽取器，不是写作模型。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 代码围栏或额外文字。',
  '每条记录必须有至少一条原文证据。引文必须从正文逐字复制，不得改写、补全或拼接。',
  '无法确定的内容不要编造；本章确实没有状态变化时填写 noEventsReason。',
].join('\n')

export async function runExtraction(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<ExtractionReport> {
  const model = config.extractionModel ?? config.model
  const prompt = [
    `第 ${chapter} 章合同：`,
    JSON.stringify(contract, null, 2),
    '',
    '正文：',
    draft,
    '',
    '输出结构：',
    JSON.stringify({
      summary: '本章发生了什么，200 字以内',
      noEventsReason: null,
      records: [{
        recordId: 'r1',
        kind: 'event',
        summary: '一条可验证的事件或状态变化',
        participants: ['人物名'],
        location: '地点',
        storyTime: '第 X 天或日期',
        payload: { changes: [] },
        evidence: [{ quote: '正文中的逐字引文', occurrence: 1 }],
      }],
      timeline: [{
        eventId: 'e1',
        recordId: 'r1',
        summary: '时间线事件',
        storyDate: '2026-01-01',
        dayOffset: 0,
        durationDays: 0,
        participants: ['人物名'],
        causedBy: [],
        type: 'main',
        evidence: [{ quote: '正文中的逐字引文', occurrence: 1 }],
      }],
    }, null, 2),
  ].join('\n')

  const result = await completeText({ config: { ...config, model }, system: SYSTEM_PROMPT, user: prompt, signal })
  const raw = parseJsonObject(result.text)
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('抽取结果缺少 summary')
  const noEventsReason = typeof raw.noEventsReason === 'string' && raw.noEventsReason.trim()
    ? raw.noEventsReason.trim()
    : null
  const recordsRaw = Array.isArray(raw.records) ? raw.records : []
  const timelineRaw = Array.isArray(raw.timeline) ? raw.timeline : []
  const rejected: RejectedRecord[] = []
  const records: ExtractedRecord[] = []
  const seenRecordIds = new Set<string>()
  const evidenceByRecord = new Map<string, EvidenceSpan[]>()

  recordsRaw.forEach((item, index) => {
    const recordRaw = objectOrNull(item)
    if (!recordRaw) {
      rejected.push({ reason: '记录不是对象', raw: item })
      return
    }
    const recordId = typeof recordRaw.recordId === 'string' && recordRaw.recordId.trim()
      ? recordRaw.recordId.trim()
      : `r${index + 1}`
    if (seenRecordIds.has(recordId)) {
      rejected.push({ recordId, reason: 'recordId 重复', raw: item })
      return
    }
    const kind = recordRaw.kind === 'state_change' ? 'state_change' : 'event'
    const recordSummary = typeof recordRaw.summary === 'string' ? recordRaw.summary.trim() : ''
    if (!recordSummary) {
      rejected.push({ recordId, reason: '缺少 summary', raw: item })
      return
    }
    const rejectedBefore = rejected.length
    const evidence = resolveEvidenceList(draft, chapter, recordRaw.evidence, recordId, rejected)
    if (evidence.length === 0 || rejected.length > rejectedBefore) {
      rejected.push({ recordId, reason: '记录存在无效证据，整条记录被拒绝', raw: item })
      return
    }
    const record: ExtractedRecord = {
      recordId,
      kind,
      summary: recordSummary,
      participants: stringArray(recordRaw.participants),
      payload: objectOrNull(recordRaw.payload) ?? {},
      evidence,
    }
    if (typeof recordRaw.location === 'string' && recordRaw.location.trim()) record.location = recordRaw.location.trim()
    if (typeof recordRaw.storyTime === 'string' && recordRaw.storyTime.trim()) record.storyTime = recordRaw.storyTime.trim()
    seenRecordIds.add(recordId)
    records.push(record)
    evidenceByRecord.set(recordId, evidence)
  })

  const timeline: TimelineEvent[] = []
  const seenTimelineIds = new Set<string>()
  timelineRaw.forEach((item, index) => {
    const eventRaw = objectOrNull(item)
    if (!eventRaw) {
      rejected.push({ reason: '时间线事件不是对象', raw: item })
      return
    }
    const eventId = typeof eventRaw.eventId === 'string' && eventRaw.eventId.trim()
      ? eventRaw.eventId.trim()
      : `e${index + 1}`
    if (seenTimelineIds.has(eventId)) {
      rejected.push({ reason: `时间线 eventId 重复：${eventId}`, raw: item })
      return
    }
    const recordId = typeof eventRaw.recordId === 'string' ? eventRaw.recordId : undefined
    const rejectedBefore = rejected.length
    let evidence = resolveEvidenceList(draft, chapter, eventRaw.evidence, eventId, rejected)
    if (evidence.length === 0 && recordId) evidence = evidenceByRecord.get(recordId) ?? []
    const eventSummary = typeof eventRaw.summary === 'string' ? eventRaw.summary.trim() : ''
    if (!eventSummary || evidence.length === 0 || rejected.length > rejectedBefore) {
      rejected.push({ reason: `时间线事件 ${eventId} 缺少 summary 或存在无效证据`, raw: item })
      return
    }
    const type = eventRaw.type === 'flashback' || eventRaw.type === 'parallel' ? eventRaw.type : 'main'
    const event: TimelineEvent = {
      eventId,
      chapter,
      summary: eventSummary,
      participants: stringArray(eventRaw.participants),
      causedBy: stringArray(eventRaw.causedBy),
      type,
      evidence,
    }
    if (recordId) event.recordId = recordId
    if (typeof eventRaw.storyDate === 'string' && eventRaw.storyDate.trim()) event.storyDate = eventRaw.storyDate.trim()
    if (typeof eventRaw.dayOffset === 'number' && Number.isSafeInteger(eventRaw.dayOffset)) event.dayOffset = eventRaw.dayOffset
    if (typeof eventRaw.durationDays === 'number' && Number.isSafeInteger(eventRaw.durationDays)) event.durationDays = eventRaw.durationDays
    if (typeof eventRaw.season === 'string' && eventRaw.season.trim()) event.season = eventRaw.season.trim()
    const ages = objectOrNull(eventRaw.ages)
    if (ages) {
      event.ages = Object.fromEntries(
        Object.entries(ages).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      )
    }
    seenTimelineIds.add(eventId)
    timeline.push(event)
  })

  if (records.length === 0 && !noEventsReason) {
    rejected.push({ reason: '没有抽取到记录，且未提供 noEventsReason', raw: null })
  }

  const report: ExtractionReport = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    summary,
    noEventsReason,
    records,
    timeline,
    rejected,
    model,
    usage: result.usage,
    passed: rejected.length === 0,
  }
  await saveStage(root, 'extraction', chapter, report)
  return report
}

function resolveEvidenceList(
  draft: string,
  chapter: number,
  raw: unknown,
  owner: string,
  rejected: RejectedRecord[],
): EvidenceSpan[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const spans: EvidenceSpan[] = []
  for (const item of raw) {
    const evidenceRaw = objectOrNull(item)
    if (!evidenceRaw || typeof evidenceRaw.quote !== 'string') {
      rejected.push({ recordId: owner, reason: '证据缺少 quote', raw: item })
      continue
    }
    try {
      const span = resolveEvidence(
        draft,
        chapter,
        evidenceRaw.quote,
        typeof evidenceRaw.occurrence === 'number' ? evidenceRaw.occurrence : undefined,
      )
      if (evidenceRaw.byteStart !== undefined && evidenceRaw.byteStart !== span.byteStart) {
        throw validationError('模型提供的 byteStart 与正文不一致')
      }
      if (evidenceRaw.byteEnd !== undefined && evidenceRaw.byteEnd !== span.byteEnd) {
        throw validationError('模型提供的 byteEnd 与正文不一致')
      }
      if (evidenceRaw.excerptHash !== undefined && evidenceRaw.excerptHash !== span.excerptHash) {
        throw validationError('模型提供的 excerptHash 与正文不一致')
      }
      spans.push(span)
    } catch (error) {
      rejected.push({
        recordId: owner,
        reason: error instanceof Error ? error.message : String(error),
        raw: item,
      })
    }
  }
  return spans
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
