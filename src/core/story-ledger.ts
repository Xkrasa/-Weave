import type {
  BeliefAttitude,
  ChapterContract,
  CharacterRegistry,
  LedgerBelief,
  LedgerDelta,
  LedgerEvent,
  LedgerFact,
} from './types.ts'
import type { ExtractionReport } from './stage-types.ts'
import { readCommit, readMainline } from './ledger.ts'
import { validationError } from './errors.ts'
import { objectHash } from './hash.ts'

export interface LedgerValidationContext {
  priorFacts?: Map<string, LedgerFact>
  priorEvents?: Map<string, LedgerEvent>
  usedFactIds?: Set<string>
  usedEventIds?: Set<string>
  usedBeliefIds?: Set<string>
  contract?: ChapterContract
}

export function eventIdFor(chapter: number, recordId: string): string {
  return `event-${chapter}-${recordId}`
}

export function buildLedgerDelta(
  chapter: number,
  extraction: ExtractionReport,
  contract?: ChapterContract,
): LedgerDelta {
  const events: LedgerEvent[] = extraction.records.map(record => {
    const causedBy = Array.isArray(record.payload.causedBy)
      ? record.payload.causedBy
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.startsWith('event-') ? value : eventIdFor(chapter, value))
      : []
    return {
      eventId: eventIdFor(chapter, record.recordId),
      chapter,
      summary: record.summary,
      participants: record.participants,
      causedBy,
      evidence: record.evidence,
      ...(record.storyTime ? { storyTime: record.storyTime } : {}),
      ...(record.location ? { location: record.location } : {}),
    }
  })
  return {
    ...(contract ? {
      contract: {
        chapter,
        contractHash: objectHash(contract),
        planned: contract.mustHappen,
      },
    } : {}),
    events,
    facts: extraction.facts ?? [],
    beliefs: extraction.beliefs ?? [],
  }
}

export function validateLedgerDelta(
  chapter: number,
  delta: LedgerDelta,
  registry: CharacterRegistry,
  context: LedgerValidationContext = {},
): string[] {
  const errors: string[] = []
  const knownPeople = new Set(registry.characters.map(character => character.name))
  const priorFacts = context.priorFacts ?? new Map()
  const priorEvents = context.priorEvents ?? new Map()
  const usedFactIds = context.usedFactIds ?? new Set()
  const usedEventIds = context.usedEventIds ?? new Set()
  const usedBeliefIds = context.usedBeliefIds ?? new Set()
  const eventIds = new Set<string>()
  const factIds = new Set<string>()
  const beliefIds = new Set<string>()

  if (delta.contract) {
    if (delta.contract.chapter !== chapter) errors.push(`合同引用章节不是 ${chapter}`)
    if (context.contract) {
      if (delta.contract.contractHash !== objectHash(context.contract)) {
        errors.push('合同引用哈希与当前合同不一致')
      }
      if (
        delta.contract.planned.length !== context.contract.mustHappen.length
        || delta.contract.planned.some((node, index) => node !== context.contract!.mustHappen[index])
      ) {
        errors.push('合同引用节点与当前合同不一致')
      }
    }
  }

  for (const event of delta.events) {
    if (!event.eventId) {
      errors.push('事件缺少 eventId')
      continue
    }
    if (eventIds.has(event.eventId) || usedEventIds.has(event.eventId)) {
      errors.push(`事件 ID 重复：${event.eventId}`)
    }
    eventIds.add(event.eventId)
    if (event.chapter !== chapter) errors.push(`事件 ${event.eventId} 的章节不是 ${chapter}`)
    if (!event.summary.trim()) errors.push(`事件 ${event.eventId} 缺少 summary`)
    if (event.evidence.length === 0) errors.push(`事件 ${event.eventId} 缺少证据`)
    for (const participant of event.participants) {
      if (registry.characters.length > 0 && !knownPeople.has(participant)) {
        errors.push(`事件 ${event.eventId} 引用了不存在的人物：${participant}`)
      }
    }
    for (const cause of event.causedBy) {
      if (!eventIds.has(cause) && !priorEvents.has(cause)) {
        errors.push(`事件 ${event.eventId} 引用了不存在的原因事件：${cause}`)
      }
    }
  }

  for (const fact of delta.facts) {
    if (!fact.factId) {
      errors.push('事实缺少 factId')
      continue
    }
    if (factIds.has(fact.factId) || usedFactIds.has(fact.factId)) {
      errors.push(`事实 ID 重复：${fact.factId}`)
    }
    factIds.add(fact.factId)
    if (!fact.subject || !fact.predicate || !fact.object) {
      errors.push(`事实 ${fact.factId} 缺少 subject/predicate/object`)
    }
    if (fact.chapter !== chapter) errors.push(`事实 ${fact.factId} 的章节不是 ${chapter}`)
    if (fact.validFromChapter > chapter) errors.push(`事实 ${fact.factId} 的生效章节晚于当前章`)
    if (fact.validToChapter !== null && fact.validToChapter < fact.validFromChapter) {
      errors.push(`事实 ${fact.factId} 的失效章节早于生效章节`)
    }
    if (fact.sourceEvent && !eventIds.has(fact.sourceEvent) && !priorEvents.has(fact.sourceEvent)) {
      errors.push(`事实 ${fact.factId} 引用了不存在的事件：${fact.sourceEvent}`)
    }
    if (registry.characters.length > 0 && !knownPeople.has(fact.subject)) {
      errors.push(`事实 ${fact.factId} 的 subject 不是已知人物实体：${fact.subject}`)
    }
    if (fact.evidence.length === 0) errors.push(`事实 ${fact.factId} 缺少证据`)
  }

  const supersedeGraph = new Map<string, string>()
  for (const fact of [...priorFacts.values(), ...delta.facts]) {
    if (fact.supersedes) supersedeGraph.set(fact.factId, fact.supersedes)
  }
  for (const fact of delta.facts) {
    if (!fact.supersedes) continue
    const prior = priorFacts.get(fact.supersedes)
    if (!prior && !factIds.has(fact.supersedes)) {
      errors.push(`事实 ${fact.factId} 的 supersedes 不存在：${fact.supersedes}`)
    }
    if (prior && prior.validFromChapter > fact.validFromChapter) {
      errors.push(`事实 ${fact.factId} 不能取代更晚生效的事实 ${prior.factId}`)
    }
    const seen = new Set<string>()
    let current: string | undefined = fact.factId
    while (current) {
      if (seen.has(current)) {
        errors.push(`事实 supersede 链存在循环：${fact.factId}`)
        break
      }
      seen.add(current)
      current = supersedeGraph.get(current)
    }
  }

  for (const belief of delta.beliefs) {
    if (!belief.beliefId) {
      errors.push('信念缺少 beliefId')
      continue
    }
    if (beliefIds.has(belief.beliefId) || usedBeliefIds.has(belief.beliefId)) {
      errors.push(`信念 ID 重复：${belief.beliefId}`)
    }
    beliefIds.add(belief.beliefId)
    if (!belief.characterId || !belief.proposition) {
      errors.push(`信念 ${belief.beliefId} 缺少 characterId 或 proposition`)
    }
    if (belief.chapter !== chapter) errors.push(`信念 ${belief.beliefId} 的章节不是 ${chapter}`)
    if (registry.characters.length > 0 && !knownPeople.has(belief.characterId)) {
      errors.push(`信念 ${belief.beliefId} 引用了不存在的人物：${belief.characterId}`)
    }
    if (belief.learnedAtChapter > chapter) errors.push(`信念 ${belief.beliefId} 的获知章节晚于当前章`)
    if (belief.validFromChapter > chapter) errors.push(`信念 ${belief.beliefId} 的生效章节晚于当前章`)
    if (belief.validToChapter !== null && belief.validToChapter < belief.validFromChapter) {
      errors.push(`信念 ${belief.beliefId} 的失效章节早于生效章节`)
    }
    if (belief.sourceEvent && !eventIds.has(belief.sourceEvent) && !priorEvents.has(belief.sourceEvent)) {
      errors.push(`信念 ${belief.beliefId} 引用了不存在的事件：${belief.sourceEvent}`)
    }
    if (belief.evidence.length === 0) errors.push(`信念 ${belief.beliefId} 缺少证据`)
  }
  return errors
}

