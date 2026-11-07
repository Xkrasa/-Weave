import type { ChapterContract, LedgerBelief, LedgerFact, LoopChange, ModelConfig } from './types.ts'
import type {
  EvidenceSpan,
  ExtractedRecord,
  ExtractionReport,
  PendingRecord,
  RejectedRecord,
  TimelineEvent,
} from './stage-types.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { draftHash, resolveEvidence, saveStage } from './stages.ts'
import { validationError } from './errors.ts'
import { collectLedger, collectLoopState, effectiveFacts, eventIdFor, normalizeAttitude } from './story-ledger.ts'
import { hashText } from './hash.ts'

const SYSTEM_PROMPT = [
  '你是小说事实抽取器，不是写作模型。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 代码围栏或额外文字。',
  '每条记录必须有至少一条原文证据。引文必须从正文逐字复制，不得改写、补全或拼接。',
  '无法确定的内容不要编造；本章确实没有状态变化时填写 noEventsReason。',
  '正文没写的不补、不猜：记录只能来自本章正文实际写出的内容，不得依据合同、常识或前情补齐正文没有的情节。',
  '推不出来的数不编：数量、金额、距离、时距等数值只有正文明确写出才记录；推不出来就不记，宁缺不凑。',
  '正文与合同或必检维度不一致时，按正文如实记录并在 summary 指出差异；不得为迎合合同改写事实，也不得擅自裁决以哪边为准。',
  '数值类事实（银两、灵石、库存等）必须给出 quantity：delta 与 balance 都用整数最小单位（不用小数）；基线不明时 balance 填 null 且 unverified 为 true，禁止反推结余。',
  '对于提示中列出的每个必检维度（expectedDimensions），必须在对应结构字段（records/facts/beliefs/loops）中给出带证据的变化，或在 dimensions 对象中显式说明“unchanged: 具体原因”。',
  '不得用 unchanged 掩盖正文中实际发生的变化；没有具体原因的空声明视为未交代。',
].join('\n')

const POSSESSION_TRIGGER_PATTERN = /拿到|交出|交给|夺走|递给|易手|偷走|丢失|换取|归还/
const KNOWLEDGE_TRIGGER_PATTERN = /秘密|得知|发现真相|获知|认出|偷听|揭穿/
const STATUS_TRIGGER_PATTERN = /受伤|死亡|昏迷|被捕|中毒|晋升|突破|残废/
const RELATIONSHIP_TRIGGER_PATTERN = /决裂|结盟|背叛|立誓|反目|和解|拜师/
const LOOP_TRIGGER_PATTERN = /伏笔|回收|揭晓悬念/

export async function deriveExpectedDimensions(root: string, contract: ChapterContract): Promise<string[]> {
  const expected = new Set<string>(['event'])
  const priorChapter = Math.max(0, contract.chapter - 1)
  const ledger = priorChapter > 0 ? await collectLedger(root, priorChapter) : { events: [], facts: [], beliefs: [] }
  const activeFacts = priorChapter > 0 ? effectiveFacts(ledger.facts, priorChapter) : []
  const chapterCharacters = new Set(contract.characters)
  const characterFacts = activeFacts.filter(fact => chapterCharacters.has(fact.subject))

  if (contract.location.trim() || characterFacts.some(fact => fact.predicate === 'location')) {
    expected.add('location')
  }

  const contractText = [contract.goal, contract.obstacle, ...contract.mustHappen].join(' ')
  const mustHappenText = contract.mustHappen.join(' ')

  if (
    POSSESSION_TRIGGER_PATTERN.test(contractText)
    || characterFacts.some(fact => fact.predicate === 'possession')
  ) {
    expected.add('possession')
  }

  if (
    (contract.knowledge?.length ?? 0) > 0
    || KNOWLEDGE_TRIGGER_PATTERN.test(mustHappenText)
  ) {
    expected.add('knowledge')
  }

  if (
    STATUS_TRIGGER_PATTERN.test(mustHappenText)
    || characterFacts.some(fact => ['status', 'condition', 'injury', 'health'].includes(fact.predicate))
  ) {
    expected.add('status')
  }

  if (
    RELATIONSHIP_TRIGGER_PATTERN.test(mustHappenText)
    || characterFacts.some(fact => fact.predicate === 'relationship')
  ) {
    expected.add('relationship')
  }

  if (LOOP_TRIGGER_PATTERN.test(mustHappenText)) {
    expected.add('loop')
  } else if (priorChapter > 0) {
    const loopState = await collectLoopState(root, priorChapter)
    const dueLoop = loopState.loops.some(loop =>
      loop.status !== 'paid_off'
      && loop.status !== 'abandoned'
      && loop.targetToChapter !== undefined
      && loop.targetToChapter <= contract.chapter
      && (loop.relatedEntities.length === 0 || loop.relatedEntities.some(entity => chapterCharacters.has(entity))),
    )
    if (dueLoop) expected.add('loop')
  }

  return [...expected]
}

