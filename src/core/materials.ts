import path from 'node:path'
import type { ChapterContract, LedgerBelief, LedgerFact, Material, MaterialCategory, MaterialProvenance } from './types.ts'
import { hashText } from './hash.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { loadCharacters, loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { currentCommit, finalPath, readMainline } from './ledger.ts'
import { collectLedger, effectiveBeliefs, effectiveFacts } from './story-ledger.ts'
import { loadMethods, methodText, selectMethods } from './methods.ts'
import { loadStyleConstitution, loadAuthorSamples, styleText } from './style.ts'
import { conflictError } from './errors.ts'
import { rebuildSearchIndex, searchBook, searchIndexHealth } from './search.ts'
import { listPlans, readApprovedPlan, type CharacterArc, type RollingPlan, type StoryPromise, type VolumeArc } from './planning.ts'
import { ensureStoryMemory, povMemory } from './memory.ts'
import { preferenceMaterial, readApprovedPreferences } from './preferences.ts'

interface ReferenceManifestEntry {
  id: string
  path: string
  provenance?: MaterialProvenance
  category?: MaterialCategory
  required?: boolean
}

interface ReferenceManifest {
  references?: ReferenceManifestEntry[]
}

export async function collectMaterials(root: string, contract: ChapterContract): Promise<Material[]> {
  const paths = projectPaths(root)
  const materials: Material[] = []

  for (const [file, label] of [
    ['premise.md', '故事前提'],
    ['world.md', '世界设定'],
    ['style.md', '写作风格'],
    ['prohibitions.md', '禁区与约束'],
  ] as const) {
    const text = await readTextIfExists(path.join(paths.canon, file))
    if (text?.trim()) materials.push(material(`canon:${file}`, 'author', 'author', true, label, text))
  }

  const registry = await loadCharacters(root)
  const relevant = registry.characters
    .filter(character => contract.characters.includes(character.name))
    .map(character => ({
      name: character.name,
      status: character.status,
      introducedIn: character.introducedIn,
      ...(character.deathChapter !== undefined ? { deathChapter: character.deathChapter } : {}),
    }))
  if (relevant.length > 0) {
    materials.push(
      material(
        'canon:characters',
        'author',
        'author',
        true,
        '本章人物状态',
        JSON.stringify({ characters: relevant }, null, 2),
      ),
    )
  }

  const priorChapter = Math.max(0, contract.chapter - 1)
  const ledger = await collectLedger(root, priorChapter)
  const povFacts = effectiveFacts(ledger.facts, priorChapter)
    .filter(fact => fact.subject === contract.pov)
  const povBeliefs = effectiveBeliefs(ledger.beliefs, contract.pov, priorChapter)
  const split = splitPovKnowledge(contract, povFacts, povBeliefs)
  if (split.criticalFacts.length > 0 || split.criticalBeliefs.length > 0) {
    materials.push({
      ...material(
        'pov:knowledge:critical',
        'derived-locator',
        'derived',
        true,
        `视角人物当前关键状态（${contract.pov}）`,
        JSON.stringify({ facts: split.criticalFacts, beliefs: split.criticalBeliefs }, null, 2),
      ),
      priority: 0,
    })
  }
  if (split.backgroundFacts.length > 0 || split.backgroundBeliefs.length > 0) {
    materials.push({
      ...material(
        'pov:knowledge:background',
        'derived-locator',
        'derived',
        false,
        `视角人物背景认知（${contract.pov}，可压缩）`,
        JSON.stringify({ facts: split.backgroundFacts, beliefs: split.backgroundBeliefs }, null, 2),
      ),
      priority: 20,
    })
  }

  const memory = await ensureStoryMemory(root).catch(() => null)
  if (memory) {
    if (contract.narrativeMode === 'omniscient') {
      if (memory.storySoFar) {
        materials.push({
          ...material('memory:story-so-far', 'derived-locator', 'derived', false, '全书进展摘要（派生定位，不是原文）', JSON.stringify({
            throughChapter: memory.throughChapter,
            text: memory.storySoFar,
          }, null, 2)),
          priority: 9,
        })
      }
      if (memory.volume) {
        materials.push({
          ...material('memory:volume', 'derived-locator', 'derived', false, '当前卷进展摘要（派生定位）', JSON.stringify({
            throughChapter: memory.throughChapter,
            text: memory.volume,
          }, null, 2)),
          priority: 8,
        })
      }
    }
    const scoped = povMemory(memory, contract.pov)
    if (scoped) {
      materials.push({
        ...material(
          `memory:pov:${contract.pov}`,
          'derived-locator',
          'derived',
          false,
          `视角人物经历摘要（${contract.pov}，POV 安全）`,
          JSON.stringify({ throughChapter: memory.throughChapter, text: scoped }, null, 2),
        ),
        priority: 6,
      })
    }
  }

  if (contract.chapter > 1) {
    const previousCommit = await currentCommit(root, contract.chapter - 1)
    if (!previousCommit) {
      throw conflictError(`第 ${contract.chapter - 1} 章尚未定稿，不能开始第 ${contract.chapter} 章`)
    }
    const previousContract = await loadContract(root, contract.chapter - 1)
    const continuation = await buildContinuation(
      root,
      contract,
      previousContract,
      previousCommit,
      povFacts,
      povBeliefs,
    )
    materials.push(
      material(
        continuation.sourceId,
        'finalized-history',
        'finalized',
        true,
        continuation.label,
        JSON.stringify(continuation.payload, null, 2),
      ),
    )
  }

  for (const offset of [1, 2]) {
    const upcoming = await loadContract(root, contract.chapter + offset).catch(() => null)
    if (!upcoming) continue
    materials.push(
      material(
        `future-plan:${upcoming.chapter}`,
        'future-plan',
        'author',
        false,
        '后续计划（不是既成事实）',
        JSON.stringify(upcoming, null, 2),
      ),
    )
  }

  const head = await readMainline(root)
  const chapterNumbers = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .sort((a, b) => a - b)
  if (chapterNumbers.length > 0) {
    const rows: string[] = []
    for (const number of chapterNumbers) {
      const title = await loadContract(root, number)
        .then(item => item.title)
        .catch(() => '')
      rows.push(`${String(number).padStart(3, '0')} ${title}`)
    }
    materials.push(
      material(
        'index:chapters',
        'derived-locator',
        'derived',
        false,
        '已定稿章节索引（仅定位）',
        rows.join('\n'),
      ),
    )
  }

  const styleConfig = await readJsonIfExists<Record<string, unknown>>(path.join(paths.canon, 'style.json'))
  if (styleConfig) {
    const style = await loadStyleConstitution(root)
    materials.push(
      material(
        'style:constitution',
        'author',
        'author',
        true,
        '结构化风格宪法',
        styleText(style),
      ),
    )
  }
  const samples = await loadAuthorSamples(root)
  if (samples.length > 0) {
    materials.push(
      material(
        'style:author-samples',
        'author',
        'author',
        true,
        '作者样本段落（优先级高于通用方法）',
        samples.map(sample => sample.text).join('\n\n---\n\n'),
      ),
    )
  }

  const methodSelection = await selectMethods(root, contract.chapter)
  if (methodSelection.modules.length > 0) {
    const library = await loadMethods(root)
    const selected = library.filter(module => methodSelection.modules.some(item => item.id === module.id))
    materials.push(
      material(
        'methods:selected',
        'derived-locator',
        'derived',
        true,
        '按本章诊断选中的写作方法',
        selected.map(methodText).join('\n\n'),
      ),
    )
  }

  const preference = preferenceMaterial(await readApprovedPreferences(root).catch(() => []))
  if (preference) materials.push(preference)
  materials.push(...(await collectPlanningMaterials(root, contract)))
  materials.push(...(await collectRetrievedEvidence(root, contract)))

  const manifest = await readJsonIfExists<ReferenceManifest>(path.join(paths.references, 'manifest.json'))
  if (manifest?.references?.length) {
    for (const entry of manifest.references) {
      const text = await readTextIfExists(path.join(root, entry.path))
      if (!text?.trim()) continue
      materials.push(
        material(
          entry.id,
          entry.category ?? 'reference',
          entry.provenance ?? 'unknown',
          entry.required ?? false,
          `参考：${entry.id}`,
          text,
        ),
      )
    }
  } else {
    for (const name of await listFiles(paths.references)) {
      if (!name.endsWith('.md')) continue
      const text = await readTextIfExists(path.join(paths.references, name))
      if (!text?.trim()) continue
      materials.push(material(`reference:${name}`, 'reference', 'unknown', false, `参考：${name}`, text))
    }
  }

  return materials
}


