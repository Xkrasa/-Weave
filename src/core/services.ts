import path from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import type { ProjectionState } from './types.ts'
import { atomicWrite, ensureDir, listFiles, normalizeText, readTextIfExists } from './io.ts'
import { hashFileBytes, objectHash } from './hash.ts'
import { projectPaths, loadProject, loadModelConfig } from './project.ts'
import { loadDraftMeta } from './runs.ts'
import { textAtSpan } from './stages.ts'
import { assertFinalIntegrity, currentCommit, finalPath, listCommits, readCommit, readMainline } from './ledger.ts'
import { chapterFileStem, loadContract } from './contract.ts'
import { withheldForChapter } from './materials.ts'
import { listUnresolvedPending } from './pending.ts'
import { draftHash, loadStage } from './stages.ts'
import type { ContentCheckReport, CoverageAudit, ExtractionReport, ReviewReport } from './stage-types.ts'
import type { EffectReviewReport } from './effect-review.ts'
import { impactSummary, pendingImpactItems } from './impact.ts'
import {
  assertProjectionCurrent,
  readProjectionState,
  rebuildProjection,
  replayProjectionFrom,
} from './projections.ts'
import {
  assertLedgerProjectionCurrent,
  rebuildLedgerProjection,
  replayLedgerProjectionFrom,
  readLedgerProjectionState,
  readLedgerProjectionStates,
  LEDGER_PROJECTIONS,
  type LedgerProjectionName,
  type LedgerProjectionState,
} from './ledger-projection.ts'
import { conflictError } from './errors.ts'
import { rebuildSearchIndex, searchIndexHealth, type SearchIndexState } from './search.ts'
import { loadStoryMemory, memoryIsCurrent } from './memory.ts'
import { modelBudgetSummary, type ModelBudgetSummary } from './config.ts'
import {
  calibrationDeviation,
  calibrationWarning,
  loadTokenCalibration,
  type CalibrationDeviation,
} from './token-calibration.ts'

export interface ChapterStatus {
  chapter: number
  title: string
  revision: number
  commitId: string
  contentHash: string
  finalizedAt: string
}

export interface DraftStageSummary {
  chapter: number
  phase: 'polishing' | 'frozen-verification' | 'ready-to-finalize'
  currentStages: Array<'check' | 'effect-review' | 'extract' | 'audit' | 'review'>
  staleStages: Array<'check' | 'effect-review' | 'extract' | 'audit' | 'review'>
  nextCommand: string
  note: string
}

export interface ProjectStatus {
  root: string
  title: string
  language: string
  schemaVersion: number
  workflowVersion: number
  mainlineRevision: number
  chapters: ChapterStatus[]
  drafts: number[]
  draftStages?: DraftStageSummary[]
  projection: ProjectionState | null
  ledgerProjection: LedgerProjectionState | null
  ledgerProjections: LedgerProjectionState[]
  impacts: Array<{ chapter: number; pending: number; targets: number[] }>
  pendingImpacts: number
  searchIndex: Awaited<ReturnType<typeof searchIndexHealth>>
  memory: { current: boolean; throughChapter: number; mainlineRevision: number | null }
  /** 下一待写章仍被披露控制扣留的 canon 条目；无合同或无扣留时不出现。 */
  disclosure?: {
    chapter: number
    withheld: Array<{ sourceId: string; revealChapter: number; excerpt: string }>
  }
  /** 已有抽取 stage 里仍未裁决的账本冲突；带病续写前必须能看到。 */
  pendingConflicts?: Array<{
    chapter: number
    pendingId: string
    subject: string
    predicate: string
    object: string
    priorObject: string
  }>
}

