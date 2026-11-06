import path from 'node:path'
import type { ChapterContract, ModelConfig } from './types.ts'
import type { ContractCheckError } from './contract.ts'
import type { EvidenceSpan } from './stage-types.ts'
import { atomicWriteJson, readJsonIfExists, readTextIfExists } from './io.ts'
import { objectHash } from './hash.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'
import { loadContract } from './contract.ts'
import { currentCommit, finalPath, readMainline } from './ledger.ts'
import { resolveEvidence } from './stages.ts'
import { collectLoopState } from './story-ledger.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'

export type ReaderPromiseLifecycle = 'planned' | 'active' | 'abandoned'
export type ReaderPromiseBookStatus = 'missing' | 'draft' | 'approved' | 'modified'
export type ReaderPromiseAction = 'advance' | 'payoff'

export interface ReaderPromise {
  promiseId: string
  description: string
  status: ReaderPromiseLifecycle
  volume?: number
  targetFromChapter?: number
  targetToChapter?: number
  relatedLoopIds: string[]
  abandonReason?: string
}

export interface ReaderPromiseBook {
  promises: ReaderPromise[]
}

interface ReaderPromiseEnvelope {
  schemaVersion: 1
  status: 'draft' | 'approved'
  provenance: 'author' | 'generated'
  contentHash: string
  approvedAt?: string
  approvedBy?: string
  content: ReaderPromiseBook
}

export interface ReaderPromiseObservation {
  observationId: string
  promiseId: string
  action: ReaderPromiseAction
  chapter: number
  commitId: string
  evidence: EvidenceSpan
  provenance: 'author' | 'generated'
  confirmedAt: string
  confirmedBy: 'author'
}

export interface ReaderPromiseCandidate {
  candidateId: string
  promiseId: string
  action: ReaderPromiseAction
  chapter: number
  commitId: string
  evidence: EvidenceSpan
  status: 'draft'
  provenance: 'generated'
  createdAt: string
}

export interface ReaderPromiseState {
  promise: ReaderPromise
  effectiveStatus: ReaderPromiseLifecycle | 'paid_off'
  advanceCount: number
  lastAdvancedChapter?: number
  payoff?: ReaderPromiseObservation
  stalePayoff: boolean
}

export interface ReaderPromiseFinding {
  ruleId: 'reader-promise-overdue' | 'reader-promise-stale-payoff'
  ruleVersion: 1
  severity: 'warning'
  description: string
}

interface ObservationStore { schemaVersion: 1, observations: ReaderPromiseObservation[] }
interface CandidateStore { schemaVersion: 1, candidates: ReaderPromiseCandidate[] }

function bookPath(root: string): string { return path.join(projectPaths(root).plans, 'reader-promises.json') }
function observationsPath(root: string): string { return path.join(projectPaths(root).ledger, 'reader-promise-observations.json') }
function candidatesPath(root: string): string { return path.join(projectPaths(root).ledger, 'reader-promise-candidates.json') }

export async function readReaderPromiseBook(root: string): Promise<{
  status: ReaderPromiseBookStatus
  contentHash: string | null
  content?: ReaderPromiseBook
  provenance?: 'author' | 'generated'
}> {
  const envelope = await readJsonIfExists<ReaderPromiseEnvelope>(bookPath(root))
  if (!envelope) return { status: 'missing', contentHash: null }
  const actual = objectHash(envelope.content)
  return {
    status: envelope.status !== 'approved' ? 'draft' : envelope.contentHash === actual ? 'approved' : 'modified',
    contentHash: actual,
    content: envelope.content,
    provenance: envelope.provenance,
  }
}

export async function saveReaderPromiseDraft(
  root: string,
  content: ReaderPromiseBook,
  provenance: 'author' | 'generated' = 'author',
): Promise<ReaderPromiseBookStatus> {
  validateBookShape(content)
  const envelope: ReaderPromiseEnvelope = {
    schemaVersion: 1,
    status: 'draft',
    provenance,
    contentHash: objectHash(content),
    content,
  }
  await atomicWriteJson(bookPath(root), envelope)
  return (await readReaderPromiseBook(root)).status
}