interface ContinuationPayload {
  chapter: number
  mode: 'prose' | 'summary'
  actualEnding: string
  excerpt?: string
  excerptOffset?: number
  visibility: {
    pov: string
    samePov: boolean
    continuity: 'same-location' | 'same-time' | 'unknown'
    coveredParagraphs: number
    totalParagraphs: number
  }
  facts: unknown[]
  beliefs: unknown[]
  fallbackReason?: string
}

/**
 * Prose may only enter the next chapter when the previous chapter's own evidence covers every
 * exposed paragraph for the same POV. Anything less certain degrades to a summary.
 */
async function buildContinuation(
  root: string,
  contract: ChapterContract,
  previousContract: ChapterContract,
  previousCommit: NonNullable<Awaited<ReturnType<typeof currentCommit>>>,
  povFacts: unknown[],
  povBeliefs: unknown[],
): Promise<{ sourceId: string; label: string; payload: ContinuationPayload }> {
  const chapter = contract.chapter - 1
  const samePov = previousContract.pov === contract.pov
  const continuity: ContinuationPayload['visibility']['continuity'] =
    previousContract.location === contract.location
      ? 'same-location'
      : previousContract.time === contract.time ? 'same-time' : 'unknown'
  const actualEnding = actualEndingOf(previousCommit)
  const payload: ContinuationPayload = {
    chapter,
    mode: 'summary',
    actualEnding,
    visibility: { pov: contract.pov, samePov, continuity, coveredParagraphs: 0, totalParagraphs: 0 },
    facts: povFacts,
    beliefs: povBeliefs,
  }
  const summary = { sourceId: `pov:previous-summary:${chapter}`, label: '上一章视角安全摘要（不是原文）' }

  if (contract.narrativeMode === 'omniscient') {
    payload.fallbackReason = 'omniscient-view'
    return { ...summary, payload }
  }
  if (!samePov) {
    payload.fallbackReason = 'different-pov'
    return { ...summary, payload }
  }
  if (continuity === 'unknown') {
    payload.fallbackReason = 'scene-discontinuity'
    return { ...summary, payload }
  }
  if (previousCommit.schemaVersion !== 3 || !previousCommit.ledger) {
    payload.fallbackReason = 'missing-evidence-ledger'
    return { ...summary, payload }
  }
  const prose = await readTextIfExists(finalPath(root, chapter))
  if (!prose?.trim()) {
    payload.fallbackReason = 'missing-final-prose'
    return { ...summary, payload }
  }
  const visible = visibleSpans(previousCommit, contract.pov)
  if (visible.length === 0) {
    payload.fallbackReason = 'no-pov-evidence'
    return { ...summary, payload }
  }
  const excerpt = tailExcerpt(prose, 800, 300)
  const paragraphs = paragraphSpans(excerpt.text)
  const covered = paragraphs.filter(paragraph =>
    visible.some(span => span.byteStart < paragraph.end && paragraph.start < span.byteEnd),
  )
  payload.visibility.coveredParagraphs = covered.length
  payload.visibility.totalParagraphs = paragraphs.length
  if (paragraphs.length === 0) {
    payload.fallbackReason = 'empty-excerpt'
    return { ...summary, payload }
  }
  if (covered.length !== paragraphs.length) {
    payload.fallbackReason = 'excerpt-not-covered'
    return { ...summary, payload }
  }
  const leaked = foreignPropositionLeak(previousCommit, contract.pov, excerpt.text)
  if (leaked) {
    payload.fallbackReason = `foreign-secret:${leaked.slice(0, 24)}`
    return { ...summary, payload }
  }
  payload.mode = 'prose'
  payload.excerpt = excerpt.text
  payload.excerptOffset = excerpt.offset
  return {
    sourceId: `finalized-history:continuation:${chapter}`,
    label: '上一章定稿结尾（POV 已验证）',
    payload,
  }
}

