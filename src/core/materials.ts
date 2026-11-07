import path from 'node:path'
import type { ChapterContract, LedgerBelief, LedgerFact, Material, MaterialCategory, MaterialProvenance } from './types.ts'
import { hashText } from './hash.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { loadCharacters, loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { currentCommit, finalPath, readMainline } from './ledger.ts'
import { collectLedger, collectLoopState, effectiveBeliefs, effectiveFacts } from './story-ledger.ts'
import { assembleContext, estimateTokens } from './context.ts'
import { loadModelConfig } from './project.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { loadMethods, methodText, selectMethods } from './methods.ts'
import { loadStyleConstitution, selectAuthorSamples, styleText } from './style.ts'
import { conflictError, validationError } from './errors.ts'
import { rebuildSearchIndex, searchBook, searchIndexHealth } from './search.ts'
import { listPlans, readApprovedPlan, type CharacterArc, type RollingPlan, type StoryPromise, type VolumeArc } from './planning.ts'
import { ensureStoryMemory, povMemory } from './memory.ts'
import { preferenceMaterial, readApprovedPreferences } from './preferences.ts'
import { listUnresolvedPending } from './pending.ts'
import { listIdeas, readIdea } from './ideas.ts'

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

export interface WithheldMaterial {
  sourceId: string
  reason: 'not-yet-revealed' | 'idea-spoiler'
}

export interface DisclosureEntry {
  sourceId: string
  revealChapter: number
  excerpt: string
}

const CANON_FILES = [
  ['premise.md', '故事前提'],
  ['world.md', '世界设定'],
  ['style.md', '写作风格'],
  ['prohibitions.md', '禁区与约束'],
] as const

/**
 * canon/reveals.json：sourceId → 首次对生成开放的章号。
 * 未到章号的 canon 材料不进上下文，也不得被预算逻辑当作省略处理。
 */
export async function loadReveals(root: string): Promise<Map<string, number>> {
  const raw = await readJsonIfExists<Record<string, unknown>>(path.join(projectPaths(root).canon, 'reveals.json'))
  const reveals = new Map<string, number>()
  if (!raw) return reveals
  for (const [sourceId, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw validationError(`canon/reveals.json 中 ${sourceId} 的披露章号必须是正整数，收到 ${String(value)}`)
    }
    reveals.set(sourceId, value)
  }
  return reveals
}

/** 指定章仍未开放的 canon 条目（含内容预览）；供 status 对照装配报告。 */
export async function withheldForChapter(
  root: string,
  contract: ChapterContract,
): Promise<DisclosureEntry[]> {
  const reveals = await loadReveals(root)
  if (reveals.size === 0) return []
  const entries: DisclosureEntry[] = []
  for (const [file] of CANON_FILES) {
    const sourceId = `canon:${file}`
    const revealChapter = reveals.get(sourceId)
    if (revealChapter === undefined || revealChapter <= contract.chapter) continue
    const text = await readTextIfExists(path.join(projectPaths(root).canon, file))
    if (!text?.trim()) continue
    entries.push({ sourceId, revealChapter, excerpt: text.trim().replace(/\s+/g, ' ').slice(0, 160) })
  }
  const registry = await loadCharacters(root)
  for (const character of registry.characters) {
    if (!contract.characters.includes(character.name)) continue
    const sourceId = `canon:characters:${character.name}`
    const revealChapter = reveals.get(sourceId)
    if (revealChapter === undefined || revealChapter <= contract.chapter) continue
    entries.push({ sourceId, revealChapter, excerpt: `${character.name} 的人物档案整体未开放` })
  }
  return entries
}

export const MAX_IDEA_MATERIALS = 6
export const MAX_IDEA_TOKENS = 2_000