export async function approveReaderPromiseBook(root: string): Promise<ReaderPromiseBookStatus> {
  const envelope = await readJsonIfExists<ReaderPromiseEnvelope>(bookPath(root))
  if (!envelope) throw conflictError('读者承诺文件不存在；请先执行 promise set')
  validateBookShape(envelope.content)
  const loops = await collectLoopState(root)
  const knownLoops = new Set((loops?.loops ?? []).map(loop => loop.loopId))
  for (const promise of envelope.content.promises) {
    for (const loopId of promise.relatedLoopIds) {
      if (!knownLoops.has(loopId)) throw validationError(`ReaderPromise ${promise.promiseId} 引用了未知 OpenLoop：${loopId}`)
    }
  }
  const approved: ReaderPromiseEnvelope = {
    ...envelope,
    status: 'approved',
    contentHash: objectHash(envelope.content),
    approvedAt: new Date().toISOString(),
    approvedBy: 'author',
  }
  await atomicWriteJson(bookPath(root), approved)
  return (await readReaderPromiseBook(root)).status
}

export async function abandonReaderPromise(root: string, promiseId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw validationError('废弃 ReaderPromise 必须填写原因')
  const envelope = await readJsonIfExists<ReaderPromiseEnvelope>(bookPath(root))
  if (!envelope) throw conflictError('读者承诺文件不存在')
  const promise = envelope.content.promises.find(item => item.promiseId === promiseId)
  if (!promise) throw validationError(`未知 ReaderPromise：${promiseId}`)
  const content: ReaderPromiseBook = {
    promises: envelope.content.promises.map(item => item.promiseId === promiseId
      ? { ...item, status: 'abandoned', abandonReason: reason.trim() }
      : item),
  }
  await saveReaderPromiseDraft(root, content, envelope.provenance)
  await approveReaderPromiseBook(root)
}

export async function listReaderPromises(root: string): Promise<{
  bookStatus: ReaderPromiseBookStatus
  promises: ReaderPromiseState[]
}> {
  const book = await readReaderPromiseBook(root)
  return { bookStatus: book.status, promises: await collectReaderPromiseStates(root, Number.MAX_SAFE_INTEGER) }
}

export async function collectReaderPromiseStates(root: string, throughChapter: number): Promise<ReaderPromiseState[]> {
  const book = await readReaderPromiseBook(root)
  if (book.status !== 'approved' || !book.content) return []
  const [head, store] = await Promise.all([readMainline(root), loadObservations(root)])
  const contracts = await Promise.all(
    Object.entries(head.selectedCommitByChapter)
      .map(([chapter]) => Number(chapter))
      .filter(chapter => chapter <= throughChapter)
      .sort((a, b) => a - b)
      .map(chapter => loadContract(root, chapter).catch(() => null)),
  )
  return book.content.promises.map(promise => {
    const observations = store.observations.filter(item => item.promiseId === promise.promiseId && item.chapter <= throughChapter)
    const valid = observations.filter(item => head.selectedCommitByChapter[String(item.chapter)] === item.commitId)
    const payoff = valid.find(item => item.action === 'payoff')
    const stalePayoff = promise.status !== 'abandoned' && !payoff && observations.some(item =>
      item.action === 'payoff' && head.selectedCommitByChapter[String(item.chapter)] !== item.commitId)
    const advanceChapters = new Set<number>()
    for (const item of valid.filter(item => item.action === 'advance')) advanceChapters.add(item.chapter)
    for (const contract of contracts) {
      if (contract?.readerIntent?.promiseIds?.includes(promise.promiseId)) advanceChapters.add(contract.chapter)
    }
    const lastAdvancedChapter = advanceChapters.size > 0 ? Math.max(...advanceChapters) : undefined
    return {
      promise,
      effectiveStatus: promise.status === 'abandoned' ? 'abandoned' : payoff ? 'paid_off' : promise.status,
      advanceCount: advanceChapters.size,
      ...(lastAdvancedChapter === undefined ? {} : { lastAdvancedChapter }),
      ...(payoff ? { payoff } : {}),
      stalePayoff,
    }
  })
}