function actualEndingOf(commit: NonNullable<Awaited<ReturnType<typeof currentCommit>>>): string {
  const events = commit.ledger?.events ?? []
  return events.slice(-2).map(event => event.summary).join('；')
}

function visibleSpans(
  commit: NonNullable<Awaited<ReturnType<typeof currentCommit>>>,
  pov: string,
): Array<{ byteStart: number; byteEnd: number }> {
  const ledger = commit.ledger
  if (!ledger) return []
  return [
    ...ledger.events.filter(event => event.participants.includes(pov)).flatMap(event => event.evidence),
    ...ledger.facts.filter(fact => fact.subject === pov).flatMap(fact => fact.evidence),
    ...ledger.beliefs.filter(belief => belief.characterId === pov).flatMap(belief => belief.evidence),
  ]
}

function foreignPropositionLeak(
  commit: NonNullable<Awaited<ReturnType<typeof currentCommit>>>,
  pov: string,
  excerpt: string,
): string | null {
  for (const belief of commit.ledger?.beliefs ?? []) {
    if (belief.characterId === pov) continue
    if (belief.attitude !== 'knows' && belief.attitude !== 'believes') continue
    const proposition = belief.proposition.replace(/\s+/g, '')
    if (proposition.length >= 4 && excerpt.replace(/\s+/g, '').includes(proposition)) return belief.proposition
  }
  return null
}

