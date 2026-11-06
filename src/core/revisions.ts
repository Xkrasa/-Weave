import path from 'node:path'
import type {
  CoverageAudit,
  ContentCheckReport,
  DraftParagraph,
  ExtractionReport,
  MergeHunk,
  MergeReport,
  ReviewFinding,
  ReviewReport,
  RevisionCandidate,
  RevisionInstruction,
} from './stage-types.ts'
import type { ChapterContract, ModelConfig } from './types.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { recordMergeAccepted, recordPreferenceSignal } from './preferences.ts'
import { draftHash, loadStage, readDraft, resolveEvidence, saveStage } from './stages.ts'
import { atomicWrite, atomicWriteJson, ensureDir, normalizeText, readJsonIfExists } from './io.ts'
import { objectHash, hashText } from './hash.ts'
import { projectPaths } from './project.ts'
import { draftPath } from './ledger.ts'
import { chapterFileStem, loadContract, requirePassingContractCheck } from './contract.ts'
import { conflictError, validationError } from './errors.ts'
import { applyWaivers } from './waivers.ts'
import { loadMethods, methodText, selectMethods } from './methods.ts'
import { loadStyleConstitution, selectAuthorSamples, styleText } from './style.ts'
import { collectLedger, effectiveBeliefs, effectiveFacts } from './story-ledger.ts'
import type { EffectFinding, EffectReviewReport } from './effect-review.ts'

const REVISION_SYSTEM = [
  '你是小说修稿器。只修改请求中列出的段落，不重写整章。',
  '只输出 JSON 对象，不要解释或 Markdown 围栏。',
  '输出段落必须使用输入中的 paragraphId；无法定位的段落不要输出。',
].join('\n')

const RECHECK_SYSTEM = [
  '你是修稿复检器。只判断列出的 finding 是否已经解决，并报告新引入的问题。',
  '只输出 JSON 对象，不要解释或 Markdown 围栏。',
  '不得声称已解决而没有正文证据；无法判断时 resolved=false。',
].join('\n')

export interface RevisionPlanView {
  chapter: number
  draftHash: string
  createdAt: string
  findings: ReviewFinding[]
  instructions: RevisionInstruction[]
}


/**
 * Extra creative context for line edits: neighbours, contract, POV knowledge, style samples,
 * routed methods, and the constraints the rewrite must not break.
 */
async function revisionContext(
  root: string,
  chapter: number,
  contract: ChapterContract,
  paragraphs: DraftParagraph[],
  targetIds: Set<string>,
): Promise<string[]> {
  const prior = await collectLedger(root, Math.max(0, chapter - 1))
  const povFacts = effectiveFacts(prior.facts, Math.max(0, chapter - 1))
    .filter(fact => fact.subject === contract.pov)
  const povBeliefs = effectiveBeliefs(prior.beliefs, contract.pov, Math.max(0, chapter - 1))
  const style = await loadStyleConstitution(root)
  const { samples: selectedSamples } = await selectAuthorSamples(root, contract, { limit: 1, maxTokens: 800 })
  const samples = selectedSamples.map(sample => sample.text.slice(0, 800))
  const selection = await selectMethods(root, chapter, { purpose: 'rewrite' })
  const library = await loadMethods(root)
  const methods = library.filter(module => selection.modules.some(item => item.id === module.id))
  const neighbours = neighbourParagraphs(paragraphs, targetIds, 2)
  return [
    '本章合同：',
    JSON.stringify(contract, null, 2),
    '',
    '视角知识：',
    JSON.stringify({ pov: contract.pov, facts: povFacts, beliefs: povBeliefs }, null, 2),
    '',
    '风格宪法：',
    styleText(style),
    ...(samples.length > 0 ? ['', '作者样本：', samples.join('\n---\n')] : []),
    ...(methods.length > 0 ? ['', '可用方法：', methods.map(methodText).join('\n\n')] : []),
    '',
    '前后文（role=target 的段落才可修改，其余只用于衔接）：',
    JSON.stringify(neighbours, null, 2),
    '',
    '不可改变：',
    JSON.stringify({
      mustHappen: contract.mustHappen,
      mustNotHappen: contract.mustNotHappen,
      facts: povFacts.map(fact => `${fact.subject}.${fact.predicate}=${fact.object}`),
    }, null, 2),
    '',
    '要求：不得新增未经正文支持的关键事实，不得越出 POV 知识边界，不得为消除 finding 而删除合同硬节点，',
    '不得抹平作者样本中的辨识度表达；无法同时满足约束时返回失败，不要扩大修改范围。',
    '',
  ]
}

