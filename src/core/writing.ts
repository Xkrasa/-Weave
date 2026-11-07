import path from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import type {
  CommitRecord,
  DraftMeta,
  GenerationEvent,
  ImpactReport,
  ProjectionState,
  RunRecord,
  RunRecovery,
  RunUsage,
  SegmentRunRecord,
} from './types.ts'
import { assertNoPendingImpacts, createImpactReport } from './impact.ts'
import { loadCharacters, loadContract, contractHash, requirePassingContractCheck } from './contract.ts'
import { assembleChapterContext, prepareChapterContextInputs } from './materials.ts'
import { formatBeats, requireApprovedBeats, type DraftingStrategy } from './beats.ts'
import {
  markSegmentStatus,
  requireApprovedSegmentPlan,
  resetSegmentRun,
  saveSegmentOutput,
  segmentTextPath,
  type ChapterSegmentPlan,
} from './segments.ts'
import type { SegmentPromptContext } from './context.ts'
import { assembleContext } from './context.ts'
import type { AuthorSampleSelection } from './style.ts'
import { streamChapter } from './model.ts'
import { loadModelConfig, loadProject } from './project.ts'
import { atomicWrite, normalizeText, readTextIfExists } from './io.ts'
import { hashText, objectHash } from './hash.ts'
import {
  appendMainline,
  assertFinalIntegrity,
  buildCommit,
  commitsForChapter,
  currentCommit,
  draftPath,
  ensureUniqueCommit,
  finalPath,
  readMainline,
  versionPath,
  writeCommit,
} from './ledger.ts'
import {
  draftMetaPath,
  finishRun,
  loadDraftMeta,
  loadRun,
  newRunId,
  saveDraft,
  saveDraftMeta,
  savePartial,
  saveRun,
} from './runs.ts'
import {
  assertProjectionCurrent,
  invalidateProjection,
  markProjectionFailed,
  replayProjectionFrom,
} from './projections.ts'
import {
  assertLedgerProjectionCurrent,
  markLedgerProjectionFailed,
  replayLedgerProjectionFrom,
} from './ledger-projection.ts'
import { conflictError, modelError, reviewBlockedError, validationError, WeaveError } from './errors.ts'
import { checkSegment } from './segment-checks.ts'
import { loadStage, requireStage, saveStage } from './stages.ts'
import { runContentCheck } from './content-check.ts'
import { applyFinalizedChapter, markSearchIndexFailed } from './search.ts'
import { assertOutlineApproved } from './outline.ts'
import { ensureStoryMemory } from './memory.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { recordTokenObservation } from './token-calibration.ts'
import { generateKeyCandidates, type KeyCandidateGroup } from './tiered.ts'
import type {
  ContentCheckReport,
  CoverageAudit,
  ExtractionReport,
  ReviewReport,
} from './stage-types.ts'
import {
  applyLoopChanges,
  assertValidLedger,
  buildLedgerDelta,
  checkKnowledge,
  collectLedger,
  collectLoopState,
} from './story-ledger.ts'

export interface WriteResult {
  chapter: number
  run: RunRecord
  draftPath: string
  contextHash: string
  layers: { stable: string; volume: string; chapter: string; full: string }
  renderer: string
  draftingStrategy: DraftingStrategy
  beatContentHash?: string
  sampleSelection: AuthorSampleSelection
  estimatedTokens: number
  keyCandidates: KeyCandidateGroup[]
  included: string[]
  omitted: Array<{ sourceId: string; reason: string }>
  withheld: Array<{ sourceId: string; reason: string }>
  degraded: Array<{ sourceId: string; reason: string }>
  conflictWarnings: string[]
  segments?: SegmentRunRecord[]
}