export async function projectStatus(root: string): Promise<ProjectStatus> {
  const project = await loadProject(root)
  const head = await readMainline(root)
  const chapters: ChapterStatus[] = []
  for (const chapter of Object.keys(head.selectedCommitByChapter).map(Number).sort((a, b) => a - b)) {
    const commit = await currentCommit(root, chapter)
    if (!commit) continue
    let title = ''
    try {
      title = (await loadContract(root, chapter)).title
    } catch {
      title = ''
    }
    chapters.push({
      chapter,
      title,
      revision: commit.revision,
      commitId: commit.commitId,
      contentHash: commit.contentHash,
      finalizedAt: commit.createdAt,
    })
  }
  const draftNames = await listFiles(projectPaths(root).draftsDir)
  const drafts: number[] = []
  for (const name of draftNames) {
    if (!name.endsWith('.md')) continue
    const number = Number(name.replace(/\.md$/, ''))
    if (Number.isSafeInteger(number) && number > 0) drafts.push(number)
  }
  const impacts = await impactSummary(root)
  const nextChapter = (chapters[chapters.length - 1]?.chapter ?? 0) + 1
  let disclosure: ProjectStatus['disclosure']
  try {
    const nextContract = await loadContract(root, nextChapter)
    const withheld = await withheldForChapter(root, nextContract)
    if (withheld.length > 0) disclosure = { chapter: nextChapter, withheld }
  } catch {
    // 下一章没有合同时不展示披露控制；扣留与否由写作时的装配报告说了算
  }
  const pendingConflicts = (await listUnresolvedPending(
    root,
    [...chapters.map(item => item.chapter), ...drafts],
  )).map(item => ({
    chapter: item.chapter,
    pendingId: item.pendingId,
    subject: item.subject,
    predicate: item.predicate,
    object: item.object,
    priorObject: item.priorObject,
  }))
  return {
    root,
    title: project.title,
    language: project.language,
    schemaVersion: project.schemaVersion,
    workflowVersion: project.workflowVersion,
    mainlineRevision: head.mainlineRevision,
    chapters,
    drafts: drafts.sort((a, b) => a - b),
    projection: await readProjectionState(root),
    ledgerProjection: await readLedgerProjectionState(root),
    ledgerProjections: await readLedgerProjectionStates(root),
    impacts,
    pendingImpacts: impacts.reduce((sum, item) => sum + item.pending, 0),
    searchIndex: await searchIndexHealth(root),
    memory: await memoryStatus(root),
    ...(disclosure ? { disclosure } : {}),
    ...(pendingConflicts.length > 0 ? { pendingConflicts } : {}),
    ...(drafts.length > 0 ? { draftStages: await Promise.all(drafts.sort((a, b) => a - b).map(ch => summarizeDraftStage(root, ch, project.workflowVersion))) } : {}),
  }
}

