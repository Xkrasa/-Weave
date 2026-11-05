import path from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import type {
  CommitRecord,
  DraftMeta,
  GenerationEvent,
  ImpactReport,
  ProjectionState,
  RunRecord,
} from './types.ts'
import { assertNoPendingImpacts, createImpactReport } from './impact.ts'
import { loadCharacters, loadContract, contractHash, requirePassingContractCheck } from './contract.ts'
import { collectMaterials } from './materials.ts'
import { assembleContext } from './context.ts'
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
import { loadStage, requireStage } from './stages.ts'
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
  estimatedTokens: number
  included: string[]
  omitted: Array<{ sourceId: string; reason: string }>
}

export async function writeChapter(
  root: string,
  chapter: number,
  options: { signal: AbortSignal; onDelta?: (text: string) => void; onEvent?: (event: GenerationEvent) => void },
): Promise<WriteResult> {
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  await assertFinalIntegrity(root)
  await assertProjectionCurrent(root)
  await assertLedgerProjectionCurrent(root)
  const registry = await loadCharacters(root)
  const knowledge = await checkKnowledge(root, chapter, contract, registry)
  if (!knowledge.ok) throw validationError('章节合同要求的信息边界未满足', knowledge.errors)
  const modelConfig = await loadModelConfig(root)
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

  const materials = await collectMaterials(root, contract)
  const assembled = assembleContext(contract, materials, modelConfig)
  if (assembled.decision.decision !== 'ready') {
    throw validationError(assembled.decision.message, assembled.decision)
  }
  const context = assembled.context
  if (!context) throw validationError('上下文装配失败')

  const run: RunRecord = {
    schemaVersion: 1,
    runId: newRunId(),
    chapter,
    status: 'running',
    model: modelConfig.model,
    baseUrl: modelConfig.baseUrl,
    startedAt: new Date().toISOString(),
    contextHash: context.contextHash,
    promptHash: hashText(`${context.system}\n${context.user}`),
    materialSourceIds: context.included.map(item => item.sourceId),
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
    const nextMeta: DraftMeta = {
      chapter,
      contentHash: hashText(text),
      runId: run.runId,
      baseCommit: current?.commitId ?? null,
      createdAt: new Date().toISOString(),
    }
    await saveDraftMeta(root, nextMeta)
    const finished = finishRun(run, 'completed', { usage: result.usage })
    await saveRun(root, finished)
    emit({ type: 'completed', draft })
    return {
      chapter,
      run: finished,
      draftPath: draft,
      contextHash: context.contextHash,
      estimatedTokens: context.estimatedTokens,
      included: context.included.map(item => item.sourceId),
      omitted: context.omitted,
    }
  } catch (error) {
    const cancelled = options.signal.aborted
    let savedPartial: string | undefined
    if (text.trim()) savedPartial = await savePartial(root, run.runId, text)
    const finished = finishRun(run, cancelled ? 'cancelled' : 'failed', {
      error: error instanceof Error ? error.message : String(error),
      partialPath: savedPartial ? path.relative(root, savedPartial).split(path.sep).join('/') : undefined,
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
    impact,
    draftEdited,
  }
}

async function clearDraft(root: string, chapter: number): Promise<void> {
  await rm(draftPath(root, chapter), { force: true })
  await rm(draftMetaPath(root, chapter), { force: true })
}