export function evaluateDimensions(
  expected: string[],
  extraction: ExtractionReport,
): { expected: string[]; covered: string[]; missed: string[] } {
  // "No events" may waive dimension checks only when there are truly no records;
  // otherwise it would let a partially reported chapter bypass the whole gate.
  if (extraction.noEventsReason && extraction.records.length === 0) {
    return { expected: [...expected], covered: [...expected], missed: [] }
  }
  const covered: string[] = []
  const missed: string[] = []
  for (const dim of expected) {
    if (isDimensionCovered(dim, extraction)) {
      covered.push(dim)
    } else {
      missed.push(dim)
    }
  }
  return { expected: [...expected], covered, missed }
}

const UNCHANGED_WITH_REASON = /^(?:unchanged|无变化)\s*[:：]\s*(\S.*)$/i

/** 单值状态谓词：同一时刻只能有一个值，新旧不一致且未声明 supersedes 时进待裁决。 */
const CONFLICT_PREDICATES = new Set(['status', 'condition', 'injury', 'health', 'alive', 'dead'])

/** A bare "unchanged" is not an explanation; the reason must carry some substance. */
function isExplicitUnchanged(value: string): boolean {
  const match = UNCHANGED_WITH_REASON.exec(value.trim())
  if (!match) return false
  const reason = match[1]!.trim()
  if (reason.length < 4) return false
  return !/^(?:原因|略|暂无|无|同上|none|n\/a)$/i.test(reason)
}

function isDimensionCovered(dim: string, extraction: ExtractionReport): boolean {
  const topLevel = extraction.dimensions?.[dim]
  if (typeof topLevel === 'string' && isExplicitUnchanged(topLevel)) return true

  for (const record of extraction.records) {
    if (record.dimension === dim || record.payload.dimension === dim) return true
    const payloadDims = objectOrNull(record.payload.dimensions)
    if (payloadDims && typeof payloadDims[dim] === 'string' && isExplicitUnchanged(String(payloadDims[dim]))) {
      return true
    }
  }

  switch (dim) {
    case 'event':
      return extraction.records.some(record => record.kind === 'event')
    case 'location':
      return extraction.records.some(record => Boolean(record.location?.trim()))
        || extraction.facts.some(fact => fact.predicate === 'location')
    case 'possession':
      return extraction.facts.some(fact => fact.predicate === 'possession')
    case 'knowledge':
      return extraction.beliefs.length > 0
    case 'status':
      return extraction.facts.some(fact =>
        ['status', 'condition', 'injury', 'health', 'alive', 'dead'].includes(fact.predicate),
      )
    case 'relationship':
      return extraction.facts.some(fact => fact.predicate === 'relationship')
    case 'loop':
      return extraction.loops.length > 0
    default:
      return false
  }
}