export async function readerPromiseFindings(root: string, chapter: number): Promise<ReaderPromiseFinding[]> {
  const states = await collectReaderPromiseStates(root, chapter)
  const findings: ReaderPromiseFinding[] = []
  for (const state of states) {
    if (state.promise.status === 'abandoned') continue
    if (state.stalePayoff) {
      findings.push({
        ruleId: 'reader-promise-stale-payoff', ruleVersion: 1, severity: 'warning',
        description: `承诺「${state.promise.description}」的原兑现证据已不属于当前主线，需要重新确认`,
      })
    }
    if (state.effectiveStatus !== 'paid_off'
      && state.promise.targetToChapter !== undefined
      && state.promise.targetToChapter < chapter) {
      findings.push({
        ruleId: 'reader-promise-overdue', ruleVersion: 1, severity: 'warning',
        description: `承诺「${state.promise.description}」原计划在第 ${state.promise.targetToChapter} 章前兑现，当前仍为 ${state.effectiveStatus}`,
      })
    }
  }
  return findings
}

export async function recordReaderPayoff(
  root: string,
  input: { promiseId: string; chapter: number; quote: string; occurrence?: number },
): Promise<ReaderPromiseObservation> {
  return recordObservation(root, {
    promiseId: input.promiseId,
    action: 'payoff',
    chapter: input.chapter,
    quote: input.quote,
    occurrence: input.occurrence,
    provenance: 'author',
  })
}

export async function extractReaderPromiseCandidates(
  root: string,
  chapter: number,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<ReaderPromiseCandidate[]> {
  const book = await readReaderPromiseBook(root)
  if (book.status !== 'approved' || !book.content) throw conflictError('没有已批准的 ReaderPromise；请先批准承诺')
  const commit = await currentCommit(root, chapter)
  if (!commit) throw conflictError(`第 ${chapter} 章尚未定稿，不能提取兑现候选`)
  const prose = await readTextIfExists(finalPath(root, chapter))
  if (!prose) throw validationError(`第 ${chapter} 章定稿正文不存在`)
  const taskConfig = resolveTaskConfig(config, 'extraction')
  const result = await completeJsonObject({
    config: taskConfig,
    system: [
      '你只从定稿正文中提取读者承诺的推进或兑现候选，不修改作者规划。',
      '只输出 JSON 对象。candidates 每项包含 promiseId、action(advance|payoff)、quote、occurrence。',
      'promiseId 只能使用输入提供的 ID；quote 必须是定稿正文逐字引文，没有证据就不要输出该项。',
    ].join('\n'),
    user: [
      `第 ${chapter} 章定稿正文：`,
      prose,
      '',
      '可关联的 ReaderPromise：',
      JSON.stringify(book.content.promises, null, 2),
    ].join('\n'),
    signal,
  })
  await appendUsage(root, { task: 'extraction', model: taskConfig.model, usage: result.usage })
  const rawCandidates = Array.isArray(result.raw.candidates) ? result.raw.candidates : []
  const store = await loadCandidates(root)
  const saved: ReaderPromiseCandidate[] = []
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const promiseId = typeof item.promiseId === 'string' ? item.promiseId : ''
    const action = item.action
    const quote = typeof item.quote === 'string' ? item.quote : ''
    if (!book.content.promises.some(promise => promise.promiseId === promiseId)) continue
    if (action !== 'advance' && action !== 'payoff') continue
    const evidence = resolveEvidence(prose, chapter, quote, typeof item.occurrence === 'number' ? item.occurrence : undefined)
    const candidateId = `rpc-${objectHash({ promiseId, action, chapter, quote, occurrence: evidence.occurrence }).slice(7, 23)}`
    const candidate: ReaderPromiseCandidate = {
      candidateId,
      promiseId,
      action,
      chapter,
      commitId: commit.commitId,
      evidence,
      status: 'draft',
      provenance: 'generated',
      createdAt: new Date().toISOString(),
    }
    saved.push(candidate)
  }
  const ids = new Set(saved.map(item => item.candidateId))
  await atomicWriteJson(candidatesPath(root), {
    schemaVersion: 1,
    candidates: [...store.candidates.filter(item => !ids.has(item.candidateId)), ...saved],
  } satisfies CandidateStore)
  return saved
}