function tailExcerpt(text: string, max: number, min: number): { text: string; offset: number } {
  const paragraphs = text.split(/\n{2,}/)
  const kept: string[] = []
  let characters = 0
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index]!.trim()
    if (!paragraph) continue
    if (characters > 0 && characters + [...paragraph].length > max) break
    kept.unshift(paragraph)
    characters += [...paragraph].length
    if (characters >= min) break
  }
  const joined = kept.join('\n\n')
  const offset = Math.max(0, text.indexOf(joined))
  return { text: joined, offset }
}

function paragraphSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const part of text.split(/\n{2,}/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const index = text.indexOf(trimmed, cursor)
    if (index < 0) continue
    spans.push({
      start: Buffer.byteLength(text.slice(0, index), 'utf8'),
      end: Buffer.byteLength(text.slice(0, index + trimmed.length), 'utf8'),
    })
    cursor = index + trimmed.length
  }
  return spans
}


const RETRIEVAL_LIMIT = 4
const RETRIEVAL_PER_CHAPTER = 2
const RETRIEVAL_CHARS = 900
const DUPLICATE_SHINGLE = 4
const DUPLICATE_THRESHOLD = 0.6

/**
 * Pull a small set of finalized passages that answer "who/what appeared before".
 * Candidates must come from the current mainline, keep relevance through budget trimming,
 * and pass the same POV rule as continuity prose.
 */
