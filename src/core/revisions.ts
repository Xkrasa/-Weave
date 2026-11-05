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
import type { ModelConfig } from './types.ts'
import { completeText } from './model.ts'
import { draftHash, loadStage, parseJsonObject, readDraft, resolveEvidence, saveStage } from './stages.ts'
import { atomicWrite, atomicWriteJson, ensureDir, readJsonIfExists } from './io.ts'
import { objectHash, hashText } from './hash.ts'
import { projectPaths } from './project.ts'
import { draftPath } from './ledger.ts'
import { chapterFileStem } from './contract.ts'
import { conflictError, validationError } from './errors.ts'
import { applyWaivers } from './waivers.ts'

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

export async function reviseChapter(
  root: string,
  chapter: number,
  findingIds: string[],
  config: ModelConfig,
  signal: AbortSignal,
): Promise<{ candidate: RevisionCandidate; plan: RevisionPlanView }> {
  const draft = await readDraft(root, chapter)
  const loaded = await loadStage<ReviewReport>(root, 'review', chapter)
  if (!loaded) throw validationError(`第 ${chapter} 章没有审查报告`)
  const report = await applyWaivers(root, chapter, loaded)
  if (report.draftHash !== draftHash(draft)) {
    throw conflictError('草稿在审查后已修改；请重新审查后再修稿')
  }
  if (findingIds.length === 0) throw validationError('请指定要处理的 finding，例如 --findings f1,f2')
  const selected = report.findings.filter(finding => findingIds.includes(finding.findingId))
  if (selected.length !== findingIds.length) throw validationError('部分 finding 不存在')
  if (selected.some(finding => finding.status === 'waived' || finding.status === 'verified')) {
    throw validationError('waived 或 verified finding 不进入修稿计划')
  }
  if (selected.some(finding => finding.status === 'applied')) {
    throw validationError('finding 已经有修订候选；请先合并或重新审查')
  }

  for (const finding of selected) finding.status = 'planned'
  await saveStage(root, 'review', chapter, report)

  const paragraphs = paragraphsOf(draft)
  const instructions: RevisionInstruction[] = selected.map(finding => ({
    findingId: finding.findingId,
    paragraphIds: paragraphsForFinding(paragraphs, finding),
    goal: finding.description,
  }))
  if (instructions.some(item => item.paragraphIds.length === 0)) {
    throw validationError('部分 finding 缺少可定位段落，无法定向修稿')
  }
  const targetIds = new Set(instructions.flatMap(item => item.paragraphIds))
  const targetParagraphs = paragraphs.filter(paragraph => targetIds.has(paragraph.paragraphId))
  const prompt = [
    `第 ${chapter} 章修稿。`,
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
  const model = config.reviewModel ?? config.model
  const result = await completeText({
    config: { ...config, model },
    system: REVISION_SYSTEM,
    user: prompt,
    signal,
  })
  const raw = parseJsonObject(result.text)
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
  await saveStage(root, 'review', chapter, report)
  return {
    candidate: revision,
    plan: {
      chapter,
      draftHash: revision.baseDraftHash,
      createdAt: revision.createdAt,
      findings: selected,
      instructions,
    },
  }
}

export async function loadRevision(
  root: string,
  chapter: number,
  revisionId: string,
): Promise<RevisionCandidate> {
  const candidate = await readJsonIfExists<RevisionCandidate>(candidatePath(root, chapter, revisionId))
  if (!candidate) throw validationError(`未找到修订候选：${revisionId}`)
  return candidate
}

export async function mergeRevision(
  root: string,
  chapter: number,
  revisionId: string,
  choices: Record<string, 'base' | 'revision' | 'manual'> = {},
): Promise<MergeReport> {
  const candidate = await loadRevision(root, chapter, revisionId)
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
  return report
}

export async function recheckChapter(
  root: string,
  chapter: number,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<ReviewReport> {
  const report = await loadStage<ReviewReport>(root, 'review', chapter)
  if (!report) throw validationError(`第 ${chapter} 章没有审查报告`)
  const applied = report.findings.filter(finding => finding.status === 'applied')
  if (applied.length === 0) throw validationError('没有 applied finding，无法复检')
  const draft = await readDraft(root, chapter)
  const currentHash = draftHash(draft)
  const check = await loadStage<ContentCheckReport>(root, 'content-check', chapter)
  const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter)
  const audit = await loadStage<CoverageAudit>(root, 'audit', chapter)
  if (!check || check.draftHash !== currentHash) {
    throw conflictError('合并后需要先重新运行 weave check')
  }
  if (!extraction || extraction.draftHash !== currentHash) {
    throw conflictError('合并后需要先重新运行 weave extract')
  }
  if (!audit || audit.draftHash !== currentHash) {
    throw conflictError('合并后需要先重新运行 weave audit')
  }
  const revisionIds = [...new Set(applied.map(finding => finding.revisionId).filter((id): id is string => Boolean(id)))]
  let merged = false
  for (const revisionId of revisionIds) {
    const report = await readJsonIfExists<MergeReport>(mergePath(root, chapter, revisionId))
    if (report?.status === 'merged' && report.mergedDraftHash === currentHash) {
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
  const model = config.reviewModel ?? config.model
  const result = await completeText({
    config: { ...config, model },
    system: RECHECK_SYSTEM,
    user: prompt,
    signal,
  })
  const raw = parseJsonObject(result.text)
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
    const result = resolvedMap.get(finding.findingId)
    let resolved = result?.resolved === true
    if (resolved && result?.quote) {
      try {
        finding.evidence = resolveEvidence(draft, chapter, result.quote)
        finding.quote = result.quote
      } catch {
        resolved = false
      }
    } else if (resolved) {
      resolved = false
    }
    finding.status = resolved ? 'verified' : 'open'
    finding.recheckNote = result?.note
    finding.recheckedAt = new Date().toISOString()
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
  report.extractionHash = objectHash(extraction)
  report.auditHash = objectHash(audit)
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
  if (!report) throw validationError(`第 ${chapter} 章没有审查报告`)
  const finding = report.findings.find(item => item.findingId === findingId)
  if (!finding) throw validationError(`未找到 finding：${findingId}`)
  if (finding.severity === 'blocking') throw validationError('blocking finding 不能 ignore；请修复或显式豁免')
  if (finding.status === 'applied' || finding.status === 'verified') {
    throw validationError('已进入修稿或已复检的 finding 不能直接 ignore')
  }
  if (!reason.trim()) throw validationError('ignore 必须提供理由')
  finding.status = 'ignored'
  finding.ignoreReason = reason.trim()
  report.blockingCount = report.findings.filter(
    item => item.severity === 'blocking' && item.status !== 'verified' && item.status !== 'waived',
  ).length
  report.passed = report.blockingCount === 0
  await saveStage(root, 'review', chapter, report)
  return finding
}

function revisionDir(root: string, chapter: number): string {
  return path.join(projectPaths(root).revisions, chapterFileStem(chapter))
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
    if (!part.trim()) continue
    paragraphs.push({
      paragraphId: `p${String(paragraphs.length + 1).padStart(3, '0')}`,
      text: part,
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