export async function collectMaterialBundle(
  root: string,
  contract: ChapterContract,
  options: {
    authorSamples?: 'scene' | 'legacy' | 'off'
    /** Book-scoped ideas are opt-in; chapter/volume/character scopes always match when they apply. */
    includeBookIdeas?: boolean
    charsPerToken?: number
  } = {},
): Promise<{
  materials: Material[]
  methodSelection: import('./methods.ts').MethodSelection
  sampleSelection: import('./style.ts').AuthorSampleSelection
  withheld: WithheldMaterial[]
  ideaOmitted: Array<{ sourceId: string; reason: 'budget' }>
  ideaDegraded: Array<{ sourceId: string; reason: 'budget' }>
  ideaWarnings: string[]
}> {
  const paths = projectPaths(root)
  const materials: Material[] = []
  const withheld: WithheldMaterial[] = []
  const reveals = await loadReveals(root)

  for (const [file, label] of CANON_FILES) {
    const text = await readTextIfExists(path.join(paths.canon, file))
    if (!text?.trim()) continue
    const sourceId = `canon:${file}`
    const revealAt = reveals.get(sourceId)
    if (revealAt !== undefined && revealAt > contract.chapter) {
      withheld.push({ sourceId, reason: 'not-yet-revealed' })
      continue
    }
    materials.push(material(sourceId, 'author', 'author', true, label, text))
  }

  const registry = await loadCharacters(root)
  const relevant: Array<{
    name: string
    status: string
    introducedIn: number
    deathChapter?: number
    role?: string
    traits?: string[]
    voice?: string
    desire?: string
  }> = []
  for (const character of registry.characters) {
    if (!contract.characters.includes(character.name)) continue
    const revealAt = reveals.get(`canon:characters:${character.name}`)
    if (revealAt !== undefined && revealAt > contract.chapter) {
      withheld.push({ sourceId: `canon:characters:${character.name}`, reason: 'not-yet-revealed' })
      continue
    }
    relevant.push({
      name: character.name,
      status: character.status,
      introducedIn: character.introducedIn,
      ...(character.deathChapter !== undefined ? { deathChapter: character.deathChapter } : {}),
      ...(character.role ? { role: character.role } : {}),
      ...(character.traits?.length ? { traits: character.traits } : {}),
      ...(character.voice ? { voice: character.voice } : {}),
      ...(character.desire ? { desire: character.desire } : {}),
    })
  }
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
        JSON.stringify({
          facts: split.criticalFacts.map(formatFactForPrompt),
          beliefs: split.criticalBeliefs.map(formatBeliefForPrompt),
        }, null, 2),
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
        JSON.stringify({
          facts: split.backgroundFacts.map(formatFactForPrompt),
          beliefs: split.backgroundBeliefs.map(formatBeliefForPrompt),
        }, null, 2),
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
      povFacts.map(formatFactForPrompt),
      povBeliefs.map(formatBeliefForPrompt),
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
  const sampleSelection = await selectAuthorSamples(root, contract, { strategy: options.authorSamples ?? 'scene' })
  const { samples } = sampleSelection
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

  const ideaBundle = await collectIdeaMaterials(root, contract, reveals, {
    ...(options.includeBookIdeas !== undefined ? { includeBookIdeas: options.includeBookIdeas } : {}),
    ...(options.charsPerToken !== undefined ? { charsPerToken: options.charsPerToken } : {}),
  })
  materials.push(...ideaBundle.materials)
  withheld.push(...ideaBundle.withheld)

  return {
    materials,
    methodSelection,
    sampleSelection,
    withheld,
    ideaOmitted: ideaBundle.omitted,
    ideaDegraded: ideaBundle.degraded,
    ideaWarnings: ideaBundle.warnings,
  }
}

export async function collectMaterials(
  root: string,
  contract: ChapterContract,
  options: { authorSamples?: 'scene' | 'legacy' | 'off' } = {},
): Promise<Material[]> {
  return (await collectMaterialBundle(root, contract, options)).materials
}

/**
 * Promoted ideas become optional author-only materials. Inbox ideas never enter context.
 * The 6-item / 2000-token caps are applied before assembly; overflow is reported as
 * omitted or degraded instead of silently dropped.
 */