async function collectRetrievedEvidence(root: string, contract: ChapterContract): Promise<Material[]> {
  if (contract.chapter <= 1) return []
  const head = await readMainline(root)
  if (Object.keys(head.selectedCommitByChapter).length === 0) return []

  let health = await searchIndexHealth(root)
  if (health.status === 'missing') {
    await rebuildSearchIndex(root)
    health = await searchIndexHealth(root)
  }
  if (health.status !== 'current' || health.mainlineRevision !== head.mainlineRevision) {
    throw conflictError('检索索引不可用或落后于主线；请执行 weave rebuild --projection search')
  }

  const queries = retrievalQueries(contract)
  const candidates = new Map<string, { score: number; chapter: number; paragraph: number; text: string; sourceCommit: string }>()
  for (const [queryIndex, query] of queries.entries()) {
    const result = await searchBook(root, query, { limit: 5 })
    for (const [rank, item] of result.results.entries()) {
      if (item.chapter >= contract.chapter) continue
      if (item.chapter === contract.chapter - 1) continue
      const score = 1 / (1 + rank) + 1 / (1 + queryIndex)
      const existing = candidates.get(item.chunkId)
      if (existing) existing.score += score
      else candidates.set(item.chunkId, {
        score, chapter: item.chapter, paragraph: item.paragraph, text: item.text, sourceCommit: item.sourceCommit,
      })
    }
  }

  const ordered = [...candidates.values()].sort((a, b) =>
    b.score - a.score || b.chapter - a.chapter || a.paragraph - b.paragraph,
  )
  const materials: Material[] = []
  const perChapter = new Map<number, number>()
  const selectedTexts: string[] = []
  for (const candidate of ordered) {
    if (materials.length >= RETRIEVAL_LIMIT) break
    if ((perChapter.get(candidate.chapter) ?? 0) >= RETRIEVAL_PER_CHAPTER) continue
    const text = [...candidate.text].slice(0, RETRIEVAL_CHARS).join('')
    if (selectedTexts.some(existing => nearDuplicate(existing, text))) continue
    if (!(await povAllowsEvidence(root, contract, candidate.chapter, candidate.text))) continue
    perChapter.set(candidate.chapter, (perChapter.get(candidate.chapter) ?? 0) + 1)
    selectedTexts.push(text)
    const chapter = String(candidate.chapter).padStart(3, '0')
    const paragraph = String(candidate.paragraph).padStart(3, '0')
    materials.push({
      ...material(
        `finalized-history:ch-${chapter}-p${paragraph}`,
        'finalized-history',
        'finalized',
        false,
        `前文呼应：第 ${candidate.chapter} 章第 ${candidate.paragraph} 段`,
        text,
      ),
      priority: 10,
      relevance: Number(candidate.score.toFixed(4)),
    })
  }
  return materials
}

function retrievalQueries(contract: ChapterContract): string[] {
  const queries: string[] = []
  const threads = contract.threads.join(' ').trim()
  if (threads) queries.push(threads)
  const cast = contract.characters.join(' ').trim()
  if (cast) queries.push(cast)
  if (contract.goal.trim()) queries.push(contract.goal.trim().slice(0, 60))
  if (contract.previousLink.trim()) queries.push(contract.previousLink.trim().slice(0, 60))
  return [...new Set(queries)]
}

async function povAllowsEvidence(
  root: string,
  contract: ChapterContract,
  chapter: number,
  text: string,
): Promise<boolean> {
  if (contract.narrativeMode === 'omniscient') return true
  const chapterContract = await loadContract(root, chapter).catch(() => null)
  if (!chapterContract) return false
  if (chapterContract.pov !== contract.pov) return false
  const commitId = (await readMainline(root)).selectedCommitByChapter[String(chapter)]
  if (!commitId) return false
  const commit = await currentCommit(root, chapter)
  if (!commit?.ledger) return true
  const squashed = text.replace(/\s+/g, '')
  for (const belief of commit.ledger.beliefs) {
    if (belief.characterId === contract.pov) continue
    if (belief.attitude !== 'knows' && belief.attitude !== 'believes') continue
    const proposition = belief.proposition.replace(/\s+/g, '')
    if (proposition.length >= 4 && squashed.includes(proposition)) return false
  }
  return true
}


/**
 * Only approved planning reaches generation. A file edited after approval reports `modified`
 * and stops being authoritative until the author approves the new hash.
 */