export async function summarizeDraftStage(
  root: string,
  chapter: number,
  workflowVersion: number,
): Promise<DraftStageSummary> {
  const raw = await readTextIfExists(path.join(projectPaths(root).draftsDir, `${chapterFileStem(chapter)}.md`))
  const currentHash = raw ? draftHash(normalizeText(raw)) : ''
  const check = await loadStage<ContentCheckReport>(root, 'content-check', chapter).catch(() => null)
  const effect = await loadStage<EffectReviewReport>(root, 'effect-review', chapter).catch(() => null)
  const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter).catch(() => null)
  const audit = await loadStage<CoverageAudit>(root, 'audit', chapter).catch(() => null)
  const review = await loadStage<ReviewReport>(root, 'review', chapter).catch(() => null)

  const currentStages: DraftStageSummary['currentStages'] = []
  const staleStages: DraftStageSummary['staleStages'] = []
  const classify = (name: DraftStageSummary['currentStages'][number], report: { draftHash: string } | null) => {
    if (!report) return
    if (report.draftHash === currentHash) currentStages.push(name)
    else staleStages.push(name)
  }
  classify('check', check)
  classify('effect-review', effect)
  classify('extract', extraction)
  classify('audit', audit)
  classify('review', review)

  if (workflowVersion !== 2) {
    if (!check || check.draftHash !== currentHash || !check.passed) {
      return {
        chapter,
        phase: 'polishing',
        currentStages,
        staleStages,
        nextCommand: `weave check ${chapter}`,
        note: '先运行确定性内容检查，通过后可 effect-review 打磨或直接 finalize',
      }
    }
    return {
      chapter,
      phase: 'ready-to-finalize',
      currentStages,
      staleStages,
      nextCommand: `weave finalize ${chapter}`,
      note: '内容检查已通过；如需打磨可运行 weave effect-review ' + chapter,
    }
  }

  // Two-phase recommended flow for p05:
  // Phase 1 (polishing): check -> effect-review (optional revise loop)
  // Phase 2 (frozen verification): extract -> audit -> review -> finalize
  if (!check || check.draftHash !== currentHash || !check.passed) {
    return {
      chapter,
      phase: 'polishing',
      currentStages,
      staleStages,
      nextCommand: `weave check ${chapter}`,
      note: '打磨段：先过确定性内容检查',
    }
  }
  const inFrozenChain = Boolean(
    (extraction && extraction.draftHash === currentHash)
    || (audit && audit.draftHash === currentHash)
    || (review && review.draftHash === currentHash),
  )
  if (!inFrozenChain && (!effect || effect.draftHash !== currentHash)) {
    return {
      chapter,
      phase: 'polishing',
      currentStages,
      staleStages,
      nextCommand: `weave effect-review ${chapter}`,
      note: '打磨段：建议先做效果审查并完成修订，再进入 extract/audit/review 冻结验证链（减少重跑成本）',
    }
  }
  if (!extraction || extraction.draftHash !== currentHash || !extraction.passed) {
    return {
      chapter,
      phase: 'frozen-verification',
      currentStages,
      staleStages,
      nextCommand: `weave extract ${chapter}`,
      note: '冻结段：正文打磨完成后执行抽取',
    }
  }
  if (!audit || audit.draftHash !== currentHash || !audit.passed) {
    const unresolvedMissed = audit && audit.draftHash === currentHash ? audit.secondPass.missed.length : 0
    return {
      chapter,
      phase: 'frozen-verification',
      currentStages,
      staleStages,
      nextCommand: unresolvedMissed > 0
        ? `weave audit decide ${chapter} --missed <id> --decision rerun|dismiss --reason <理由>`
        : `weave audit ${chapter}`,
      note: unresolvedMissed > 0
        ? `冻结段：覆盖审计有 ${unresolvedMissed} 条第二遍疑似遗漏待裁决`
        : '冻结段：运行覆盖审计',
    }
  }
  if (!review || review.draftHash !== currentHash || !review.passed) {
    return {
      chapter,
      phase: 'frozen-verification',
      currentStages,
      staleStages,
      nextCommand: review && review.draftHash === currentHash && !review.passed
        ? `weave revise ${chapter} --findings <id>`
        : `weave review ${chapter}`,
      note: review && review.draftHash === currentHash && !review.passed
        ? `冻结段：有 ${review.blockingCount} 条 blocking 审稿意见待处理`
        : '冻结段：运行可信审稿',
    }
  }
  return {
    chapter,
    phase: 'ready-to-finalize',
    currentStages,
    staleStages,
    nextCommand: `weave finalize ${chapter}`,
    note: '所有可信门禁已通过，可定稿',
  }
}

export interface DoctorResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  checkedCommits: number
  budget?: ModelBudgetSummary
  /** Observed vs configured token ratio; absent until at least one run reports usage. */
  calibration?: CalibrationDeviation
}

async function memoryStatus(root: string): Promise<{
  current: boolean
  throughChapter: number
  mainlineRevision: number | null
}> {
  const head = await readMainline(root)
  const memory = await loadStoryMemory(root)
  return {
    current: memoryIsCurrent(memory, head.mainlineRevision),
    throughChapter: memory?.throughChapter ?? 0,
    mainlineRevision: memory?.mainlineRevision ?? null,
  }
}