async function collectIdeaMaterials(
  root: string,
  contract: ChapterContract,
  reveals: Map<string, number>,
  options: { includeBookIdeas?: boolean; charsPerToken?: number } = {},
): Promise<{
  materials: Material[]
  withheld: WithheldMaterial[]
  omitted: Array<{ sourceId: string; reason: 'budget' }>
  degraded: Array<{ sourceId: string; reason: 'budget' }>
  warnings: string[]
}> {
  const materials: Material[] = []
  const withheld: WithheldMaterial[] = []
  const omitted: Array<{ sourceId: string; reason: 'budget' }> = []
  const degraded: Array<{ sourceId: string; reason: 'budget' }> = []
  const warnings: string[] = []
  const charsPerToken = options.charsPerToken ?? 1.6
  const candidates = (await listIdeas(root, { status: 'promoted' }))
    .filter(idea => idea.promotionState === 'active' && ideaScopeMatches(idea, contract, options))
    .sort((left, right) =>
      ideaPriorityRank(left.priority) - ideaPriorityRank(right.priority)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id))

  let count = 0
  let tokens = 0
  for (const candidate of candidates) {
    const sourceId = `idea:${candidate.id}`
    const revealAt = Math.max(candidate.revealAfterChapter ?? 0, reveals.get(sourceId) ?? 0)
    if (candidate.spoilerLevel === 'reveal' && revealAt > contract.chapter) {
      withheld.push({ sourceId, reason: 'idea-spoiler' })
      continue
    }
    if (count >= MAX_IDEA_MATERIALS) {
      omitted.push({ sourceId, reason: 'budget' })
      continue
    }
    const { meta, body } = await readIdea(root, candidate.id)
    if (!body.trim()) {
      warnings.push(`想法「${meta.title}」正文缺失，跳过回灌。`)
      omitted.push({ sourceId, reason: 'budget' })
      continue
    }
    const text = `作者意图（不是既成事实，不得写成已发生剧情）：\n${body.trim()}`
    const compact = `${meta.title}（想法，未展开）`
    const fullTokens = estimateTokens(text, charsPerToken)
    if (tokens + fullTokens <= MAX_IDEA_TOKENS) {
      materials.push(makeIdeaMaterial(meta, text, compact, false))
      tokens += fullTokens
      count += 1
    } else if (tokens + estimateTokens(compact, charsPerToken) <= MAX_IDEA_TOKENS) {
      materials.push(makeIdeaMaterial(meta, compact, compact, true))
      tokens += estimateTokens(compact, charsPerToken)
      count += 1
      degraded.push({ sourceId, reason: 'budget' })
    } else {
      omitted.push({ sourceId, reason: 'budget' })
      continue
    }
    for (const forbidden of contract.mustNotHappen ?? []) {
      const needle = forbidden.trim()
      if (!needle) continue
      if (body.includes(needle) || meta.title.includes(needle)) {
        warnings.push(`想法「${meta.title}」提到合同禁区「${needle}」；合同优先，想法不要写成已发生剧情。`)
      }
    }
  }
  return { materials, withheld, omitted, degraded, warnings }
}

function makeIdeaMaterial(
  idea: import('./ideas.ts').IdeaView,
  text: string,
  compact: string,
  compacted: boolean,
): Material {
  return {
    sourceId: `idea:${idea.id}`,
    category: 'author',
    provenance: 'author',
    required: false,
    label: `作者想法：${idea.title}`,
    text,
    contentHash: hashText(text),
    visibility: 'author-only',
    purpose: '想法回灌',
    priority: idea.priority === 'high' ? 10 : 50,
    compact,
    ...(compacted ? { relevance: 0 } : {}),
  }
}

function ideaPriorityRank(priority: 'high' | 'normal' | 'low'): number {
  return priority === 'high' ? 0 : priority === 'normal' ? 1 : 2
}

function ideaScopeMatches(
  idea: import('./ideas.ts').IdeaView,
  contract: ChapterContract,
  options: { includeBookIdeas?: boolean },
): boolean {
  const scope = idea.scope
  if (scope.kind === 'chapter') return scope.ref === contract.chapter
  if (scope.kind === 'volume') return contract.volume !== undefined && scope.ref === contract.volume
  if (scope.kind === 'character') return contract.characters.includes(scope.ref)
  if (scope.kind === 'book') return options.includeBookIdeas === true
  // World/mechanic ideas are global, but still capped and ranked like every other idea.
  return true
}