function neighbourParagraphs(
  paragraphs: DraftParagraph[],
  targetIds: Set<string>,
  radius: number,
): Array<{ paragraphId: string; text: string; role: 'before' | 'target' | 'after' }> {
  const keep = new Set<number>()
  paragraphs.forEach((paragraph, index) => {
    if (!targetIds.has(paragraph.paragraphId)) return
    for (let offset = -radius; offset <= radius; offset += 1) {
      const position = index + offset
      if (position >= 0 && position < paragraphs.length) keep.add(position)
    }
  })
  return [...keep]
    .sort((a, b) => a - b)
    .map(index => {
      const paragraph = paragraphs[index]!
      const role = targetIds.has(paragraph.paragraphId)
        ? 'target'
        : index < paragraphs.findIndex(item => targetIds.has(item.paragraphId)) ? 'before' : 'after'
      return { paragraphId: paragraph.paragraphId, text: paragraph.text, role }
    })
}

export async function reviseChapter(
  root: string,
  chapter: number,
  findingIds: string[],
  config: ModelConfig,
  signal: AbortSignal,
): Promise<{ candidate: RevisionCandidate; plan: RevisionPlanView }> {
  const draft = await readDraft(root, chapter)
  const currentHash = draftHash(draft)
  const loaded = await loadStage<ReviewReport>(root, 'review', chapter)
  const effectReport = await loadStage<EffectReviewReport>(root, 'effect-review', chapter)
  if (!loaded && !effectReport) throw validationError(`第 ${chapter} 章没有审查报告`)
  const report = loaded ? await applyWaivers(root, chapter, loaded) : null
  if (findingIds.length === 0) throw validationError('请指定要处理的 finding，例如 --findings f1,f2')

  const reviewSelected = report
    ? report.findings.filter(finding => findingIds.includes(finding.findingId))
    : []
  const effectSelected = effectReport
    ? effectReport.findings.filter(finding => findingIds.includes(finding.findingId))
    : []

  if (reviewSelected.length > 0 && report && report.draftHash !== currentHash) {
    throw conflictError('草稿在审查后已修改；请重新审查后再修稿')
  }
  if (effectSelected.length > 0 && effectReport && effectReport.draftHash !== currentHash) {
    throw conflictError('草稿在效果审查后已修改；请重新执行效果审查后再修稿')
  }
  if (reviewSelected.length === 0 && effectSelected.length === 0) {
    if (report && report.draftHash !== currentHash) {
      throw conflictError('草稿在审查后已修改；请重新审查后再修稿')
    }
    if (effectReport && effectReport.draftHash !== currentHash) {
      throw conflictError('草稿在效果审查后已修改；请重新执行效果审查后再修稿')
    }
  }

  const selected: Array<ReviewFinding | EffectFinding> = [...reviewSelected, ...effectSelected]
  if (selected.length !== findingIds.length) throw validationError('部分 finding 不存在')
  if (selected.some(finding => finding.status === 'waived' || finding.status === 'verified')) {
    throw validationError('waived 或 verified finding 不进入修稿计划')
  }
  if (selected.some(finding => finding.status === 'applied')) {
    throw validationError('finding 已经有修订候选；请先合并或重新审查')
  }

  for (const finding of selected) finding.status = 'planned'
  if (report && reviewSelected.length > 0) await saveStage(root, 'review', chapter, report)
  if (effectReport && effectSelected.length > 0) await saveStage(root, 'effect-review', chapter, effectReport)

  const paragraphs = paragraphsOf(draft)
  const instructions: RevisionInstruction[] = selected.map(finding => ({
    findingId: finding.findingId,
    paragraphIds: paragraphsForFinding(paragraphs, finding as ReviewFinding),
    goal: finding.description,
  }))
  if (instructions.some(item => item.paragraphIds.length === 0)) {
    throw validationError('部分 finding 缺少可定位段落，无法定向修稿')
  }
  const targetIds = new Set(instructions.flatMap(item => item.paragraphIds))
  const targetParagraphs = paragraphs.filter(paragraph => targetIds.has(paragraph.paragraphId))
  const contextMode = process.env.WEAVE_REVISION_CONTEXT === 'legacy' ? 'legacy' : 'enriched'
  const contract = await loadContract(root, chapter)
  const context = contextMode === 'enriched'
    ? await revisionContext(root, chapter, contract, paragraphs, targetIds)
    : []
  const prompt = [
    `第 ${chapter} 章修稿。`,
    ...context,
    '待处理 finding：',
    JSON.stringify(selected.map(finding => ({
      findingId: finding.findingId,
      dimension: finding.dimension,
      severity: finding.severity,
      description: finding.description,
      quote: finding.quote,
    })), null, 2),
    '',
    '只能修改以下段落，保持 paragraphId 不变：',
    JSON.stringify(targetParagraphs, null, 2),
    '',
    '输出结构：',
    JSON.stringify({
      paragraphs: [{ paragraphId: 'p001', text: '修改后的完整段落', findingIds: ['f1'] }],
    }, null, 2),
  ].join('\n')
  const taskConfig = resolveTaskConfig(config, 'revision')
  const model = taskConfig.model
  const result = await completeJsonObject({
    config: { ...taskConfig, model },
    system: REVISION_SYSTEM,
    user: prompt,
    signal,
  })
  await appendUsage(root, { task: 'revision', model, usage: result.usage })
  const raw = result.raw
  const rawParagraphs = Array.isArray(raw.paragraphs) ? raw.paragraphs : []
  const changed: DraftParagraph[] = []
  const rejected: RevisionCandidate['rejected'] = []
  const baseIds = new Set(paragraphs.map(paragraph => paragraph.paragraphId))
  for (const item of rawParagraphs) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (!entry || typeof entry.paragraphId !== 'string' || typeof entry.text !== 'string') {
      rejected.push({ reason: '修订段落缺少 paragraphId 或 text' })
      continue
    }
    if (!baseIds.has(entry.paragraphId)) {
      rejected.push({ paragraphId: entry.paragraphId, reason: '修订段落不在原稿中' })
      continue
    }
    if (!targetIds.has(entry.paragraphId)) {
      rejected.push({ paragraphId: entry.paragraphId, reason: '修订段落超出 selected finding 范围' })
      continue
    }
    if (!entry.text.trim()) {
      rejected.push({ paragraphId: entry.paragraphId, reason: '修订段落为空' })
      continue
    }
    changed.push({
      paragraphId: entry.paragraphId,
      text: entry.text,
      findingIds: Array.isArray(entry.findingIds)
        ? entry.findingIds.filter((value): value is string => typeof value === 'string')
        : undefined,
    })
  }
  if (changed.length === 0) throw validationError('修稿模型没有返回可用段落', rejected)
  const revision: RevisionCandidate = {
    schemaVersion: 1,
    revisionId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chapter,
    baseDraftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    model,
    usage: result.usage,
    raw: result.text,
    findings: selected.map(finding => finding.findingId),
    instructions,
    contextMode,
    baseParagraphs: paragraphs,
    paragraphs: changed,
    rejected,
  }
  await ensureDir(revisionDir(root, chapter))
  await atomicWriteJson(candidatePath(root, chapter, revision.revisionId), revision)

  for (const finding of selected) {
    finding.status = 'applied'
    finding.revisionId = revision.revisionId
    finding.paragraphIds = instructions.find(item => item.findingId === finding.findingId)?.paragraphIds
  }
  if (report && reviewSelected.length > 0) await saveStage(root, 'review', chapter, report)
  if (effectReport && effectSelected.length > 0) await saveStage(root, 'effect-review', chapter, effectReport)
  return {
    candidate: revision,
    plan: {
      chapter,
      draftHash: revision.baseDraftHash,
      createdAt: revision.createdAt,
      findings: selected as ReviewFinding[],
      instructions,
    },
  }
}