function sanitize(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return (cleaned || '未命名').slice(0, 80)
}

export async function doctor(root: string): Promise<DoctorResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let checkedCommits = 0
  let budget: ModelBudgetSummary | undefined
  let calibration: CalibrationDeviation | undefined
  try {
    await loadProject(root)
    const modelConfig = await loadModelConfig(root)
    budget = modelBudgetSummary(modelConfig)
    const report = calibrationDeviation(modelConfig, await loadTokenCalibration(root))
    if (report) {
      calibration = report
      const warning = calibrationWarning(report)
      if (warning) warnings.push(warning)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const head = await readMainline(root)
  const projection = await readProjectionState(root)
  const selectedChapters = Object.keys(head.selectedCommitByChapter).map(Number)
  if (selectedChapters.length > 0 && !projection) {
    errors.push('存在已定稿章节但投影缺失；请执行 weave rebuild')
  }
  if (projection && projection.mainlineRevision !== head.mainlineRevision) {
    errors.push(`投影主线版本 ${projection.mainlineRevision} 与当前主线 ${head.mainlineRevision} 不一致`)
  }
  if (projection && projection.status !== 'current') {
    errors.push(`投影状态为 ${projection.status}`)
  }
  if (projection && projection.appliedThrough < Math.max(0, ...selectedChapters)) {
    errors.push(`投影只应用到第 ${projection.appliedThrough} 章，主线已到第 ${Math.max(...selectedChapters)} 章`)
  }

  const commits = await listCommits(root)
  const ledgerStates = await readLedgerProjectionStates(root)
  if (commits.some(commit => commit.schemaVersion === 3)) {
    for (const name of LEDGER_PROJECTIONS) {
      const state = ledgerStates.find(item => item.name === name)
      if (!state) {
        errors.push(`账本投影 ${name} 缺失；请执行 weave rebuild --projection ${name}`)
        continue
      }
      if (state.mainlineRevision !== head.mainlineRevision) {
        errors.push(`账本投影 ${name} 主线版本与当前主线不一致`)
      }
      if (state.status !== 'current') errors.push(`账本投影 ${name} 状态为 ${state.status}`)
      const maxChapter = Math.max(0, ...selectedChapters)
      if (state.appliedThrough < maxChapter) {
        errors.push(`账本投影 ${name} 未应用到最新章节`)
      }
    }
  }
  for (const commit of commits) {
    checkedCommits += 1
    const version = path.join(root, commit.contentPath)
    const text = await readFile(version).catch(() => null)
    if (!text) {
      errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的历史版本缺失`)
      continue
    }
    if (hashFileBytes(text) !== commit.contentHash) {
      errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的历史版本哈希不一致`)
    }
    if (commit.schemaVersion >= 2) {
      const versionText = text.toString('utf8')
      const evidence = commit.evidence ?? []
      if ((commit.evidenceCount ?? 0) !== evidence.length) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的 evidenceCount 与证据数量不一致`)
      }
      for (const span of evidence) {
        if (span.sourceContentHash !== commit.contentHash) {
          errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的证据来源哈希不一致`)
          continue
        }
        if (textAtSpan(versionText, span) !== span.quote) {
          errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的证据区间无法回指原文`)
        }
      }
    }
    if (commit.schemaVersion === 3) {
      const ledger = commit.ledger ?? { events: [], facts: [], beliefs: [] }
      if (commit.ledgerHash !== objectHash(ledger)) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的账本哈希不一致`)
      }
      if (commit.eventCount !== ledger.events.length) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的 eventCount 不一致`)
      }
      if (commit.factCount !== ledger.facts.length) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的 factCount 不一致`)
      }
      if (commit.beliefCount !== ledger.beliefs.length) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的 beliefCount 不一致`)
      }
      if ((commit.loopCount ?? 0) !== (ledger.loops?.length ?? 0)) {
        errors.push(`第 ${commit.chapter} 章 rev-${commit.revision} 的 loopCount 不一致`)
      }
    }
  }

  for (const chapter of Object.keys(head.selectedCommitByChapter).map(Number)) {
    const commit = await currentCommit(root, chapter)
    if (!commit) {
      errors.push(`主线引用了不存在的第 ${chapter} 章提交`)
      continue
    }
    const final = await readFile(finalPath(root, chapter)).catch(() => null)
    if (!final) {
      errors.push(`第 ${chapter} 章正式正文缺失`)
      continue
    }
    if (hashFileBytes(final) !== commit.contentHash) {
      errors.push(`第 ${chapter} 章正式正文与主线提交不一致（外部修改或未恢复）`)
    }
  }

  const indexHealth = await searchIndexHealth(root)
  if (selectedChapters.length > 0) {
    if (indexHealth.status === 'missing') {
      warnings.push('检索索引未建立；依赖检索的生成不会使用历史证据')
    } else if (indexHealth.status !== 'current') {
      errors.push(`检索索引状态为 ${indexHealth.status}${indexHealth.error ? `（${indexHealth.error}）` : ''}；请执行 weave index rebuild`)
    } else if (indexHealth.mainlineRevision !== head.mainlineRevision) {
      errors.push('检索索引落后于当前主线；请执行 weave index rebuild')
    }
  }

  const pending = await pendingImpactItems(root)
  for (const report of pending) {
    errors.push(`第 ${report.sourceChapter} 章仍有 ${report.items.length} 项未处理影响`)
  }

  const draftMetas = await listFiles(projectPaths(root).drafts)
  for (const name of draftMetas) {
    if (!name.endsWith('.json')) continue
    const chapter = Number(name.replace(/\.json$/, ''))
    const meta = Number.isSafeInteger(chapter) ? await loadDraftMeta(root, chapter) : null
    if (meta?.baseCommit) {
      const commit = await readCommit(root, meta.baseCommit)
      if (!commit) errors.push(`第 ${chapter} 章草稿引用了不存在的提交 ${meta.baseCommit}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedCommits,
    ...(budget ? { budget } : {}),
    ...(calibration ? { calibration } : {}),
  }
}