/**
 * Collects every chapter-level input once. Segmented generation reuses this bundle and only
 * re-assembles the prompt per segment, so ledger/search reads are not repeated per segment.
 */
export async function prepareChapterContextInputs(
  root: string,
  contract: ChapterContract,
  options: {
    authorSamples?: 'scene' | 'legacy' | 'off'
    modelConfig?: import('./types.ts').ModelConfig
    /** Explicit author opt-in for book-scoped promoted ideas. */
    includeBookIdeas?: boolean
  } = {},
): Promise<{
  modelConfig: import('./types.ts').ModelConfig
  materials: Material[]
  sampleSelection: import('./style.ts').AuthorSampleSelection
  methodSelection: import('./methods.ts').MethodSelection
  withheld: WithheldMaterial[]
  ideaOmitted: Array<{ sourceId: string; reason: 'budget' }>
  ideaDegraded: Array<{ sourceId: string; reason: 'budget' }>
  conflictWarnings: string[]
}> {
  const modelConfig = options.modelConfig ?? resolveTaskConfig(await loadModelConfig(root), 'writing')
  const { materials, sampleSelection, methodSelection, withheld, ideaOmitted, ideaDegraded, ideaWarnings } = await collectMaterialBundle(root, contract, {
    authorSamples: options.authorSamples,
    includeBookIdeas: options.includeBookIdeas,
    charsPerToken: modelConfig.charsPerToken,
  })
  const conflictWarnings: string[] = [...ideaWarnings]
  const head = await readMainline(root)
  const chaptersWithStages = [...Object.keys(head.selectedCommitByChapter).map(Number), contract.chapter]
  for (const record of await listUnresolvedPending(root, chaptersWithStages)) {
    if (!contract.characters.includes(record.subject)) continue
    conflictWarnings.push(
      `第 ${record.chapter} 章未裁决冲突：${record.subject} 的 ${record.predicate} 账本为「${record.priorObject}」，正文写「${record.object}」；执行 weave pending ${record.chapter} 裁决`,
    )
  }
  return { modelConfig, materials, sampleSelection, methodSelection, withheld, ideaOmitted, ideaDegraded, conflictWarnings }
}

/**
 * 与 writeChapter 共用的装配入口：预览（weave context / /api/context/preview）和实际生成
 * 必须走同一函数、同一参数，contextHash 才能互为凭证。
 */
export async function assembleChapterContext(
  root: string,
  contract: ChapterContract,
  options: {
    authorSamples?: 'scene' | 'legacy' | 'off'
    beatText?: string
    /** Segmented generation: current segment task. */
    segment?: import('./context.ts').SegmentPromptContext
    /** writeChapter 复用自己的写作任务配置；预览不传时由本函数加载同一配置。 */
    modelConfig?: import('./types.ts').ModelConfig
    /** Explicit author opt-in for book-scoped promoted ideas. */
    includeBookIdeas?: boolean
  } = {},
): Promise<{
  decision: import('./types.ts').MaterialDecision
  context: import('./context.ts').AssembledContext | null
  sampleSelection: import('./style.ts').AuthorSampleSelection
  methodSelection: import('./methods.ts').MethodSelection
  /** 作者可见警告：涉及本章角色的未裁决账本冲突。不进 prompt、不影响 contextHash。 */
  conflictWarnings: string[]
}> {
  const prepared = await prepareChapterContextInputs(root, contract, options)
  const assembled = assembleContext(contract, prepared.materials, prepared.modelConfig, {
    ...(options.beatText ? { beatText: options.beatText } : {}),
    ...(options.segment ? { segment: options.segment } : {}),
    withheld: prepared.withheld,
    preOmitted: prepared.ideaOmitted,
  })
  if (assembled.context && prepared.ideaDegraded.length > 0) {
    assembled.context.degraded = [...assembled.context.degraded, ...prepared.ideaDegraded]
  }
  return {
    decision: assembled.decision,
    context: assembled.context,
    sampleSelection: prepared.sampleSelection,
    methodSelection: prepared.methodSelection,
    conflictWarnings: prepared.conflictWarnings,
  }
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
    previousContract.location === contract.location || sharesLocationToken(previousContract.location, contract.location)
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
  const baseByte = Buffer.byteLength(prose.slice(0, excerpt.offset), 'utf8')
  const paragraphs = paragraphSpans(excerpt.text, baseByte)
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
  const offset = Math.max(0, text.lastIndexOf(joined))
  return { text: joined, offset }
}