export async function confirmReaderPromiseCandidate(root: string, candidateId: string): Promise<ReaderPromiseObservation> {
  const store = await loadCandidates(root)
  const candidate = store.candidates.find(item => item.candidateId === candidateId)
  if (!candidate) throw validationError(`未知 ReaderPromise 候选：${candidateId}`)
  const current = await currentCommit(root, candidate.chapter)
  if (!current || current.commitId !== candidate.commitId) {
    throw conflictError('候选对应的定稿已变化，请重新提取后再确认')
  }
  const observation = await recordObservation(root, {
    promiseId: candidate.promiseId,
    action: candidate.action,
    chapter: candidate.chapter,
    quote: candidate.evidence.quote,
    occurrence: candidate.evidence.occurrence,
    provenance: 'generated',
  })
  await atomicWriteJson(candidatesPath(root), {
    schemaVersion: 1,
    candidates: store.candidates.filter(item => item.candidateId !== candidateId),
  } satisfies CandidateStore)
  return observation
}

export async function validateReaderPromiseReferences(
  root: string,
  contract: ChapterContract,
): Promise<ContractCheckError[]> {
  const intent = contract.readerIntent
  const ids = intent?.promiseIds ?? []
  const payoffIds = intent?.payoffPromiseIds ?? []
  const errors: ContractCheckError[] = []
  if (new Set(ids).size !== ids.length) errors.push({ code: 'DUPLICATE_READER_PROMISE', field: 'readerIntent.promiseIds', message: 'ReaderPromise 引用不能重复' })
  for (const id of payoffIds.filter(id => !ids.includes(id))) {
    errors.push({ code: 'PAYOFF_PROMISE_NOT_LINKED', field: 'readerIntent.payoffPromiseIds', message: `兑现承诺 ${id} 必须先包含在 promiseIds 中` })
  }
  if (ids.length === 0 && payoffIds.length === 0) return errors
  const book = await readReaderPromiseBook(root)
  if (book.status === 'modified') {
    errors.push({ code: 'READER_PROMISE_APPROVAL_STALE', field: 'readerIntent.promiseIds', message: 'ReaderPromise 在批准后已修改，需要重新批准' })
    return errors
  }
  if (book.status !== 'approved' || !book.content) {
    if (book.status === 'draft') {
      errors.push({ code: 'READER_PROMISE_NOT_APPROVED', field: 'readerIntent.promiseIds', message: '引用的 ReaderPromise 尚未批准' })
    } else {
      for (const id of ids) errors.push({ code: 'UNKNOWN_READER_PROMISE', field: 'readerIntent.promiseIds', message: `未知 ReaderPromise：${id}` })
    }
    return errors
  }
  for (const id of ids) {
    const promise = book.content.promises.find(item => item.promiseId === id)
    if (!promise) {
      errors.push({ code: 'UNKNOWN_READER_PROMISE', field: 'readerIntent.promiseIds', message: `未知 ReaderPromise：${id}` })
      continue
    }
    if (promise.status === 'abandoned') {
      errors.push({ code: 'ABANDONED_READER_PROMISE', field: 'readerIntent.promiseIds', message: `ReaderPromise ${id} 已废弃，不能继续关联` })
    }
    if (promise.volume !== undefined && contract.volume !== undefined && promise.volume !== contract.volume) {
      errors.push({ code: 'READER_PROMISE_VOLUME_MISMATCH', field: 'readerIntent.promiseIds', message: `ReaderPromise ${id} 属于第 ${promise.volume} 卷，与合同卷号 ${contract.volume} 不一致` })
    }
  }
  return errors
}