export async function rewriteParagraph(
  root: string,
  chapter: number,
  paragraphId: string,
  goal: string,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<RevisionCandidate> {
  if (!goal.trim()) throw validationError('局部改写必须提供目标')
  const draft = await readDraft(root, chapter)
  const paragraphs = paragraphsOf(draft)
  const target = paragraphs.find(paragraph => paragraph.paragraphId === paragraphId)
  if (!target) throw validationError(`未找到段落：${paragraphId}`)
  const selection = await selectMethods(root, chapter, { purpose: 'rewrite' })
  const library = await loadMethods(root)
  const methods = library.filter(module => selection.modules.some(item => item.id === module.id))
  const contract = await loadContract(root, chapter)
  const prior = await collectLedger(root, Math.max(0, chapter - 1))
  const povFacts = effectiveFacts(prior.facts, Math.max(0, chapter - 1))
    .filter(fact => fact.subject === contract.pov)
  const povBeliefs = effectiveBeliefs(prior.beliefs, contract.pov, Math.max(0, chapter - 1))
  const style = await loadStyleConstitution(root)
  const { samples } = await selectAuthorSamples(root, contract)
  const prompt = [
    `第 ${chapter} 章局部改写。目标：${goal}`,
    `只改写 ${paragraphId}，其他段落保持不变。`,
    '当前段落：',
    target.text,
    '',
    '视角知识：',
    JSON.stringify({ pov: contract.pov, facts: povFacts, beliefs: povBeliefs }, null, 2),
    '',
    '风格宪法：',
    styleText(style),
    samples.length > 0 ? `作者样本：\n${samples.map(sample => sample.text).join('\n---\n')}` : '',
    '',
    '可用方法：',
    methods.map(methodText).join('\n\n'),
    '',
    '只输出：',
    JSON.stringify({ text: '改写后的完整段落' }, null, 2),
  ].filter(Boolean).join('\n')
  const taskConfig = resolveTaskConfig(config, 'revision')
  const model = taskConfig.model
  const result = await completeJsonObject({
    config: { ...taskConfig, model },
    system: REVISION_SYSTEM,
    user: prompt,
    signal,
  })
  await appendUsage(root, { task: 'revision', model, usage: result.usage })
  const raw = result.raw
  const text = typeof raw.text === 'string'
    ? raw.text.trim()
    : Array.isArray(raw.paragraphs)
      ? String((raw.paragraphs[0] as Record<string, unknown> | undefined)?.text ?? '').trim()
      : ''
  if (!text) throw validationError('局部改写模型没有返回可用段落')
  const candidate: RevisionCandidate = {
    schemaVersion: 1,
    revisionId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chapter,
    baseDraftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    model,
    usage: result.usage,
    raw: result.text,
    findings: [],
    instructions: [{ findingId: 'rewrite', paragraphIds: [paragraphId], goal }],
    baseParagraphs: paragraphs,
    paragraphs: [{ paragraphId, text }],
    rejected: [],
  }
  await ensureDir(revisionDir(root, chapter))
  await atomicWriteJson(candidatePath(root, chapter, candidate.revisionId), candidate)
  return candidate
}

export type SelectionOperation = 'polish' | 'expand' | 'correct' | 'custom'

export interface SelectionRevisionCandidate extends RevisionCandidate {
  selection: {
    selectedText: string
    replacement: string
    occurrence: number
    operation: SelectionOperation
    instruction?: string
    targetParagraphIds: string[]
  }
}

export interface SelectionMergeReport extends MergeReport {
  durationMs: number
}

export async function reviseSelection(
  root: string,
  chapter: number,
  input: {
    baseDraftHash: string
    selectedText: string
    occurrence?: number
    operation: SelectionOperation
    instruction?: string
  },
  config: ModelConfig,
  signal: AbortSignal,
): Promise<SelectionRevisionCandidate> {
  const draft = await readDraft(root, chapter)
  if (draftHash(draft) !== input.baseDraftHash) throw conflictError('草稿在划词后已变化，请重新选择')
  const selectedText = normalizeText(input.selectedText)
  if (!selectedText.trim()) throw validationError('划词内容不能为空')
  if (!['polish', 'expand', 'correct', 'custom'].includes(input.operation)) throw validationError('未知的划词操作')
  if (input.operation === 'custom' && !input.instruction?.trim()) throw validationError('自定义划词操作需要填写修改要求')
  const occurrences = textOccurrences(draft, selectedText)
  if (occurrences.length === 0) throw validationError('选文不在当前草稿中')
  if (input.occurrence === undefined && occurrences.length > 1) throw validationError('选文重复出现，请提供 occurrence')
  const occurrence = input.occurrence ?? 1
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > occurrences.length) {
    throw validationError(`选文出现 ${occurrences.length} 次，occurrence 无法定位`)
  }

  const paragraphs = paragraphsOf(draft)
  const targetIds = new Set(paragraphs.filter(paragraph =>
    paragraph.text.includes(selectedText) || selectedText.includes(paragraph.text),
  ).map(paragraph => paragraph.paragraphId))
  if (targetIds.size === 0) throw validationError('无法确定选区所属段落')
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  const context = await revisionContext(root, chapter, contract, paragraphs, targetIds)
  const goal = input.operation === 'polish'
    ? '润色选区，保留原意、事实和人物声音'
    : input.operation === 'expand'
      ? '仅基于已有事实扩写选区，不新增关键设定、人物认知或合同外剧情'
      : input.operation === 'correct'
        ? '纠正选区中的错别字、语病和不连贯表达，不改变剧情'
        : input.instruction!.trim()
  const prompt = [
    `第 ${chapter} 章划词修稿。只允许返回授权选区的替换文字。`,
    `操作目标：${goal}`,
    '不得修改选区外的任何文字，不得改变事实、POV、合同硬节点或人物声音。',
    '如果无法在不越界的前提下修改，请返回空字符串，不要返回整章或整段原文。',
    '',
    ...context,
    '',
    '授权选区原文：',
    selectedText,
    '',
    '只输出：',
    JSON.stringify({ text: '替换后的选区文字' }, null, 2),
  ].join('\n')
  const taskConfig = resolveTaskConfig(config, 'revision')
  const model = taskConfig.model
  const result = await completeJsonObject({
    config: { ...taskConfig, model },
    system: REVISION_SYSTEM,
    user: prompt,
    signal,
  })
  await appendUsage(root, { task: 'revision', model, usage: result.usage })
  const replacement = typeof result.raw.text === 'string'
    ? result.raw.text.trim()
    : Array.isArray(result.raw.paragraphs)
      ? String((result.raw.paragraphs[0] as Record<string, unknown> | undefined)?.text ?? '').trim()
      : ''
  if (!replacement) throw validationError('划词修稿没有返回可用替换文字')
  if (replacement === selectedText) throw validationError('划词修稿没有改变选区内容')
  if (!selectedText.includes('\n\n') && /\n\s*\n/.test(replacement)) {
    throw validationError('划词修稿返回了超出授权选区的多段文字')
  }
  const revisedDraft = replaceTextOccurrence(draft, selectedText, replacement, occurrence)
  const revision: SelectionRevisionCandidate = {
    schemaVersion: 1,
    revisionId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chapter,
    baseDraftHash: input.baseDraftHash,
    createdAt: new Date().toISOString(),
    model,
    usage: result.usage,
    raw: result.text,
    findings: [`selection-${input.operation}`],
    instructions: [{ findingId: `selection-${input.operation}`, paragraphIds: [...targetIds], goal }],
    contextMode: 'enriched',
    baseParagraphs: paragraphs,
    paragraphs: paragraphsOf(revisedDraft).filter(paragraph => targetIds.has(paragraph.paragraphId)),
    rejected: [],
    selection: {
      selectedText,
      replacement,
      occurrence,
      operation: input.operation,
      ...(input.instruction?.trim() ? { instruction: input.instruction.trim() } : {}),
      targetParagraphIds: [...targetIds],
    },
  }
  await ensureDir(revisionDir(root, chapter))
  await atomicWriteJson(candidatePath(root, chapter, revision.revisionId), revision)
  return revision
}