export async function writeChapter(
  root: string,
  chapter: number,
  options: {
    signal: AbortSignal
    onDelta?: (text: string) => void
    onEvent?: (event: GenerationEvent) => void
    /** Failed/cancelled run whose partial should be recorded as the reason for this fresh run. */
    resumeFromRunId?: string
    /** Force the key-chapter path regardless of the contract. */
    key?: boolean
    /** Optional experiment; defaults to the existing single-pass prose path. */
    draftingStrategy?: DraftingStrategy
    /** Independent author-sample ablation; defaults to scene-aware selection. */
    authorSamples?: 'scene' | 'legacy' | 'off'
    /** Explicitly allow generated, unapproved beat fixtures for controlled benchmarks only. */
    benchmark?: boolean
  },
): Promise<WriteResult> {
  await assertOutlineApproved(root, chapter)
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  await assertFinalIntegrity(root)
  await assertProjectionCurrent(root)
  await assertLedgerProjectionCurrent(root)
  const registry = await loadCharacters(root)
  const knowledge = await checkKnowledge(root, chapter, contract, registry)
  if (!knowledge.ok) throw validationError('章节合同要求的信息边界未满足', knowledge.errors)
  const modelConfig = resolveTaskConfig(await loadModelConfig(root), 'writing')
  const meta = await loadDraftMeta(root, chapter)
  const current = await currentCommit(root, chapter)

  if (current && !meta?.baseCommit) {
    throw conflictError(`第 ${chapter} 章已经定稿；请先执行 weave amend ${chapter}`)
  }
  if (current && meta?.baseCommit !== current.commitId) {
    throw conflictError(`草稿基于旧版本 ${meta?.baseCommit ?? '未知'}，当前主线为 ${current.commitId}；请重新 amend`)
  }
  if (!current && meta?.baseCommit) {
    throw conflictError('草稿引用了不存在的正式版本；请重新创建草稿')
  }

  const draftingStrategy = options.draftingStrategy ?? 'prose-first'
  if (draftingStrategy === 'segmented') {
    const plan = await requireApprovedSegmentPlan(root, chapter)
    const approvedBeats = await requireApprovedBeats(root, chapter, { allowBenchmarkDraft: options.benchmark === true })
    const resume = options.resumeFromRunId
      ? await resolveSegmentResume(root, chapter, plan, approvedBeats.contentHash, options.resumeFromRunId)
      : undefined
    return writeSegmentedChapter(root, chapter, {
      contract,
      modelConfig,
      current,
      options,
      plan,
      beatContentHash: approvedBeats.contentHash,
      ...(resume ? { resume } : {}),
    })
  }
  const beatCandidate = draftingStrategy === 'beat-first'
    ? await requireApprovedBeats(root, chapter, { allowBenchmarkDraft: options.benchmark === true })
    : null
  const { decision, context, sampleSelection, methodSelection, conflictWarnings } = await assembleChapterContext(root, contract, {
    authorSamples: options.authorSamples,
    ...(beatCandidate ? { beatText: formatBeats(beatCandidate) } : {}),
    modelConfig,
  })
  if (decision.decision !== 'ready') {
    throw validationError(decision.message, decision)
  }
  if (!context) throw validationError('上下文装配失败')

  const recovery = await resolveRecovery(root, chapter, options.resumeFromRunId)
  const run: RunRecord = {
    schemaVersion: 1,
    runId: newRunId(),
    chapter,
    status: 'running',
    task: 'writing',
    model: modelConfig.model,
    baseUrl: modelConfig.baseUrl,
    startedAt: new Date().toISOString(),
    contextHash: context.contextHash,
    promptHash: hashText(`${context.system}\n${context.user}`),
    estimatedPromptChars: context.promptChars,
    materialSourceIds: context.included.map(item => item.sourceId),
    draftingStrategy,
    ...(beatCandidate ? { beatContentHash: beatCandidate.contentHash } : {}),
    sampleSelection,
    methodSelection,
    ...(recovery ? { recovery } : {}),
  }
  await saveRun(root, run)

  let seq = 0
  const emit = (event: Omit<GenerationEvent, 'seq' | 'runId' | 'chapter'>): void => {
    options.onEvent?.({ ...event, seq: seq++, runId: run.runId, chapter })
  }
  let text = ''
  const onDelta = (delta: string): void => {
    text += delta
    options.onDelta?.(delta)
    emit({ type: 'delta', text: delta })
  }
  emit({ type: 'started' })

  try {
    const result = await streamChapter({
      config: modelConfig,
      system: context.system,
      user: context.user,
      signal: options.signal,
      onDelta,
    })
    text = normalizeText(text)
    if (!text.trim()) throw modelError('模型返回了空正文')
    emit({ type: 'usage', usage: result.usage })
    const draft = await saveDraft(root, chapter, text)
    const keyCandidates = options.key === true || contract.importance === 'key'
      ? await generateKeyCandidates(root, chapter, contract, modelConfig, options.signal)
      : []
    const nextMeta: DraftMeta = {
      chapter,
      contentHash: hashText(text),
      runId: run.runId,
      baseCommit: current?.commitId ?? null,
      createdAt: new Date().toISOString(),
    }
    await saveDraftMeta(root, nextMeta)
    const finished = finishRun(run, 'completed', { usage: result.usage, attempts: result.attempts })
    await saveRun(root, finished)
    await recordTokenObservation(root, context.promptChars, result.usage?.promptTokens, context.charsPerToken)
    emit({ type: 'completed', draft })
    return {
      chapter,
      run: finished,
      draftPath: draft,
      contextHash: context.contextHash,
      keyCandidates,
      layers: context.layers,
      renderer: context.renderer,
      draftingStrategy,
      ...(beatCandidate ? { beatContentHash: beatCandidate.contentHash } : {}),
      sampleSelection,
      estimatedTokens: context.estimatedTokens,
      included: context.included.map(item => item.sourceId),
      omitted: context.omitted,
      withheld: context.withheld,
      degraded: context.degraded,
      conflictWarnings,
    }
  } catch (error) {
    const cancelled = options.signal.aborted
    let savedPartial: string | undefined
    if (text.trim()) savedPartial = await savePartial(root, run.runId, text)
    const finished = finishRun(run, cancelled ? 'cancelled' : 'failed', {
      error: error instanceof Error ? error.message : String(error),
      partialPath: savedPartial ? path.relative(root, savedPartial).split(path.sep).join('/') : undefined,
      attempts: (error as { attempts?: RunRecord['attempts'] }).attempts,
    })
    await saveRun(root, finished)
    emit(
      cancelled
        ? { type: 'cancelled', error: '生成已取消' }
        : { type: 'failed', error: error instanceof Error ? error.message : String(error) },
    )
    if (error instanceof WeaveError) throw error
    throw modelError(`生成失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function amendChapter(root: string, chapter: number, force = false): Promise<DraftMeta> {
  const commit = await currentCommit(root, chapter)
  if (!commit) throw conflictError(`第 ${chapter} 章尚未定稿，不能 amend`)
  const existing = await loadDraftMeta(root, chapter)
  if (existing && !force) {
    throw conflictError(`第 ${chapter} 章已有草稿；如需覆盖请加 --force`)
  }
  const bytes = await readFile(path.join(root, commit.contentPath))
  const text = normalizeText(Buffer.from(bytes).toString('utf8'))
  await atomicWrite(draftPath(root, chapter), text)
  const meta: DraftMeta = {
    chapter,
    contentHash: hashText(text),
    runId: 'manual',
    baseCommit: commit.commitId,
    createdAt: new Date().toISOString(),
  }
  await saveDraftMeta(root, meta)
  return meta
}

export interface FinalizeResult {
  commit: CommitRecord
  mainlineRevision: number
  projection: ProjectionState | null
  projectionFailed: boolean
  ledgerProjectionFailed: boolean
  searchIndexFailed: boolean
  memoryFailed: boolean
  impact: ImpactReport | null
  draftEdited: boolean
}

export async function finalizeChapter(root: string, chapter: number): Promise<FinalizeResult> {
  const project = await loadProject(root)
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  await assertNoPendingImpacts(root)
  await assertProjectionCurrent(root)
  await assertLedgerProjectionCurrent(root)

  const draftFile = draftPath(root, chapter)
  const rawDraft = await readTextIfExists(draftFile)
  if (rawDraft === null) throw conflictError(`第 ${chapter} 章没有草稿`)
  const draft = normalizeText(rawDraft)
  if (!draft.trim()) throw validationError(`第 ${chapter} 章草稿为空`)

  const current = await currentCommit(root, chapter)
  const meta = await loadDraftMeta(root, chapter)
  if (current && !meta?.baseCommit) {
    throw conflictError(`第 ${chapter} 章已有正式版本；请先执行 weave amend ${chapter}`)
  }
  if (current && meta?.baseCommit !== current.commitId) {
    throw conflictError(`草稿不是基于当前主线版本 ${current.commitId}；请重新 amend`)
  }
  if (!current && meta?.baseCommit) {
    throw conflictError('草稿引用的正式版本已不在主线中；请重新创建草稿')
  }
  const draftEdited = meta ? hashText(draft) !== meta.contentHash : false
  const currentDraftHash = hashText(draft)

  const commitSchemaVersion: 1 | 2 | 3 = project.workflowVersion === 2 ? 3 : 2
  let extractionHash: string | undefined
  let reviewHash: string | undefined
  let ledger: CommitRecord['ledger']
  let commitEvidence: CommitRecord['evidence'] = []
  if (project.workflowVersion !== 2) {
    // p0 skips the model stages, but the deterministic content check is free and
    // still catches empty, truncated or placeholder prose before it becomes canon.
    const check = await runContentCheck(root, chapter, contract, draft)
    await saveStage(root, 'content-check', chapter, check)
    if (!check.passed) {
      throw validationError(
        `第 ${chapter} 章内容检查未通过；请修复后再定稿`,
        check.findings.filter(finding => finding.severity === 'blocking'),
      )
    }
  }
  if (project.workflowVersion === 2) {
    await requireStage<ContentCheckReport>(root, 'content-check', chapter, currentDraftHash)
    const extraction = await requireStage<ExtractionReport>(root, 'extraction', chapter, currentDraftHash)
    const audit = await requireStage<CoverageAudit>(root, 'audit', chapter, currentDraftHash)
    extractionHash = objectHash(extraction)
    if (audit.extractionHash !== extractionHash) {
      throw conflictError('覆盖审计绑定的抽取结果已变化；请重新运行 weave audit')
    }
    const review = await loadStage<ReviewReport>(root, 'review', chapter)
    if (!review) throw validationError(`第 ${chapter} 章缺少 review 报告；请先运行 weave review`)
    if (review.draftHash !== currentDraftHash) {
      throw conflictError('审稿报告绑定的草稿已变化；请重新运行 weave review')
    }
    if (review.extractionHash !== extractionHash || review.auditHash !== objectHash(audit)) {
      throw conflictError('审稿报告绑定的抽取或审计已变化；请重新运行 weave review')
    }
    if (!review.passed) {
      throw reviewBlockedError('存在未解决的 blocking 审稿意见，暂不能定稿', {
        chapter,
        blockingCount: review.blockingCount,
        findings: review.findings.filter(finding => finding.severity === 'blocking'),
      })
    }
    reviewHash = objectHash(review)
    const delta = buildLedgerDelta(chapter, extraction, contract)
    const priorChapters = await collectLedger(root, chapter - 1)
    const currentLedger = current ? await collectLedger(root, chapter) : priorChapters
    const registry = await loadCharacters(root)
    assertValidLedger(chapter, delta, registry, {
      priorFacts: new Map(currentLedger.facts.map(fact => [fact.factId, fact])),
      priorEvents: new Map(currentLedger.events.map(event => [event.eventId, event])),
      usedFactIds: new Set(priorChapters.facts.map(fact => fact.factId)),
      usedEventIds: new Set(priorChapters.events.map(event => event.eventId)),
      usedBeliefIds: new Set(priorChapters.beliefs.map(belief => belief.beliefId)),
      contract,
    })
    const knowledge = await checkKnowledge(root, chapter, contract, registry, delta.beliefs)
    if (!knowledge.ok) throw validationError('定稿时信息边界校验失败', knowledge.errors)
    const previousLoops = await collectLoopState(root, chapter - 1)
    const loopCheck = applyLoopChanges(previousLoops.loops, delta.loops ?? [], chapter)
    if (loopCheck.errors.length > 0) throw validationError('定稿时伏笔账本校验失败', loopCheck.errors)
    ledger = delta
    commitEvidence = [
      ...delta.events.flatMap(event => event.evidence),
      ...delta.facts.flatMap(fact => fact.evidence),
      ...delta.beliefs.flatMap(belief => belief.evidence),
    ]
  }

  const contentHash = currentDraftHash
  const history = await commitsForChapter(root, chapter)
  const revision = history.reduce((max, item) => Math.max(max, item.revision), 0) + 1
  const version = versionPath(root, chapter, revision)
  await atomicWrite(version, draft)

  const run = meta?.runId && meta.runId !== 'manual' ? await loadRun(root, meta.runId) : null
  const contextHash =
    run?.contextHash ?? objectHash({ manual: true, contract: contractHash(contract), contentHash })
  const contentPath = path.relative(root, version).split(path.sep).join('/')
  const commit = buildCommit({
    chapter,
    revision,
    supersedes: current?.commitId ?? null,
    contentHash,
    contractHash: contractHash(contract),
    contextHash,
    contentPath,
    schemaVersion: commitSchemaVersion,
    extractionHash,
    reviewHash,
    evidence: commitEvidence,
    ledger: commitSchemaVersion === 3 ? ledger : undefined,
  })
  await ensureUniqueCommit(root, commit)

  // Formal prose and immutable history are both durable before the commit file.
  await atomicWrite(finalPath(root, chapter), draft)
  await writeCommit(root, commit)

  const previousHead = await readMainline(root)
  const selected = { ...previousHead.selectedCommitByChapter, [String(chapter)]: commit.commitId }
  const head = await appendMainline(root, selected)
  await clearDraft(root, chapter)

  let projection: ProjectionState | null = null
  let projectionFailed = false
  try {
    if (revision > 1) await invalidateProjection(root, chapter)
    projection = await replayProjectionFrom(root, chapter)
  } catch (error) {
    projectionFailed = true
    projection = await markProjectionFailed(root, error instanceof Error ? error.message : String(error))
  }
  let searchIndexFailed = false
  try {
    await applyFinalizedChapter(root, chapter)
  } catch (error) {
    searchIndexFailed = true
    await markSearchIndexFailed(root, error instanceof Error ? error.message : String(error)).catch(() => {})
  }
  let memoryFailed = false
  try {
    await ensureStoryMemory(root)
  } catch {
    memoryFailed = true
  }
  let ledgerProjectionFailed = false
  if (commit.schemaVersion === 3) {
    try {
      await replayLedgerProjectionFrom(root, chapter, revision > 1)
    } catch {
      ledgerProjectionFailed = true
      await markLedgerProjectionFailed(root)
    }
  }

  let impact: ImpactReport | null = null
  if (revision > 1) {
    try {
      impact = await createImpactReport(root, chapter, commit)
    } catch (error) {
      throw new WeaveError(
        'IMPACT_FAILED',
        `第 ${chapter} 章已提交，但影响面分析失败：${error instanceof Error ? error.message : String(error)}`,
        4,
        { commitId: commit.commitId },
      )
    }
  }

  return {
    commit,
    mainlineRevision: head.mainlineRevision,
    projection,
    projectionFailed,
    ledgerProjectionFailed,
    searchIndexFailed,
    memoryFailed,
    impact,
    draftEdited,
  }
}

async function writeSegmentedChapter(
  root: string,
  chapter: number,
  input: {
    contract: Awaited<ReturnType<typeof loadContract>>
    modelConfig: Awaited<ReturnType<typeof loadModelConfig>>
    current: CommitRecord | null
    options: {
      signal: AbortSignal
      onDelta?: (text: string) => void
      onEvent?: (event: GenerationEvent) => void
      key?: boolean
      authorSamples?: 'scene' | 'legacy' | 'off'
      benchmark?: boolean
    }
    plan: ChapterSegmentPlan
    beatContentHash: string
    resume?: SegmentResume
  },
): Promise<WriteResult> {
  const prepared = await prepareChapterContextInputs(root, input.contract, {
    authorSamples: input.options.authorSamples,
    modelConfig: input.modelConfig,
  })
  const completed = input.resume?.completed ?? []
  const completedIds = new Set(completed.map(segment => segment.segmentId))
  const parts = [...(input.resume?.parts ?? [])]
  const summaries: SegmentRunRecord[] = [...completed]
  const usages: RunUsage[] = completed.flatMap(segment => segment.usage ? [segment.usage] : [])
  let priorTail = parts.length > 0 ? [...parts.at(-1)!].slice(-400).join('') : ''
  const recovery: RunRecovery | undefined = input.resume
    ? {
        fromRunId: input.resume.priorRunId,
        partialPath: input.resume.partialPath ?? '',
        strategy: 'resume-segments',
        completedSegments: [...completedIds],
        ...(input.resume.nextSegmentId ? { nextSegmentId: input.resume.nextSegmentId } : {}),
      }
    : undefined
  const run: RunRecord = {
    schemaVersion: 1,
    runId: newRunId(),
    chapter,
    status: 'running',
    task: 'writing',
    model: input.modelConfig.model,
    baseUrl: input.modelConfig.baseUrl,
    startedAt: new Date().toISOString(),
    contextHash: objectHash({ planHash: input.plan.planHash }),
    promptHash: objectHash({ planHash: input.plan.planHash }),
    materialSourceIds: [],
    draftingStrategy: 'segmented',
    beatContentHash: input.beatContentHash,
    planHash: input.plan.planHash,
    contractHash: input.plan.contractHash,
    sampleSelection: prepared.sampleSelection,
    methodSelection: prepared.methodSelection,
    ...(recovery ? { recovery } : {}),
    segments: input.plan.segments.map(segment => completedIds.has(segment.segmentId)
      ? completed.find(item => item.segmentId === segment.segmentId)!
      : { segmentId: segment.segmentId, status: 'planned' as const }),
  }
  await saveRun(root, run)
  await resetSegmentRun(root, chapter, [...completedIds])
  if (parts.length > 0) {
    const partialPath = await savePartial(root, run.runId, mergeSegmentTexts(parts))
    run.partialPath = path.relative(root, partialPath).split(path.sep).join('/')
  }

  let seq = 0
  const emit = (event: Omit<GenerationEvent, 'seq' | 'runId' | 'chapter'>): void => {
    input.options.onEvent?.({ ...event, seq: seq++, runId: run.runId, chapter })
  }
  emit({ type: 'started' })
  let failedRecord: SegmentRunRecord | undefined

  const contextHashes: string[] = []
  const included = new Set<string>()
  const omitted = new Map<string, string>()
  const degraded = new Map<string, string>()
  let estimatedTokens = 0
  let promptChars = 0
  let layers = { stable: '', volume: '', chapter: '', full: '' }
  let renderer = 'json'

  try {
    for (const segment of input.plan.segments) {
      if (completedIds.has(segment.segmentId)) continue
      if (input.options.signal.aborted) throw modelError('生成已取消')
      emit({ type: 'segment-started', segmentId: segment.segmentId })
      await markSegmentStatus(root, chapter, segment.segmentId, 'generating')

      const segmentConfig = segmentModelConfig(input.modelConfig, segment.targetWords)
      let acceptedText = ''
      let acceptedUsage: RunUsage | undefined
      let acceptedAttempt = 0
      let lastRetryReasons: string[] = []
      let acceptedContext: import('./context.ts').AssembledContext | null = null
      for (let attempt = 1; attempt <= MAX_SEGMENT_ATTEMPTS; attempt += 1) {
        const prompt = segmentPrompt(segment, input.plan.segments.length, priorTail, lastRetryReasons)
        const assembled = assembleContext(input.contract, prepared.materials, segmentConfig, {
          segment: prompt,
          withheld: prepared.withheld,
          preOmitted: prepared.ideaOmitted,
          charsPerToken: prepared.charsPerToken,
        })
        if (assembled.decision.decision !== 'ready' || !assembled.context) {
          throw validationError(
            assembled.decision.decision === 'ready' ? '分段上下文装配失败' : assembled.decision.message,
            assembled.decision,
          )
        }
        const context = assembled.context
        if (prepared.ideaDegraded.length > 0) {
          context.degraded = [...context.degraded, ...prepared.ideaDegraded]
        }
        contextHashes.push(context.contextHash)
        estimatedTokens += context.estimatedTokens
        for (const item of context.included) included.add(item.sourceId)
        for (const item of context.omitted) omitted.set(item.sourceId, item.reason)
        for (const item of context.degraded) degraded.set(item.sourceId, item.reason)
        layers = context.layers
        renderer = context.renderer

        let text = ''
        const onDelta = (delta: string): void => {
          text += delta
          input.options.onDelta?.(delta)
          emit({ type: 'delta', text: delta, segmentId: segment.segmentId })
        }
        const result = await streamChapter({
          config: segmentConfig,
          system: context.system,
          user: context.user,
          signal: input.options.signal,
          onDelta,
        })
        const attemptText = normalizeText(text).trim()
        if (!attemptText) throw modelError(`第 ${segment.segmentId} 段返回了空正文`)
        if (result.usage) usages.push(result.usage)
        emit({ type: 'usage', usage: result.usage, segmentId: segment.segmentId })
        const checked = checkSegment({
          text: attemptText,
          targetWords: segment.targetWords,
          previousTail: priorTail,
          mustNotHappen: segment.mustNotHappen,
          pov: input.contract.pov,
          goal: segment.goal,
          exitState: segment.exitState,
          characters: input.contract.characters,
        })
        if (checked.passed) {
          acceptedText = checked.text
          acceptedUsage = result.usage
          acceptedAttempt = attempt
          acceptedContext = context
          break
        }
        emit({
          type: 'segment-retry',
          segmentId: segment.segmentId,
          attempt,
          reason: checked.retryReasons.join('；'),
        })
        lastRetryReasons = checked.retryReasons
        if (attempt === MAX_SEGMENT_ATTEMPTS) {
          await markSegmentStatus(root, chapter, segment.segmentId, 'failed')
          failedRecord = { segmentId: segment.segmentId, status: 'failed', attempts: attempt }
          throw validationError(
            `第 ${segment.segmentId} 段连续 ${MAX_SEGMENT_ATTEMPTS} 次未通过校验：${checked.retryReasons.join('；')}`,
          )
        }
      }
      if (!acceptedContext) throw modelError(`第 ${segment.segmentId} 段没有可用正文`)

      promptChars += acceptedContext.promptChars
      await recordTokenObservation(
        root,
        acceptedContext.promptChars,
        acceptedUsage?.promptTokens,
        acceptedContext.charsPerToken,
      )

      const saved = await saveSegmentOutput(root, chapter, segment.segmentId, acceptedText, run.runId)
      const summary: SegmentRunRecord = {
        segmentId: segment.segmentId,
        status: 'draft',
        contentHash: saved.contentHash,
        attempts: acceptedAttempt,
        ...(acceptedUsage ? { usage: acceptedUsage } : {}),
      }
      summaries.push(summary)
      parts.push(acceptedText)
      priorTail = [...acceptedText].slice(-400).join('')

      const partialPath = await savePartial(root, run.runId, mergeSegmentTexts(parts))
      run.partialPath = path.relative(root, partialPath).split(path.sep).join('/')
      run.contextHash = objectHash({ planHash: input.plan.planHash, contexts: contextHashes })
      run.promptHash = objectHash({ contexts: contextHashes })
      run.estimatedPromptChars = promptChars
      run.materialSourceIds = [...included]
      run.usage = sumUsage(usages)
      run.segments = summaries
      await saveRun(root, run)
      emit({
        type: 'segment-completed',
        segmentId: segment.segmentId,
        contentHash: saved.contentHash,
        usage: acceptedUsage,
      })
    }

    const merged = mergeSegmentTexts(parts)
    if (!merged.trim()) throw modelError('分段合并后正文为空')
    const draft = await saveDraft(root, chapter, merged)
    const keyCandidates = input.options.key === true || input.contract.importance === 'key'
      ? await generateKeyCandidates(root, chapter, input.contract, input.modelConfig, input.options.signal)
      : []
    const totalUsage = sumUsage(usages)
    const nextMeta: DraftMeta = {
      chapter,
      contentHash: hashText(merged),
      runId: run.runId,
      baseCommit: input.current?.commitId ?? null,
      createdAt: new Date().toISOString(),
    }
    await saveDraftMeta(root, nextMeta)
    const finished = {
      ...finishRun(run, 'completed', { usage: totalUsage }),
      segments: summaries,
    }
    await saveRun(root, finished)
    emit({ type: 'completed', draft })
    return {
      chapter,
      run: finished,
      draftPath: draft,
      contextHash: run.contextHash ?? '',
      keyCandidates,
      layers,
      renderer,
      draftingStrategy: 'segmented',
      beatContentHash: input.beatContentHash,
      sampleSelection: prepared.sampleSelection,
      estimatedTokens,
      included: [...included],
      omitted: [...omitted].map(([sourceId, reason]) => ({ sourceId, reason })),
      withheld: prepared.withheld,
      degraded: [...degraded].map(([sourceId, reason]) => ({ sourceId, reason })),
      conflictWarnings: prepared.conflictWarnings,
      segments: summaries,
    }
  } catch (error) {
    const cancelled = input.options.signal.aborted
    let savedPartial: string | undefined
    if (parts.length > 0) savedPartial = await savePartial(root, run.runId, mergeSegmentTexts(parts))
    const finished = {
      ...finishRun(run, cancelled ? 'cancelled' : 'failed', {
        error: error instanceof Error ? error.message : String(error),
        partialPath: savedPartial ? path.relative(root, savedPartial).split(path.sep).join('/') : run.partialPath,
        attempts: (error as { attempts?: RunRecord['attempts'] }).attempts,
      }),
      segments: failedRecord ? [...summaries, failedRecord] : summaries,
    }
    await saveRun(root, finished)
    emit(
      cancelled
        ? { type: 'cancelled', error: '生成已取消' }
        : { type: 'failed', error: error instanceof Error ? error.message : String(error) },
    )
    if (error instanceof WeaveError) throw error
    throw modelError(`生成失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

interface SegmentResume {
  priorRunId: string
  partialPath?: string
  completed: SegmentRunRecord[]
  parts: string[]
  nextSegmentId?: string
}

async function resolveSegmentResume(
  root: string,
  chapter: number,
  plan: ChapterSegmentPlan,
  beatContentHash: string,
  runId: string,
): Promise<SegmentResume> {
  const prior = await loadRun(root, runId)
  if (!prior) throw validationError(`未找到运行记录：${runId}`)
  if (prior.chapter !== chapter) {
    throw validationError(`运行 ${runId} 属于第 ${prior.chapter} 章，不能用于第 ${chapter} 章`)
  }
  if (prior.draftingStrategy !== 'segmented') {
    throw validationError(`运行 ${runId} 不是分段生成，不能按段恢复`)
  }
  if (prior.status !== 'failed' && prior.status !== 'cancelled') {
    throw validationError(`运行 ${runId} 状态为 ${prior.status}，只有失败或取消的运行可以恢复`)
  }
  if (prior.planHash !== plan.planHash) {
    throw validationError('分段计划在运行失败后已变化，不能恢复；请重新生成并批准分段计划')
  }
  if (prior.contractHash !== plan.contractHash) {
    throw validationError('合同在运行失败后已变化，不能恢复；请重新生成并批准分段计划')
  }
  if (prior.beatContentHash !== beatContentHash) {
    throw validationError('节拍在运行失败后已变化，不能恢复；请重新生成并批准分段计划')
  }

  const completed: SegmentRunRecord[] = []
  const parts: string[] = []
  for (const segment of plan.segments) {
    const summary = prior.segments?.find(item => item.segmentId === segment.segmentId)
    if (!summary || !summary.contentHash || !['draft', 'checked', 'approved'].includes(summary.status)) break
    const text = await readTextIfExists(segmentTextPath(root, chapter, segment.segmentId))
    if (!text?.trim()) throw validationError(`已完成段 ${segment.segmentId} 的正文缺失，不能恢复`)
    const actual = objectHash({ segmentId: segment.segmentId, text: text.trim() })
    if (actual !== summary.contentHash) {
      throw validationError(`已完成段 ${segment.segmentId} 的正文在运行后被修改，不能恢复`)
    }
    completed.push(summary)
    parts.push(text.trim())
  }
  const completedIds = new Set(completed.map(item => item.segmentId))
  const next = plan.segments.find(segment => !completedIds.has(segment.segmentId))
  return {
    priorRunId: prior.runId,
    ...(prior.partialPath ? { partialPath: prior.partialPath } : {}),
    completed,
    parts,
    ...(next ? { nextSegmentId: next.segmentId } : {}),
  }
}

function segmentModelConfig(
  config: Awaited<ReturnType<typeof loadModelConfig>>,
  targetWords: number,
): Awaited<ReturnType<typeof loadModelConfig>> {
  const estimated = Math.ceil((targetWords / config.charsPerToken) * 1.3 + 200)
  return { ...config, maxOutputTokens: Math.min(config.maxOutputTokens, 4_096, Math.max(256, estimated)) }
}

function segmentPrompt(
  segment: ChapterSegmentPlan['segments'][number],
  total: number,
  priorTail: string,
  retryReasons: string[] = [],
): SegmentPromptContext {
  return {
    index: segment.index,
    total,
    goal: segment.goal,
    entryState: segment.entryState,
    exitState: segment.exitState,
    priorTail,
    targetWords: segment.targetWords,
    mustNotHappen: segment.mustNotHappen,
    ...(retryReasons.length > 0 ? { retryReasons } : {}),
  }
}

const MAX_SEGMENT_ATTEMPTS = 3

/** Removes a 40+ character suffix/prefix overlap at a segment boundary. */
export function mergeSegmentTexts(parts: string[]): string {
  const normalized = parts.map(part => normalizeText(part).trim()).filter(part => part.length > 0)
  let merged = ''
  for (const part of normalized) {
    if (!merged) {
      merged = part
      continue
    }
    let overlap = Math.min(merged.length, part.length, 600)
    while (overlap >= MIN_OVERLAP && merged.slice(-overlap) !== part.slice(0, overlap)) overlap -= 1
    const cut = overlap >= MIN_OVERLAP ? overlap : 0
    merged = `${merged}\n\n${part.slice(cut)}`
  }
  return merged
}

const MIN_OVERLAP = 40

function sumUsage(usages: RunUsage[]): RunUsage {
  const total: RunUsage = {}
  for (const usage of usages) {
    if (usage.promptTokens !== undefined) total.promptTokens = (total.promptTokens ?? 0) + usage.promptTokens
    if (usage.completionTokens !== undefined) total.completionTokens = (total.completionTokens ?? 0) + usage.completionTokens
    if (usage.totalTokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + usage.totalTokens
  }
  return total
}

async function resolveRecovery(
  root: string,
  chapter: number,
  resumeFromRunId: string | undefined,
): Promise<RunRecovery | null> {
  if (!resumeFromRunId) return null
  const prior = await loadRun(root, resumeFromRunId)
  if (!prior) throw validationError(`未找到运行记录：${resumeFromRunId}`)
  if (prior.chapter !== chapter) {
    throw validationError(`运行 ${resumeFromRunId} 属于第 ${prior.chapter} 章，不能用于第 ${chapter} 章`)
  }
  if (prior.status !== 'failed' && prior.status !== 'cancelled') {
    throw validationError(`运行 ${resumeFromRunId} 状态为 ${prior.status}，只有失败或取消的运行可以恢复`)
  }
  if (!prior.partialPath) throw validationError(`运行 ${resumeFromRunId} 没有可恢复的部分稿`)
  const partial = await readTextIfExists(path.join(root, prior.partialPath))
  if (!partial?.trim()) throw validationError(`运行 ${resumeFromRunId} 的部分稿为空或已丢失`)
  return { fromRunId: prior.runId, partialPath: prior.partialPath, strategy: 'regenerate' }
}

async function clearDraft(root: string, chapter: number): Promise<void> {
  await rm(draftPath(root, chapter), { force: true })
  await rm(draftMetaPath(root, chapter), { force: true })
}