export interface RebuildResult {
  projection: ProjectionState | null
  ledgerProjection: LedgerProjectionState | null
  index: { chunks: number; terms: number } | null
  chapters: number
  replayBaseChapter: number | null
}

export async function rebuildBook(
  root: string,
  options: {
    force?: boolean
    projection?: 'all' | 'content' | 'ledger' | 'search' | LedgerProjectionName
    fromChapter?: number
  } = {},
): Promise<RebuildResult> {
  const { force = false, projection = 'all', fromChapter } = options
  if (!force) await assertFinalIntegrity(root)
  let contentProjection: ProjectionState | null = null
  let ledgerProjection: LedgerProjectionState | null = null
  if (projection === 'all' || projection === 'content') {
    const state = await readProjectionState(root)
    contentProjection = fromChapter && fromChapter > 1
      ? await replayProjectionFrom(root, fromChapter, { materialize: true })
      : !force && state?.invalidFrom && state.status !== 'current'
        ? await replayProjectionFrom(root, state.invalidFrom, { materialize: true })
        : await rebuildProjection(root, { materialize: true })
  }
  let index: { chunks: number; terms: number } | null = null
  if (projection === 'all' || projection === 'search') {
    index = await rebuildSearchIndex(root)
  }
  if (projection !== 'content' && projection !== 'search') {
    const ledgerName: LedgerProjectionName | 'all' =
      projection === 'all' || projection === 'ledger' ? 'all' : projection
    const state = await readLedgerProjectionState(root)
    if (ledgerName !== 'all') {
      ledgerProjection = await rebuildLedgerProjection(root, {
        fromChapter,
        projection: ledgerName,
      })
    } else {
      ledgerProjection = fromChapter
        ? await rebuildLedgerProjection(root, { fromChapter, projection: 'all' })
        : !force && state?.invalidFrom && state.status !== 'current'
          ? await replayLedgerProjectionFrom(root, state.invalidFrom)
          : await rebuildLedgerProjection(root, { projection: 'all' })
    }
  }
  return {
    projection: contentProjection,
    ledgerProjection,
    index,
    chapters: contentProjection?.appliedThrough ?? ledgerProjection?.appliedThrough ?? 0,
    replayBaseChapter: contentProjection?.replayBaseChapter ?? ledgerProjection?.replayBaseChapter ?? null,
  }
}