export async function discardSelectionRevision(
  root: string,
  chapter: number,
  revisionId: string,
): Promise<{ status: 'discarded'; revisionId: string }> {
  const candidate = await loadRevision(root, chapter, revisionId)
  if (!('selection' in candidate)) throw validationError('该修订不是划词候选')
  await recordPreferenceSignal(root, {
    kind: 'rejected',
    source: 'ignore',
    chapter,
    dimension: `快速编辑:${candidate.selection.operation}`,
    revisionId,
  })
  return { status: 'discarded', revisionId }
}

export async function loadRevision(
  root: string,
  chapter: number,
  revisionId: string,
): Promise<RevisionCandidate | SelectionRevisionCandidate> {
  const candidate = await readJsonIfExists<RevisionCandidate>(candidatePath(root, chapter, revisionId))
  if (!candidate) throw validationError(`未找到修订候选：${revisionId}`)
  return candidate
}

async function mergeSelectionRevision(
  root: string,
  chapter: number,
  candidate: SelectionRevisionCandidate,
): Promise<SelectionMergeReport> {
  const draft = await readDraft(root, chapter)
  const selection = candidate.selection
  const hunks: MergeHunk[] = [{
    paragraphId: 'selection',
    base: selection.selectedText,
    revision: selection.replacement,
    manual: selection.selectedText,
    status: 'revision-only',
    findingIds: candidate.findings,
  }]
  if (draftHash(draft) !== candidate.baseDraftHash) {
    const report: SelectionMergeReport = {
      schemaVersion: 1,
      chapter,
      revisionId: candidate.revisionId,
      createdAt: new Date().toISOString(),
      status: 'conflict',
      baseDraftHash: candidate.baseDraftHash,
      mergedDraftHash: null,
      hunks: [{ ...hunks[0]!, status: 'conflict' }],
      durationMs: Math.max(0, Date.now() - Date.parse(candidate.createdAt)),
    }
    await ensureDir(revisionDir(root, chapter))
    await atomicWriteJson(mergePath(root, chapter, candidate.revisionId), report)
    return report
  }
  const occurrences = textOccurrences(draft, selection.selectedText)
  const start = occurrences[selection.occurrence - 1]
  if (start === undefined) {
    const report: SelectionMergeReport = {
      schemaVersion: 1,
      chapter,
      revisionId: candidate.revisionId,
      createdAt: new Date().toISOString(),
      status: 'conflict',
      baseDraftHash: candidate.baseDraftHash,
      mergedDraftHash: null,
      hunks: [{ ...hunks[0]!, status: 'conflict' }],
      durationMs: Math.max(0, Date.now() - Date.parse(candidate.createdAt)),
    }
    await ensureDir(revisionDir(root, chapter))
    await atomicWriteJson(mergePath(root, chapter, candidate.revisionId), report)
    return report
  }
  const text = replaceTextOccurrence(draft, selection.selectedText, selection.replacement, selection.occurrence)
  await atomicWrite(draftPath(root, chapter), text)
  await recordMergeAccepted(root, chapter, candidate.revisionId, [`快速编辑:${selection.operation}`]).catch(() => {})
  const report: SelectionMergeReport = {
    schemaVersion: 1,
    chapter,
    revisionId: candidate.revisionId,
    createdAt: new Date().toISOString(),
    status: 'merged',
    baseDraftHash: candidate.baseDraftHash,
    mergedDraftHash: draftHash(text),
    hunks,
    durationMs: Math.max(0, Date.now() - Date.parse(candidate.createdAt)),
  }
  await ensureDir(revisionDir(root, chapter))
  await atomicWriteJson(mergePath(root, chapter, candidate.revisionId), report)
  return report
}