async function recordObservation(
  root: string,
  input: {
    promiseId: string
    action: ReaderPromiseAction
    chapter: number
    quote: string
    occurrence?: number
    provenance: 'author' | 'generated'
  },
): Promise<ReaderPromiseObservation> {
  const book = await readReaderPromiseBook(root)
  if (book.status !== 'approved' || !book.content) throw conflictError('ReaderPromise 尚未批准')
  const promise = book.content.promises.find(item => item.promiseId === input.promiseId)
  if (!promise) throw validationError(`未知 ReaderPromise：${input.promiseId}`)
  if (promise.status === 'abandoned') throw conflictError(`ReaderPromise ${input.promiseId} 已废弃`)
  const commit = await currentCommit(root, input.chapter)
  if (!commit) throw conflictError(`第 ${input.chapter} 章尚未定稿，不能确认兑现`)
  const prose = await readTextIfExists(finalPath(root, input.chapter))
  if (!prose) throw validationError(`第 ${input.chapter} 章定稿正文不存在`)
  const evidence = resolveEvidence(prose, input.chapter, input.quote, input.occurrence)
  const observationId = `rpo-${objectHash({ promiseId: input.promiseId, action: input.action, chapter: input.chapter, commitId: commit.commitId }).slice(7, 23)}`
  const store = await loadObservations(root)
  if (store.observations.some(item => item.observationId === observationId)) {
    throw conflictError(`该承诺在第 ${input.chapter} 章已有 ${input.action} 记录`)
  }
  const observation: ReaderPromiseObservation = {
    observationId,
    promiseId: input.promiseId,
    action: input.action,
    chapter: input.chapter,
    commitId: commit.commitId,
    evidence,
    provenance: input.provenance,
    confirmedAt: new Date().toISOString(),
    confirmedBy: 'author',
  }
  await atomicWriteJson(observationsPath(root), { schemaVersion: 1, observations: [...store.observations, observation] } satisfies ObservationStore)
  return observation
}

async function loadObservations(root: string): Promise<ObservationStore> {
  return (await readJsonIfExists<ObservationStore>(observationsPath(root))) ?? { schemaVersion: 1, observations: [] }
}

async function loadCandidates(root: string): Promise<CandidateStore> {
  return (await readJsonIfExists<CandidateStore>(candidatesPath(root))) ?? { schemaVersion: 1, candidates: [] }
}

function validateBookShape(content: ReaderPromiseBook): void {
  if (!content || !Array.isArray(content.promises)) throw validationError('ReaderPromise 文件需要 promises 数组')
  const ids = new Set<string>()
  for (const promise of content.promises) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(promise.promiseId)) throw validationError(`ReaderPromise id 格式非法：${promise.promiseId}`)
    if (ids.has(promise.promiseId)) throw validationError(`ReaderPromise id 重复：${promise.promiseId}`)
    ids.add(promise.promiseId)
    if (!promise.description?.trim()) throw validationError(`ReaderPromise ${promise.promiseId} 缺少 description`)
    if (!['planned', 'active', 'abandoned'].includes(promise.status)) throw validationError(`ReaderPromise ${promise.promiseId} 生命周期非法`)
    if (!Array.isArray(promise.relatedLoopIds) || promise.relatedLoopIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw validationError(`ReaderPromise ${promise.promiseId}.relatedLoopIds 必须是字符串数组`)
    }
    for (const [field, value] of [['targetFromChapter', promise.targetFromChapter], ['targetToChapter', promise.targetToChapter], ['volume', promise.volume]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw validationError(`ReaderPromise ${promise.promiseId}.${field} 必须是正整数`)
    }
    if (promise.targetFromChapter !== undefined && promise.targetToChapter !== undefined
      && promise.targetToChapter < promise.targetFromChapter) {
      throw validationError(`ReaderPromise ${promise.promiseId} 的兑现窗口起止倒置`)
    }
    if (promise.status === 'abandoned' && !promise.abandonReason?.trim()) throw validationError(`ReaderPromise ${promise.promiseId} 废弃缺少原因`)
  }
}