export type ExportFormat = 'merged' | 'split' | 'txt'
export type ExportPlatform = 'generic' | 'qidian' | 'fanqie' | 'custom'
export type ExportCountMode = 'cjk' | 'all'

export interface ExportResult {
  format: ExportFormat
  platform: ExportPlatform
  characters: number
  files: string[]
}

export async function exportBook(
  root: string,
  format: ExportFormat,
  platform: ExportPlatform = 'generic',
  countMode: ExportCountMode = 'all',
): Promise<ExportResult> {
  const project = await loadProject(root)
  await assertFinalIntegrity(root)
  await assertProjectionCurrent(root)
  await assertLedgerProjectionCurrent(root)
  const head = await readMainline(root)
  const chapters = Object.keys(head.selectedCommitByChapter).map(Number).sort((a, b) => a - b)
  if (chapters.length === 0) throw conflictError('还没有已定稿章节可以导出')
  const exportsDir = projectPaths(root).exports
  await ensureDir(exportsDir)
  const allText = (await Promise.all(chapters.map(chapter => readTextIfExists(finalPath(root, chapter)))))
    .filter((text): text is string => Boolean(text))
    .join('\n')
  const characters = countPlatformCharacters(allText, platform, countMode)

  if (format === 'split') {
    const dir = path.join(exportsDir, 'split')
    await rm(dir, { recursive: true, force: true })
    await ensureDir(dir)
    const files: string[] = []
    for (const chapter of chapters) {
      const content = (await readTextIfExists(finalPath(root, chapter))) ?? ''
      const contract = await loadContract(root, chapter).catch(() => null)
      const title = contract?.title ?? ''
      const name = `${String(chapter).padStart(3, '0')}-${sanitize(title || `第${chapter}章`)}.md`
      const target = path.join(dir, name)
      await atomicWrite(target, `${content.trimEnd()}\n`)
      files.push(target)
    }
    return { format, platform, characters, files }
  }

  const lines: string[] = []
  if (format === 'merged') lines.push(`# ${project.title}`, '')
  for (const chapter of chapters) {
    const content = (await readTextIfExists(finalPath(root, chapter))) ?? ''
    const contract = await loadContract(root, chapter).catch(() => null)
    const title = contract?.title ?? ''
    lines.push(format === 'merged' ? `## 第${chapter}章 ${title}` : `第${chapter}章 ${title}`)
    lines.push('', content.trimEnd(), '')
  }
  const target = path.join(exportsDir, format === 'merged' ? 'book-merged.md' : 'book.txt')
  await atomicWrite(target, `${lines.join('\n').trimEnd()}\n`)
  return { format, platform, characters, files: [target] }
}

function countPlatformCharacters(
  text: string,
  platform: ExportPlatform,
  countMode: ExportCountMode,
): number {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (platform === 'qidian') return (normalized.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (platform === 'fanqie') return (normalized.match(/[\u4e00-\u9fff0-9]/g) ?? []).length
  if (platform === 'custom') {
    return countMode === 'cjk'
      ? (normalized.match(/[\u4e00-\u9fff]/g) ?? []).length
      : [...normalized.replace(/\s/g, '')].length
  }
  return [...normalized.replace(/\s/g, '')].length
}