export async function mergeRevision(
  root: string,
  chapter: number,
  revisionId: string,
  choices: Record<string, 'base' | 'revision' | 'manual'> = {},
): Promise<MergeReport | SelectionMergeReport> {
  const candidate = await loadRevision(root, chapter, revisionId)
  if ('selection' in candidate) return mergeSelectionRevision(root, chapter, candidate)
  const manualDraft = await readDraft(root, chapter)
  const base = mapParagraphs(candidate.baseParagraphs)
  const revision = mapParagraphs(candidate.paragraphs)
  const manual = mapParagraphs(paragraphsOf(manualDraft))
  const ids = [...new Set([...base.keys(), ...revision.keys(), ...manual.keys()])].sort()
  for (const paragraphId of Object.keys(choices)) {
    if (!ids.includes(paragraphId)) throw validationError(`--choices 包含不存在的段落：${paragraphId}`)
  }
  const hunks: MergeHunk[] = []
  let conflict = false
  for (const paragraphId of ids) {
    const baseText = base.get(paragraphId) ?? ''
    const revisionText = revision.get(paragraphId) ?? baseText
    const manualText = manual.has(paragraphId) ? manual.get(paragraphId)! : ''
    const revisionChanged = revisionText !== baseText
    const manualChanged = manualText !== baseText
    const findingIds = candidate.instructions
      .filter(item => item.paragraphIds.includes(paragraphId))
      .map(item => item.findingId)
    const choice = choices[paragraphId]
    if (revisionChanged && manualChanged && revisionText !== manualText && !choice) {
      conflict = true
      hunks.push({
        paragraphId,
        base: baseText,
        revision: revisionText,
        manual: manualText,
        status: 'conflict',
        findingIds,
      })
      continue
    }
    hunks.push({
      paragraphId,
      base: baseText,
      revision: revisionText,
      manual: manualText,
      status: choice
        ? 'auto'
        : revisionChanged && !manualChanged
          ? 'revision-only'
          : manualChanged && !revisionChanged ? 'manual-only' : 'auto',
      ...(choice ? { resolution: choice } : {}),
      findingIds,
    })
  }
  const resolved = hunks.filter(hunk => hunk.status !== 'conflict')
  if (conflict) {
    const report: MergeReport = {
      schemaVersion: 1,
      chapter,
      revisionId,
      createdAt: new Date().toISOString(),
      status: 'conflict',
      baseDraftHash: candidate.baseDraftHash,
      mergedDraftHash: null,
      hunks,
    }
    await ensureDir(revisionDir(root, chapter))
    await atomicWriteJson(mergePath(root, chapter, revisionId), report)
    return report
  }
  const text = resolved.map(hunk => {
    if (hunk.status === 'manual-only') return hunk.manual
    if (hunk.status === 'revision-only') return hunk.revision
    const choice = choices[hunk.paragraphId]
    if (choice === 'manual') return hunk.manual
    if (choice === 'revision') return hunk.revision
    if (choice === 'base') return hunk.base
    if (hunk.revision === hunk.base) return hunk.manual
    if (hunk.manual === hunk.base) return hunk.revision
    return hunk.revision
  }).filter(Boolean).join('\n\n')
  if (!text.trim()) throw validationError('合并结果为空')
  await atomicWrite(draftPath(root, chapter), `${text}\n`)
  const report: MergeReport = {
    schemaVersion: 1,
    chapter,
    revisionId,
    createdAt: new Date().toISOString(),
    status: 'merged',
    baseDraftHash: candidate.baseDraftHash,
    mergedDraftHash: hashText(`${text}\n`),
    hunks,
  }
  await ensureDir(revisionDir(root, chapter))
  await atomicWriteJson(mergePath(root, chapter, revisionId), report)
  if (candidate.findings.length > 0) {
    const reviewReport = await loadStage<ReviewReport>(root, 'review', chapter)
    const effectReport = await loadStage<EffectReviewReport>(root, 'effect-review', chapter)
    const allFindings = [
      ...(reviewReport?.findings ?? []),
      ...(effectReport?.findings ?? []),
    ]
    const dimensions = [...new Set(
      allFindings
        .filter(item => candidate.findings.includes(item.findingId))
        .map(item => item.dimension)
        .filter(Boolean),
    )]
    await recordMergeAccepted(root, chapter, revisionId, dimensions).catch(() => {})
  }
  return report
}