export interface LedgerView {
  events: LedgerEvent[]
  facts: LedgerFact[]
  beliefs: LedgerBelief[]
}

export interface SourcedLedger {
  events: Array<{ record: LedgerEvent; commitId: string }>
  facts: Array<{ record: LedgerFact; commitId: string }>
  beliefs: Array<{ record: LedgerBelief; commitId: string }>
}

export async function collectLedgerSources(root: string, throughChapter?: number): Promise<SourcedLedger> {
  const head = await readMainline(root)
  const events: SourcedLedger['events'] = []
  const facts: SourcedLedger['facts'] = []
  const beliefs: SourcedLedger['beliefs'] = []
  const chapters = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .filter(chapter => throughChapter === undefined || chapter <= throughChapter)
    .sort((a, b) => a - b)
  for (const chapter of chapters) {
    const commitId = head.selectedCommitByChapter[String(chapter)]
    if (!commitId) continue
    const commit = await readCommit(root, commitId)
    if (!commit?.ledger) continue
    events.push(...commit.ledger.events.map(record => ({ record, commitId })))
    facts.push(...commit.ledger.facts.map(record => ({ record, commitId })))
    beliefs.push(...commit.ledger.beliefs.map(record => ({ record, commitId })))
  }
  return { events, facts, beliefs }
}

export async function collectLedger(root: string, throughChapter?: number): Promise<LedgerView> {
  const sources = await collectLedgerSources(root, throughChapter)
  return {
    events: sources.events.map(item => item.record),
    facts: sources.facts.map(item => item.record),
    beliefs: sources.beliefs.map(item => item.record),
  }
}

export function effectiveFacts(facts: LedgerFact[], chapter: number): LedgerFact[] {
  const active = facts.filter(fact =>
    fact.origin !== 'candidate'
    && fact.validFromChapter <= chapter
    && (fact.validToChapter === null || fact.validToChapter > chapter),
  )
  const superseded = new Set(active.map(fact => fact.supersedes).filter((id): id is string => Boolean(id)))
  return active.filter(fact => !superseded.has(fact.factId))
}

export function effectiveBeliefs(beliefs: LedgerBelief[], characterId: string, chapter: number): LedgerBelief[] {
  return beliefs.filter(belief =>
    belief.characterId === characterId
    && belief.validFromChapter <= chapter
    && (belief.validToChapter === null || belief.validToChapter > chapter),
  )
}

export function assertValidLedger(
  chapter: number,
  delta: LedgerDelta,
  registry: CharacterRegistry,
  context: LedgerValidationContext = {},
): void {
  const errors = validateLedgerDelta(chapter, delta, registry, context)
  if (errors.length > 0) throw validationError(`第 ${chapter} 章账本校验失败`, errors)
}

export function normalizeAttitude(value: unknown): BeliefAttitude | null {
  return value === 'knows' || value === 'believes' || value === 'suspects'
    || value === 'misbelieves' || value === 'doubts'
    ? value
    : null
}
