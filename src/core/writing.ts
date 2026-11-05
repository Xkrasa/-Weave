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
import { loadContract, contractHash, requirePassingContractCheck } from './contract.ts'
import { collectMaterials } from './materials.ts'
import { assembleContext } from './context.ts'
import { streamChapter } from './model.ts'
import { loadModelConfig } from './project.ts'
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
  rebuildProjection,
} from './projections.ts'
import { conflictError, modelError, validationError, WeaveError } from './errors.ts'

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
  impact: ImpactReport | null
  draftEdited: boolean
}

export async function finalizeChapter(root: string, chapter: number): Promise<FinalizeResult> {
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  await assertNoPendingImpacts(root)
  await assertProjectionCurrent(root)

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

  const contentHash = hashText(draft)
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
    projection = await rebuildProjection(root)
  } catch (error) {
    projectionFailed = true
    projection = await markProjectionFailed(root, error instanceof Error ? error.message : String(error))
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
    impact,
    draftEdited,
  }
}

async function clearDraft(root: string, chapter: number): Promise<void> {
  await rm(draftPath(root, chapter), { force: true })
  await rm(draftMetaPath(root, chapter), { force: true })
}