export type RecheckResult = ReviewReport | EffectReviewReport

export async function recheckChapter(
  root: string,
  chapter: number,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<RecheckResult> {
  const report = await loadStage<ReviewReport>(root, 'review', chapter)
  const effectReport = await loadStage<EffectReviewReport>(root, 'effect-review', chapter)
  if (!report && !effectReport) throw validationError(`第 ${chapter} 章没有审查报告`)
  const reviewApplied = report ? report.findings.filter(finding => finding.status === 'applied') : []
  const effectApplied = effectReport ? effectReport.findings.filter(finding => finding.status === 'applied') : []
  const applied: Array<ReviewFinding | EffectFinding> = [...reviewApplied, ...effectApplied]
  if (applied.length === 0) throw validationError('没有 applied finding，无法复检')
  const draft = await readDraft(root, chapter)
  const currentHash = draftHash(draft)
  const check = await loadStage<ContentCheckReport>(root, 'content-check', chapter)
  const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter)
  const audit = await loadStage<CoverageAudit>(root, 'audit', chapter)
  if (reviewApplied.length > 0) {
    if (!check || check.draftHash !== currentHash) {
      throw conflictError('合并后需要先重新运行 weave check')
    }
    if (!extraction || extraction.draftHash !== currentHash) {
      throw conflictError('合并后需要先重新运行 weave extract')
    }
    if (!audit || audit.draftHash !== currentHash) {
      throw conflictError('合并后需要先重新运行 weave audit')
    }
  }
  const revisionIds = [...new Set(applied.map(finding => finding.revisionId).filter((id): id is string => Boolean(id)))]
  let merged = false
  for (const revisionId of revisionIds) {
    const mergeReport = await readJsonIfExists<MergeReport>(mergePath(root, chapter, revisionId))
    if (mergeReport?.status === 'merged' && mergeReport.mergedDraftHash === currentHash) {
      merged = true
      break
    }
  }
  if (!merged) throw conflictError('修订尚未合并到当前草稿；请先执行 weave merge')
  const paragraphs = paragraphsOf(draft)
  const targetIds = new Set(applied.flatMap(finding => finding.paragraphIds ?? []))
  const targets = paragraphs.filter(paragraph => targetIds.has(paragraph.paragraphId))
  const prompt = [
    `第 ${chapter} 章复检。`,
    '待复检 finding：',
    JSON.stringify(applied.map(finding => ({
      findingId: finding.findingId,
      dimension: finding.dimension,
      description: finding.description,
      quote: finding.quote,
    })), null, 2),
    '',
    '当前相关段落：',
    JSON.stringify(targets, null, 2),
    '',
    '只输出：',
    JSON.stringify({
      summary: '复检结论',
      findings: [{ findingId: 'f1', resolved: true, note: '已补充来源', quote: '正文逐字引文' }],
      newFindings: [{
        dimension: '叙事衔接',
        severity: 'warning',
        description: '新问题',
        quote: '正文逐字引文',
        occurrence: 1,
      }],
    }, null, 2),
  ].join('\n')
  const taskConfig = resolveTaskConfig(config, 'revision')
  const model = taskConfig.model
  const result = await completeJsonObject({
    config: { ...taskConfig, model },
    system: RECHECK_SYSTEM,
    user: prompt,
    signal,
  })
  await appendUsage(root, { task: 'revision', model, usage: result.usage })
  const raw = result.raw
  const resolvedMap = new Map<string, { resolved: boolean; quote?: string; note?: string }>()
  if (Array.isArray(raw.findings)) {
    for (const item of raw.findings) {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
      if (!entry || typeof entry.findingId !== 'string') continue
      resolvedMap.set(entry.findingId, {
        resolved: entry.resolved === true,
        quote: typeof entry.quote === 'string' ? entry.quote : undefined,
        note: typeof entry.note === 'string' ? entry.note : undefined,
      })
    }
  }
  for (const finding of applied) {
    const res = resolvedMap.get(finding.findingId)
    let resolved = res?.resolved === true
    if (resolved && res?.quote) {
      try {
        finding.evidence = resolveEvidence(draft, chapter, res.quote)
        finding.quote = res.quote
      } catch {
        resolved = false
      }
    } else if (resolved) {
      resolved = false
    }
    finding.status = resolved ? 'verified' : 'open'
    finding.recheckNote = res?.note
    finding.recheckedAt = new Date().toISOString()
  }
  if (effectReport && effectApplied.length > 0) {
    effectReport.draftHash = currentHash
    if (result.usage) effectReport.usage = result.usage
    await saveStage(root, 'effect-review', chapter, effectReport)
  }
  if (!report || reviewApplied.length === 0) {
    if (!effectReport) throw validationError('没有可复检的审查报告')
    return effectReport
  }
  let nextId = report.findings.reduce((max, finding) => {
    const match = /^f(\d+)$/.exec(finding.findingId)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0) + 1
  const newFindings = Array.isArray(raw.newFindings) ? raw.newFindings : []
  for (const item of newFindings) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (!entry || typeof entry.description !== 'string' || !entry.description.trim()) continue
    const severity = entry.severity === 'blocking' || entry.severity === 'info' ? entry.severity : 'warning'
    const finding: ReviewFinding = {
      findingId: `f${nextId}`,
      dimension: typeof entry.dimension === 'string' ? entry.dimension : '复检新增',
      severity,
      description: entry.description.trim(),
      status: 'open',
    }
    nextId += 1
    if (typeof entry.quote === 'string' && entry.quote.trim()) {
      finding.evidence = resolveEvidence(
        draft,
        chapter,
        entry.quote,
        typeof entry.occurrence === 'number' ? entry.occurrence : undefined,
      )
      finding.quote = entry.quote
    } else if (severity === 'blocking') {
      throw validationError('复检新增 blocking 缺少正文证据')
    }
    report.findings.push(finding)
  }
  report.draftHash = currentHash
  if (extraction) report.extractionHash = objectHash(extraction)
  if (audit) report.auditHash = objectHash(audit)
  report.blockingCount = report.findings.filter(
    finding => finding.severity === 'blocking' && finding.status !== 'verified' && finding.status !== 'waived',
  ).length
  report.passed = report.blockingCount === 0
  if (result.usage) report.usage = result.usage
  await saveStage(root, 'review', chapter, report)
  return report
}