function paragraphSpans(text: string, baseByte = 0): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const part of text.split(/\n{2,}/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const index = text.indexOf(trimmed, cursor)
    if (index < 0) continue
    spans.push({
      start: baseByte + Buffer.byteLength(text.slice(0, index), 'utf8'),
      end: baseByte + Buffer.byteLength(text.slice(0, index + trimmed.length), 'utf8'),
    })
    cursor = index + trimmed.length
  }
  return spans
}

const REGION_PREFIX = /^(?:海港|旧港|港口|雾港|港区|旧城|城区|城南|城北|城东|城西|小镇)+/
const PORT_SCENE_CLUSTER = /(?:码头|泊位|栈桥|船坞|[一二三四五六七八九十0-9]+号仓|货仓|仓库|冷库|货柜)/

function sharesLocationToken(left: string, right: string): boolean {
  const cleanLeft = left.replace(/\s+/g, '')
  const cleanRight = right.replace(/\s+/g, '')
  if (cleanLeft.length < 2 || cleanRight.length < 2) return false
  if (cleanLeft.includes(cleanRight) || cleanRight.includes(cleanLeft)) return true
  const coreLeft = cleanLeft.replace(REGION_PREFIX, '')
  const coreRight = cleanRight.replace(REGION_PREFIX, '')
  if (coreLeft.length >= 2 && coreRight.length >= 2) {
    for (let index = 0; index + 2 <= coreLeft.length; index += 1) {
      const token = coreLeft.slice(index, index + 2)
      if (coreRight.includes(token)) return true
    }
  }
  if (PORT_SCENE_CLUSTER.test(cleanLeft) && PORT_SCENE_CLUSTER.test(cleanRight)) {
    return true
  }
  return false
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

  const loops = await collectLoopState(root, Math.max(0, contract.chapter - 1)).catch(() => null)
  const openLoopQueries = (loops?.loops ?? [])
    .filter(loop => loop.status !== 'paid_off' && loop.status !== 'abandoned')
    .filter(loop => loop.relatedEntities.includes(contract.pov) || loop.relatedEntities.length === 0)
    .slice(0, 2)
    .map(loop => {
      if (contract.narrativeMode === 'omniscient') return loop.summary.trim().slice(0, 60)
      return (loop.evidence[0]?.quote ?? '').trim().slice(0, 60)
    })
    .filter(Boolean)
  const queries = [...new Set([...retrievalQueries(contract), ...openLoopQueries])]
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
      compact: `人物弧（本章未展开）：${relevantArcs.map(arc => arc.name).join('、')}`,
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
      compact: `当前卷弧：第 ${current.volume} 卷（本章未展开）`,
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
      compact: `滚动章纲：第 ${upcoming[0]!.chapter}–${upcoming[upcoming.length - 1]!.chapter} 章（本章未展开）`,
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

function formatFactForPrompt(fact: LedgerFact): {
  subject: string
  predicate: string
  object: string
  fromChapter: number
} {
  return {
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    fromChapter: fact.validFromChapter,
  }
}

function formatBeliefForPrompt(belief: LedgerBelief): {
  character: string
  attitude: LedgerBelief['attitude']
  proposition: string
  fromChapter: number
} {
  return {
    character: belief.characterId,
    attitude: belief.attitude,
    proposition: belief.proposition,
    fromChapter: belief.learnedAtChapter,
  }
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
