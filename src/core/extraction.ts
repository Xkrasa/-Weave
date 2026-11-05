import type { BeliefAttitude, ChapterContract, LedgerBelief, LedgerFact, LoopChange, ModelConfig } from './types.ts'
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
import { eventIdFor, normalizeAttitude } from './story-ledger.ts'
import { hashText } from './hash.ts'

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
      facts: [{
        factId: 'fact-1',
        subject: '人物名',
        predicate: 'location',
        object: '地点',
        validFromChapter: chapter,
        validToChapter: null,
        sourceRecordId: 'r1',
        origin: 'derived',
        supersedes: null,
        confidence: 0.9,
        evidence: [{ quote: '正文中的逐字引文', occurrence: 1 }],
      }],
      beliefs: [{
        beliefId: 'belief-1',
        characterId: '人物名',
        proposition: '账本缺页',
        attitude: 'knows',
        sourceRecordId: 'r1',
        learnedAtChapter: chapter,
        confidence: 0.9,
        validFromChapter: chapter,
        validToChapter: null,
        evidence: [{ quote: '正文中的逐字引文', occurrence: 1 }],
      }],
      loops: [{
        loopId: 'loop-1',
        kind: 'plant',
        summary: '账本缺页的来源',
        targetFromChapter: chapter + 2,
        targetToChapter: chapter + 5,
        relatedEntities: ['人物名'],
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
    const kind = recordRaw.kind === 'state_change' ? 'state_change' : 'event'
    const recordSummary = typeof recordRaw.summary === 'string' ? recordRaw.summary.trim() : ''
    const recordId = typeof recordRaw.recordId === 'string' && recordRaw.recordId.trim()
      ? recordRaw.recordId.trim()
      : `r-${hashText(recordSummary || `record-${index + 1}`).slice(7, 19)}`
    if (seenRecordIds.has(recordId)) {
      rejected.push({ recordId, reason: 'recordId 重复', raw: item })
      return
    }
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

  const facts: LedgerFact[] = []
  const seenFactIds = new Set<string>()
  const factsRaw = Array.isArray(raw.facts) ? raw.facts : []
  factsRaw.forEach((item, index) => {
    const factRaw = objectOrNull(item)
    if (!factRaw) {
      rejected.push({ reason: '事实记录不是对象', raw: item })
      return
    }
    const factId = typeof factRaw.factId === 'string' && factRaw.factId.trim()
      ? factRaw.factId.trim()
      : `fact-${chapter}-${index + 1}`
    if (seenFactIds.has(factId)) {
      rejected.push({ recordId: factId, reason: '事实 ID 重复', raw: item })
      return
    }
    const subject = typeof factRaw.subject === 'string' ? factRaw.subject.trim() : ''
    const predicate = typeof factRaw.predicate === 'string' ? factRaw.predicate.trim() : ''
    const object = typeof factRaw.object === 'string' ? factRaw.object.trim() : ''
    if (!subject || !predicate || !object) {
      rejected.push({ recordId: factId, reason: '事实缺少 subject/predicate/object', raw: item })
      return
    }
    const before = rejected.length
    const evidence = resolveEvidenceList(draft, chapter, factRaw.evidence, factId, rejected)
    if (evidence.length === 0 || rejected.length > before) {
      rejected.push({ recordId: factId, reason: '事实存在无效证据', raw: item })
      return
    }
    const sourceRecordId = typeof factRaw.sourceRecordId === 'string' ? factRaw.sourceRecordId : undefined
    const sourceEvent = typeof factRaw.sourceEvent === 'string'
      ? factRaw.sourceEvent
      : sourceRecordId ? eventIdFor(chapter, sourceRecordId) : undefined
    const validFromChapter = typeof factRaw.validFromChapter === 'number' ? factRaw.validFromChapter : chapter
    const validToChapter = typeof factRaw.validToChapter === 'number' ? factRaw.validToChapter : null
    const origin = factRaw.origin === 'author' || factRaw.origin === 'candidate' ? factRaw.origin : 'derived'
    const supersedes = typeof factRaw.supersedes === 'string' ? factRaw.supersedes : null
    facts.push({
      factId,
      chapter,
      subject,
      predicate,
      object,
      validFromChapter,
      validToChapter,
      sourceEvent,
      origin,
      supersedes,
      confidence: typeof factRaw.confidence === 'number' ? factRaw.confidence : 1,
      evidence,
    })
    seenFactIds.add(factId)
  })

  const beliefs: LedgerBelief[] = []
  const seenBeliefIds = new Set<string>()
  const beliefsRaw = Array.isArray(raw.beliefs) ? raw.beliefs : []
  beliefsRaw.forEach((item, index) => {
    const beliefRaw = objectOrNull(item)
    if (!beliefRaw) {
      rejected.push({ reason: '信念记录不是对象', raw: item })
      return
    }
    const beliefId = typeof beliefRaw.beliefId === 'string' && beliefRaw.beliefId.trim()
      ? beliefRaw.beliefId.trim()
      : `belief-${chapter}-${index + 1}`
    const characterId = typeof beliefRaw.characterId === 'string' ? beliefRaw.characterId.trim() : ''
    const proposition = typeof beliefRaw.proposition === 'string' ? beliefRaw.proposition.trim() : ''
    if (seenBeliefIds.has(beliefId) || !characterId || !proposition) {
      rejected.push({ recordId: beliefId, reason: '信念 ID 重复或缺少 characterId/proposition', raw: item })
      return
    }
    const before = rejected.length
    const evidence = resolveEvidenceList(draft, chapter, beliefRaw.evidence, beliefId, rejected)
    if (evidence.length === 0 || rejected.length > before) {
      rejected.push({ recordId: beliefId, reason: '信念存在无效证据', raw: item })
      return
    }
    const attitude = normalizeAttitude(beliefRaw.attitude)
    if (!attitude) {
      rejected.push({ recordId: beliefId, reason: '信念态度非法', raw: item })
      return
    }
    const sourceRecordId = typeof beliefRaw.sourceRecordId === 'string' ? beliefRaw.sourceRecordId : undefined
    const sourceEvent = typeof beliefRaw.sourceEvent === 'string'
      ? beliefRaw.sourceEvent
      : sourceRecordId ? eventIdFor(chapter, sourceRecordId) : undefined
    const validFromChapter = typeof beliefRaw.validFromChapter === 'number'
      ? beliefRaw.validFromChapter
      : typeof beliefRaw.learnedAtChapter === 'number' ? beliefRaw.learnedAtChapter : chapter
    beliefs.push({
      beliefId,
      chapter,
      characterId,
      proposition,
      attitude,
      sourceEvent,
      learnedAtChapter: typeof beliefRaw.learnedAtChapter === 'number' ? beliefRaw.learnedAtChapter : chapter,
      confidence: typeof beliefRaw.confidence === 'number' ? beliefRaw.confidence : 1,
      validFromChapter,
      validToChapter: typeof beliefRaw.validToChapter === 'number' ? beliefRaw.validToChapter : null,
      evidence,
    })
    seenBeliefIds.add(beliefId)
  })

  const loops: LoopChange[] = []
  const loopsRaw = Array.isArray(raw.loops) ? raw.loops : []
  loopsRaw.forEach((item, index) => {
    const loopRaw = objectOrNull(item)
    if (!loopRaw) {
      rejected.push({ reason: '伏笔变化不是对象', raw: item })
      return
    }
    const loopId = typeof loopRaw.loopId === 'string' && loopRaw.loopId.trim()
      ? loopRaw.loopId.trim()
      : `loop-${chapter}-${index + 1}`
    const kind = loopRaw.kind
    if (kind !== 'plant' && kind !== 'advance' && kind !== 'payoff' && kind !== 'abandon') {
      rejected.push({ recordId: loopId, reason: '伏笔变化 kind 非法', raw: item })
      return
    }
    const summary = typeof loopRaw.summary === 'string' ? loopRaw.summary.trim() : ''
    if (!summary) {
      rejected.push({ recordId: loopId, reason: '伏笔变化缺少 summary', raw: item })
      return
    }
    const before = rejected.length
    const evidence = resolveEvidenceList(draft, chapter, loopRaw.evidence, loopId, rejected)
    if (evidence.length === 0 || rejected.length > before) {
      rejected.push({ recordId: loopId, reason: '伏笔变化存在无效证据', raw: item })
      return
    }
    loops.push({
      loopId,
      kind,
      chapter,
      summary,
      targetFromChapter: typeof loopRaw.targetFromChapter === 'number' ? loopRaw.targetFromChapter : undefined,
      targetToChapter: typeof loopRaw.targetToChapter === 'number' ? loopRaw.targetToChapter : undefined,
      relatedEntities: stringArray(loopRaw.relatedEntities),
      reason: typeof loopRaw.reason === 'string' ? loopRaw.reason : undefined,
      evidence,
    })
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
    facts,
    beliefs,
    loops,
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