export async function ignoreFinding(
  root: string,
  chapter: number,
  findingId: string,
  reason: string,
): Promise<ReviewFinding> {
  const report = await loadStage<ReviewReport>(root, 'review', chapter)
  const effectReport = await loadStage<EffectReviewReport>(root, 'effect-review', chapter)
  if (!report && !effectReport) throw validationError(`第 ${chapter} 章没有审查报告`)
  const reviewFinding = report?.findings.find(item => item.findingId === findingId)
  const effectFinding = !reviewFinding ? effectReport?.findings.find(item => item.findingId === findingId) : undefined
  const finding = reviewFinding ?? effectFinding
  if (!finding) throw validationError(`未找到 finding：${findingId}`)
  if (finding.severity === 'blocking') throw validationError('blocking finding 不能 ignore；请修复或显式豁免')
  if (finding.status === 'applied' || finding.status === 'verified') {
    throw validationError('已进入修稿或已复检的 finding 不能直接 ignore')
  }
  if (!reason.trim()) throw validationError('ignore 必须提供理由')
  finding.status = 'ignored'
  finding.ignoreReason = reason.trim()
  await recordPreferenceSignal(root, {
    kind: 'rejected', source: 'ignore', chapter, dimension: finding.dimension,
    reason: reason.trim(), findingId: finding.findingId,
  }).catch(() => {})
  if (reviewFinding && report) {
    report.blockingCount = report.findings.filter(
      item => item.severity === 'blocking' && item.status !== 'verified' && item.status !== 'waived',
    ).length
    report.passed = report.blockingCount === 0
    await saveStage(root, 'review', chapter, report)
  } else if (effectFinding && effectReport) {
    await saveStage(root, 'effect-review', chapter, effectReport)
  }
  return finding as ReviewFinding
}