async function collectPlanningMaterials(root: string, contract: ChapterContract): Promise<Material[]> {
  const materials: Material[] = []
  const story = await readApprovedPlan<StoryPromise>(root, 'story')
  if (story) {
    materials.push(material(
      'plan:story-promise',
      'author',
      'author',
      true,
      '已批准的故事承诺',
      JSON.stringify(story, null, 2),
    ))
  }

  const arcs = await readApprovedPlan<{ characters: CharacterArc[] }>(root, 'character-arcs')
  const relevantArcs = arcs?.characters.filter(arc => contract.characters.includes(arc.name)) ?? []
  if (relevantArcs.length > 0) {
    materials.push({
      ...material(
        'plan:character-arcs',
        'author',
        'author',
        false,
        '已批准的人物弧（不是当前状态）',
        JSON.stringify({ characters: relevantArcs }, null, 2),
      ),
      priority: 5,
    })
  }

  const volumes = (await listPlans(root)).filter(entry => entry.kind === 'volume' && entry.status === 'approved')
  const current = volumes
    .map(entry => entry.content as VolumeArc)
    .filter(volume => Number.isSafeInteger(volume.volume))
    .sort((a, b) => b.volume - a.volume)[0]
  if (current) {
    materials.push({
      ...material(
        'plan:volume',
        'future-plan',
        'author',
        false,
        '已批准的当前卷弧（不是既成事实）',
        JSON.stringify(current, null, 2),
      ),
      priority: 6,
    })
  }

  const rolling = await readApprovedPlan<RollingPlan>(root, 'rolling')
  const upcoming = rolling?.chapters.filter(item => item.chapter >= contract.chapter && item.chapter <= contract.chapter + 3) ?? []
  if (upcoming.length > 0) {
    materials.push({
      ...material(
        'plan:rolling',
        'future-plan',
        'author',
        false,
        '已批准的滚动章纲（未来计划）',
        JSON.stringify({ chapters: upcoming }, null, 2),
      ),
      priority: 3,
    })
  }
  return materials
}


const CRITICAL_PREDICATES = new Set([
  'location', 'status', 'condition', 'injury', 'health', 'possession', 'goal', 'alive', 'dead',
])

/**
 * Required knowledge stays bounded: current scene state, explicit contract knowledge and
 * motivating misbeliefs are never trimmed. Long-tail history becomes compressible background.
 */
function splitPovKnowledge(
  contract: ChapterContract,
  facts: LedgerFact[],
  beliefs: LedgerBelief[],
): {
  criticalFacts: LedgerFact[]
  criticalBeliefs: LedgerBelief[]
  backgroundFacts: LedgerFact[]
  backgroundBeliefs: LedgerBelief[]
} {
  const explicit = new Set(
    (contract.knowledge ?? [])
      .filter(item => item.character === contract.pov)
      .map(item => item.fact.replace(/\s+/g, '')),
  )
  const criticalFacts = facts.filter(fact => CRITICAL_PREDICATES.has(fact.predicate))
  const backgroundFacts = facts.filter(fact => !CRITICAL_PREDICATES.has(fact.predicate))
  const criticalBeliefs = beliefs.filter(belief =>
    belief.attitude === 'misbelieves'
    || explicit.has(belief.proposition.replace(/\s+/g, '')),
  )
  const backgroundBeliefs = beliefs.filter(belief => !criticalBeliefs.includes(belief))
  return { criticalFacts, criticalBeliefs, backgroundFacts, backgroundBeliefs }
}


/** Near-duplicate passages (same beat repeated, or a chapter quoting itself) waste evidence slots. */
function nearDuplicate(left: string, right: string): boolean {
  const a = shingles(left)
  const b = shingles(right)
  if (a.size === 0 || b.size === 0) return left.trim() === right.trim()
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared) > DUPLICATE_THRESHOLD
}

function shingles(text: string): Set<string> {
  const compact = text.replace(/\s+/g, '')
  const set = new Set<string>()
  for (let index = 0; index + DUPLICATE_SHINGLE <= compact.length; index += 1) {
    set.add(compact.slice(index, index + DUPLICATE_SHINGLE))
  }
  return set
}

function material(
  sourceId: string,
  category: MaterialCategory,
  provenance: MaterialProvenance,
  required: boolean,
  label: string,
  text: string,
): Material {
  return {
    sourceId,
    category,
    provenance,
    required,
    label,
    text,
    contentHash: hashText(text),
    visibility: category === 'reference' ? 'author-only' : 'project',
    purpose: label,
  }
}