export async function runExtraction(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  config: ModelConfig,
  signal: AbortSignal,
  options: { hints?: string[] } = {},
): Promise<ExtractionReport> {
  const taskConfig = resolveTaskConfig(config, 'extraction')
  const model = taskConfig.model
  const expectedDimensions = await deriveExpectedDimensions(root, contract)
  const dimensionTemplate = Object.fromEntries(
    expectedDimensions.map(dim => [dim, 'unchanged: 具体原因（本章该维度确实没有变化时填写）']),
  )
  const prompt = [
    `第 ${chapter} 章合同：`,
    JSON.stringify(contract, null, 2),
    '',
    `本章必检维度（expectedDimensions）：${expectedDimensions.join('、')}`,
    '每个必检维度必须由 records/facts/beliefs/loops 中的记录覆盖，或在 dimensions 中显式声明 "unchanged: 原因"。',
    ...(options.hints && options.hints.length > 0 ? [
      '',
      '覆盖审计指出的待核实遗漏提示（如正文确实存在对应逐字引文，请补入 records；如不存在请忽略，不得编造）：',
      ...options.hints.map((hint, idx) => `${idx + 1}. ${hint}`),
    ] : []),
    '',
    '正文：',
    draft,
    '',
    '输出结构：',
    JSON.stringify({
      summary: '本章发生了什么，200 字以内',
      noEventsReason: null,
      dimensions: dimensionTemplate,
      records: [{
        recordId: 'r1',
        kind: 'event',
        dimension: 'event',
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
        predicate: 'possession',
        object: '持有物',
        quantity: { delta: -20, balance: 130, unit: '银元' },
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

  const result = await completeJsonObject({ config: { ...taskConfig, model }, system: SYSTEM_PROMPT, user: prompt, signal })
  await appendUsage(root, { task: 'extraction', model, usage: result.usage })
  const raw = result.raw
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('抽取结果缺少 summary')
  const noEventsReason = typeof raw.noEventsReason === 'string' && raw.noEventsReason.trim()
    ? raw.noEventsReason.trim()
    : null
  const dimensionsRaw = objectOrNull(raw.dimensions)
  const dimensions: Record<string, string> | undefined = dimensionsRaw
    ? Object.fromEntries(
        Object.entries(dimensionsRaw)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
          .map(([key, value]) => [key, value.trim()]),
      )
    : undefined
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
    if (typeof recordRaw.dimension === 'string' && recordRaw.dimension.trim()) record.dimension = recordRaw.dimension.trim()
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
    const quantityRaw = objectOrNull(factRaw.quantity)
    if (factRaw.quantity !== undefined && factRaw.quantity !== null && !quantityRaw) {
      rejected.push({ recordId: factId, reason: '数值总账格式非法：quantity 必须是对象', raw: item })
      return
    }
    let quantity: LedgerFact['quantity'] | undefined
    if (quantityRaw) {
      const balanceRaw = quantityRaw.balance
      const balance = balanceRaw === undefined || balanceRaw === null ? null : balanceRaw
      const deltaValid = typeof quantityRaw.delta === 'number' && Number.isSafeInteger(quantityRaw.delta)
      const balanceValid = balance === null || (typeof balance === 'number' && Number.isSafeInteger(balance))
      const unitValid = typeof quantityRaw.unit === 'string' && quantityRaw.unit.trim().length > 0
      if (!deltaValid || !balanceValid || !unitValid) {
        rejected.push({
          recordId: factId,
          reason: '数值总账格式非法：delta 与 balance 必须是整数（最小单位），unit 必须非空',
          raw: item,
        })
        return
      }
      quantity = {
        delta: quantityRaw.delta as number,
        balance,
        unit: (quantityRaw.unit as string).trim(),
        ...(balance === null ? { unverified: true } : {}),
      }
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
      ...(quantity ? { quantity } : {}),
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

  // 与账本冲突的单值状态（如正文写已死、账本记录存活）不丢弃也不采纳：扣进待裁决，由作者定夺。
  const pending: PendingRecord[] = []
  if (chapter > 1) {
    const priorLedger = await collectLedger(root, chapter - 1)
    const priorState = effectiveFacts(priorLedger.facts, chapter)
    for (let index = facts.length - 1; index >= 0; index -= 1) {
      const fact = facts[index]!
      if (!CONFLICT_PREDICATES.has(fact.predicate)) continue
      const clash = priorState.find(prior =>
        prior.subject === fact.subject
        && prior.predicate === fact.predicate
        && prior.object !== fact.object
        && fact.supersedes !== prior.factId,
      )
      if (!clash) continue
      facts.splice(index, 1)
      pending.unshift({
        pendingId: `pending-${chapter}-${fact.factId}`,
        chapter,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        quote: fact.evidence[0]?.quote ?? '',
        conflictWith: clash.factId,
        priorObject: clash.object,
        reason: 'contradicts-ledger',
        raw: fact,
        createdAt: new Date().toISOString(),
      })
    }
  }

  const report: ExtractionReport = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    summary,
    noEventsReason,
    ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    records,
    timeline,
    facts,
    beliefs,
    loops,
    rejected,
    pending,
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