function revisionDir(root: string, chapter: number): string {
  return path.join(projectPaths(root).revisions, chapterFileStem(chapter))
}

function textOccurrences(text: string, quote: string): number[] {
  const positions: number[] = []
  let index = text.indexOf(quote)
  while (index >= 0) {
    positions.push(index)
    index = text.indexOf(quote, index + quote.length)
  }
  return positions
}

function replaceTextOccurrence(text: string, quote: string, replacement: string, occurrence: number): string {
  const start = textOccurrences(text, quote)[occurrence - 1]
  if (start === undefined) return text
  return `${text.slice(0, start)}${replacement}${text.slice(start + quote.length)}`
}

function candidatePath(root: string, chapter: number, revisionId: string): string {
  return path.join(revisionDir(root, chapter), `${revisionId}.json`)
}

function mergePath(root: string, chapter: number, revisionId: string): string {
  return path.join(revisionDir(root, chapter), `${revisionId}.merge.json`)
}

function paragraphsOf(draft: string): DraftParagraph[] {
  const parts = draft.split(/\n{2,}/)
  const paragraphs: DraftParagraph[] = []
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    paragraphs.push({
      paragraphId: `p${String(paragraphs.length + 1).padStart(3, '0')}`,
      text,
    })
  }
  return paragraphs
}

function mapParagraphs(paragraphs: DraftParagraph[]): Map<string, string> {
  return new Map(paragraphs.map(paragraph => [paragraph.paragraphId, paragraph.text]))
}

function paragraphsForFinding(paragraphs: DraftParagraph[], finding: ReviewFinding): string[] {
  const quote = finding.quote ?? finding.evidence?.quote
  if (!quote) return []
  return paragraphs
    .filter(paragraph => paragraph.text.includes(quote))
    .map(paragraph => paragraph.paragraphId)
}
