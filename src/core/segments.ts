import path from 'node:path'
import type { ChapterContract } from './types.ts'
import { atomicWrite, atomicWriteJson, readJsonIfExists } from './io.ts'
import { objectHash } from './hash.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'
import { contractHash, loadContract } from './contract.ts'
import { readBeatCandidate, requireApprovedBeats, type SceneBeat } from './beats.ts'

export const MAX_SEGMENTS = 6
export const DEFAULT_SEGMENT_WORDS = 2_000
export const MIN_SEGMENT_WORDS = 1_500
export const MAX_SEGMENT_WORDS = 2_500

export type SegmentStatus = 'planned' | 'generating' | 'draft' | 'checked' | 'approved' | 'failed'

export interface ChapterSegment {
  segmentId: string
  index: number
  beatIds: string[]
  goal: string
  entryState: string
  exitState: string
  targetWords: number
  mustNotHappen: string[]
  status: SegmentStatus
  textPath?: string
  contentHash?: string
  runId?: string
}

export interface ChapterSegmentPlan {
  schemaVersion: 1
  chapter: number
  planHash: string
  contractHash: string
  beatContentHash: string
  targetWords: number
  segments: ChapterSegment[]
  createdAt: string
  approvedAt?: string
  approvedBy?: 'author'
  skippedAt?: string
}

export interface SegmentPlanView {
  status: 'missing' | 'draft' | 'modified' | 'approved' | 'skipped'
  plan?: ChapterSegmentPlan
}

function chapterDirName(chapter: number): string {
  return `chapter-${String(chapter).padStart(3, '0')}`
}

export function segmentPlanDir(root: string, chapter: number): string {
  return path.join(projectPaths(root).segments, chapterDirName(chapter))
}

export function segmentPlanPath(root: string, chapter: number): string {
  return path.join(segmentPlanDir(root, chapter), 'plan.json')
}

export function segmentTextPath(root: string, chapter: number, segmentId: string): string {
  return path.join(segmentPlanDir(root, chapter), `${segmentId}.md`)
}

export function beatId(index: number): string {
  return `beat-${String(index + 1).padStart(2, '0')}`
}

export function segmentId(index: number): string {
  return `seg-${String(index + 1).padStart(2, '0')}`
}

/** Segments carry author intent only; runtime status is deliberately excluded. */
function intentOf(plan: Pick<ChapterSegmentPlan, 'chapter' | 'targetWords' | 'segments'>): unknown {
  return {
    chapter: plan.chapter,
    targetWords: plan.targetWords,
    segments: plan.segments.map(segment => ({
      segmentId: segment.segmentId,
      index: segment.index,
      beatIds: segment.beatIds,
      goal: segment.goal,
      entryState: segment.entryState,
      exitState: segment.exitState,
      targetWords: segment.targetWords,
      mustNotHappen: segment.mustNotHappen,
    })),
  }
}

export function segmentPlanHash(plan: Pick<ChapterSegmentPlan, 'chapter' | 'targetWords' | 'segments'>): string {
  return objectHash(intentOf(plan))
}

function beatContentHash(chapter: number, beats: SceneBeat[]): string {
  return objectHash({ chapter, beats })
}

const HIGH_TURN_MARKERS = ['高潮', '反转', '真相', '揭露', '对决', '摊牌', '崩溃', '爆发', '冲突', '决战']
const TRANSITION_MARKERS = ['过渡', '铺垫', '准备', '等待', '日常', '前夜', '将至']

function beatWeight(beat: SceneBeat): number {
  const authored = beat.targetWords
  if (authored !== undefined && Number.isFinite(authored) && authored > 0) return authored
  const text = [beat.goal, beat.turn, beat.emotionalLanding ?? ''].join(' ')
  if (HIGH_TURN_MARKERS.some(marker => text.includes(marker))) return 1.3
  if (TRANSITION_MARKERS.some(marker => text.includes(marker))) return 0.8
  return 1
}

function splitEvenly<T>(items: T[], groups: number): T[][] {
  const result: T[][] = []
  let start = 0
  for (let index = 0; index < groups; index += 1) {
    const remainingItems = items.length - start
    const remainingGroups = groups - index
    const size = Math.ceil(remainingItems / remainingGroups)
    result.push(items.slice(start, start + size))
    start += size
  }
  return result
}

function groupBeatsBySegmentId(beats: SceneBeat[]): SceneBeat[][] {
  const groups: SceneBeat[][] = []
  for (const beat of beats) {
    const current = groups.at(-1)
    if (current && current[0]!.segmentId === beat.segmentId) current.push(beat)
    else groups.push([beat])
  }
  return groups
}

export function proposeSegmentPlan(contract: ChapterContract, beats: SceneBeat[]): {
  targetWords: number
  segments: ChapterSegment[]
} {
  const desired = Math.min(
    MAX_SEGMENTS,
    beats.length,
    Math.max(1, Math.round(contract.targetWords / DEFAULT_SEGMENT_WORDS)),
  )
  const groups = beats.every(beat => beat.segmentId) ? groupBeatsBySegmentId(beats) : splitEvenly(beats, desired)
  if (groups.length > MAX_SEGMENTS) {
    throw validationError(`分段数 ${groups.length} 超过上限 ${MAX_SEGMENTS}；请拆章或减少节拍`)
  }

  const weights = groups.map(group => group.reduce((sum, beat) => sum + beatWeight(beat), 0))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const targets = weights.map(weight => Math.max(1, Math.round((weight / totalWeight) * contract.targetWords)))
  const baseSum = targets.reduce((sum, value) => sum + value, 0)
  targets[targets.length - 1] = Math.max(1, targets[targets.length - 1]! + (contract.targetWords - baseSum))

  const segments: ChapterSegment[] = []
  let beatIndex = 0
  let nextEntryState = contract.openingState
  groups.forEach((group, index) => {
    const beatIds = group.map(() => beatId(beatIndex++))
    const last = index === groups.length - 1
    const exitState = last ? contract.endingState : group.at(-1)!.endingState
    segments.push({
      segmentId: segmentId(index),
      index: index + 1,
      beatIds,
      goal: group.map(beat => beat.goal).join('；'),
      entryState: nextEntryState,
      exitState,
      targetWords: targets[index]!,
      mustNotHappen: [...contract.mustNotHappen],
      status: 'planned',
    })
    nextEntryState = exitState
  })

  const outOfRange = segments.filter(
    segment => segment.targetWords < MIN_SEGMENT_WORDS || segment.targetWords > MAX_SEGMENT_WORDS,
  )
  if (outOfRange.length > 0) {
    const detail = outOfRange
      .map(segment => `${segment.segmentId}=${segment.targetWords}`)
      .join('、')
    throw validationError(
      `分段字数超出 ${MIN_SEGMENT_WORDS}–${MAX_SEGMENT_WORDS} 字：${detail}；请调整合同目标字数、节拍数量或 beat.targetWords 后再生成计划`,
    )
  }

  return { targetWords: contract.targetWords, segments }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${label} 不能为空`)
  return value.trim()
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw validationError(`${label} 必须是字符串`)
  return value.trim() || undefined
}

function normalizeAuthorPlan(chapter: number, raw: unknown, contractTargetWords: number): Pick<ChapterSegmentPlan, 'chapter' | 'targetWords' | 'segments'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validationError('分段计划必须是 JSON 对象')
  const record = raw as Record<string, unknown>
  const segmentValue = record.segments
  if (!Array.isArray(segmentValue) || segmentValue.length === 0) throw validationError('分段计划必须包含非空 segments 数组')
  const segments = segmentValue.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw validationError(`第 ${index + 1} 段不是对象`)
    const entry = item as Record<string, unknown>
    const beatIds = Array.isArray(entry.beatIds)
      ? entry.beatIds.map((id, beatIndex) => requiredText(id, `第 ${index + 1} 段第 ${beatIndex + 1} 个 beatId`))
      : []
    if (beatIds.length === 0) throw validationError(`第 ${index + 1} 段至少需要一个 beatId`)
    const targetWords = entry.targetWords
    if (!Number.isSafeInteger(targetWords) || Number(targetWords) <= 0) {
      throw validationError(`第 ${index + 1} 段 targetWords 必须是正整数`)
    }
    const mustNotHappen = entry.mustNotHappen === undefined
      ? []
      : Array.isArray(entry.mustNotHappen)
        ? entry.mustNotHappen.map(value => requiredText(value, `第 ${index + 1} 段 mustNotHappen`))
        : (() => { throw validationError(`第 ${index + 1} 段 mustNotHappen 必须是字符串数组`) })()
    return {
      segmentId: segmentId(index),
      index: index + 1,
      beatIds,
      goal: requiredText(entry.goal, `第 ${index + 1} 段 goal`),
      entryState: requiredText(entry.entryState, `第 ${index + 1} 段 entryState`),
      exitState: requiredText(entry.exitState, `第 ${index + 1} 段 exitState`),
      targetWords: Number(targetWords),
      mustNotHappen,
      status: 'planned' as const,
    }
  })
  const targetWords = record.targetWords === undefined ? contractTargetWords : Number(record.targetWords)
  if (!Number.isSafeInteger(targetWords) || targetWords <= 0) throw validationError('分段计划 targetWords 必须是正整数')
  if (targetWords !== contractTargetWords) {
    throw validationError(`分段计划目标字数 ${targetWords} 与合同 ${contractTargetWords} 不一致`)
  }
  return {
    chapter,
    targetWords,
    segments,
  }
}

export function validateSegmentPlan(
  plan: Pick<ChapterSegmentPlan, 'chapter' | 'targetWords' | 'segments'>,
  contract: ChapterContract,
  beats: SceneBeat[],
): string[] {
  const errors: string[] = []
  if (plan.chapter !== contract.chapter) errors.push(`计划章号 ${plan.chapter} 与合同 ${contract.chapter} 不一致`)
  if (plan.segments.length === 0) errors.push('分段计划不能为空')
  if (plan.segments.length > MAX_SEGMENTS) errors.push(`分段数 ${plan.segments.length} 超过上限 ${MAX_SEGMENTS}`)
  if (plan.targetWords !== contract.targetWords) {
    errors.push(`计划目标字数 ${plan.targetWords} 与合同 ${contract.targetWords} 不一致`)
  }

  const expectedIds = beats.map((_, index) => beatId(index))
  const covered: string[] = []
  const seenIds = new Set<string>()
  plan.segments.forEach((segment, index) => {
    if (segment.index !== index + 1) errors.push(`第 ${index + 1} 段 index 应为 ${index + 1}`)
    if (segment.segmentId !== segmentId(index)) errors.push(`第 ${index + 1} 段 segmentId 应为 ${segmentId(index)}`)
    if (segment.beatIds.length === 0) errors.push(`第 ${index + 1} 段至少需要覆盖一个节拍`)
    for (const id of segment.beatIds) {
      if (!expectedIds.includes(id)) errors.push(`第 ${index + 1} 段引用了不存在的节拍 ${id}`)
      if (seenIds.has(id)) errors.push(`节拍 ${id} 被重复分配到多个段`)
      seenIds.add(id)
      covered.push(id)
    }
    if (!Number.isSafeInteger(segment.targetWords) || segment.targetWords <= 0) {
      errors.push(`第 ${index + 1} 段 targetWords 必须是正整数`)
    } else if (segment.targetWords < MIN_SEGMENT_WORDS || segment.targetWords > MAX_SEGMENT_WORDS) {
      errors.push(`第 ${index + 1} 段 targetWords ${segment.targetWords} 超出 ${MIN_SEGMENT_WORDS}–${MAX_SEGMENT_WORDS} 字`)
    }
  })
  const missing = expectedIds.filter(id => !seenIds.has(id))
  if (missing.length > 0) errors.push(`分段计划遗漏节拍：${missing.join('、')}`)

  const sum = plan.segments.reduce((total, segment) => total + segment.targetWords, 0)
  const tolerance = Math.max(1, Math.round(contract.targetWords * 0.1))
  if (Math.abs(sum - contract.targetWords) > tolerance) {
    errors.push(`各段目标字数之和 ${sum} 超出合同 ${contract.targetWords} 的 ±10%`)
  }
  if (plan.segments[0]?.entryState !== contract.openingState) {
    errors.push('第一段 entryState 必须等于合同 openingState')
  }
  if (plan.segments.at(-1)?.exitState !== contract.endingState) {
    errors.push('最后一段 exitState 必须等于合同 endingState')
  }
  for (let index = 1; index < plan.segments.length; index += 1) {
    if (plan.segments[index]!.entryState !== plan.segments[index - 1]!.exitState) {
      errors.push(`第 ${index + 1} 段 entryState 与上一段 exitState 不衔接`)
    }
  }
  return errors
}

export async function saveSegmentPlan(root: string, chapter: number, raw: unknown): Promise<ChapterSegmentPlan> {
  const contract = await loadContract(root, chapter)
  const beats = await requireApprovedBeats(root, chapter)
  const author = normalizeAuthorPlan(chapter, raw, contract.targetWords)
  const planBase = { ...author, chapter, targetWords: contract.targetWords }
  const errors = validateSegmentPlan(planBase, contract, beats.beats)
  if (errors.length > 0) throw validationError(`分段计划非法：${errors.join('；')}`, errors)
  const plan: ChapterSegmentPlan = {
    schemaVersion: 1,
    chapter,
    planHash: segmentPlanHash(planBase),
    contractHash: contractHash(contract),
    beatContentHash: beatContentHash(chapter, beats.beats),
    targetWords: contract.targetWords,
    segments: planBase.segments,
    createdAt: new Date().toISOString(),
  }
  await atomicWriteJson(segmentPlanPath(root, chapter), plan)
  return plan
}

/** Deterministic proposal: no model call, no approval, no ledger writes. */
export async function planSegments(root: string, chapter: number): Promise<ChapterSegmentPlan> {
  const contract = await loadContract(root, chapter)
  const beats = await requireApprovedBeats(root, chapter)
  const proposal = proposeSegmentPlan(contract, beats.beats)
  return saveSegmentPlan(root, chapter, { ...proposal, targetWords: contract.targetWords })
}

export async function readSegmentPlan(root: string, chapter: number): Promise<SegmentPlanView> {
  const stored = await readJsonIfExists<ChapterSegmentPlan>(segmentPlanPath(root, chapter))
  if (!stored) return { status: 'missing' }
  if (stored.skippedAt) return { status: 'skipped', plan: stored }

  const plan = normalizeStoredPlan(stored)
  const actualHash = segmentPlanHash(plan)
  let currentContractHash: string | null = null
  try {
    currentContractHash = contractHash(await loadContract(root, chapter))
  } catch {
    currentContractHash = null
  }
  const beatView = await readBeatCandidate(root, chapter)
  const currentBeatHash = beatView.candidate
    ? beatContentHash(chapter, beatView.candidate.beats)
    : null

  if (
    actualHash !== plan.planHash ||
    currentContractHash !== plan.contractHash ||
    currentBeatHash !== plan.beatContentHash
  ) {
    return { status: 'modified', plan: { ...plan, planHash: actualHash } }
  }
  if (plan.approvedAt && plan.approvedBy === 'author') return { status: 'approved', plan }
  return { status: 'draft', plan }
}

function normalizeStoredPlan(stored: ChapterSegmentPlan): ChapterSegmentPlan {
  return {
    ...stored,
    segments: stored.segments.map((segment, index) => ({
      ...segment,
      segmentId: segment.segmentId ?? segmentId(index),
      index: segment.index ?? index + 1,
      mustNotHappen: segment.mustNotHappen ?? [],
      status: segment.status ?? 'planned',
    })),
  }
}

export async function approveSegmentPlan(root: string, chapter: number): Promise<ChapterSegmentPlan> {
  const view = await readSegmentPlan(root, chapter)
  if (view.status === 'missing' || !view.plan) {
    throw conflictError(`第 ${chapter} 章没有分段计划；请先执行 weave segments plan ${chapter}`)
  }
  const contract = await loadContract(root, chapter)
  const beats = await requireApprovedBeats(root, chapter)
  const planBase = { chapter, targetWords: contract.targetWords, segments: view.plan.segments }
  const errors = validateSegmentPlan(planBase, contract, beats.beats)
  if (errors.length > 0) throw validationError(`分段计划非法：${errors.join('；')}`, errors)
  const plan: ChapterSegmentPlan = {
    ...view.plan,
    schemaVersion: 1,
    planHash: segmentPlanHash(planBase),
    contractHash: contractHash(contract),
    beatContentHash: beatContentHash(chapter, beats.beats),
    targetWords: contract.targetWords,
    segments: planBase.segments,
    createdAt: view.plan.createdAt || new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    approvedBy: 'author',
  }
  delete plan.skippedAt
  await atomicWriteJson(segmentPlanPath(root, chapter), plan)
  return plan
}

export async function skipSegmentPlan(root: string, chapter: number): Promise<ChapterSegmentPlan> {
  const stored = await readJsonIfExists<ChapterSegmentPlan>(segmentPlanPath(root, chapter))
  if (!stored) throw conflictError(`第 ${chapter} 章没有分段计划`)
  const plan: ChapterSegmentPlan = { ...stored, skippedAt: new Date().toISOString() }
  await atomicWriteJson(segmentPlanPath(root, chapter), plan)
  return plan
}

export async function requireApprovedSegmentPlan(root: string, chapter: number): Promise<ChapterSegmentPlan> {
  const view = await readSegmentPlan(root, chapter)
  switch (view.status) {
    case 'missing':
      throw conflictError(`第 ${chapter} 章没有分段计划；请先执行 weave segments plan 和 segments approve`)
    case 'skipped':
      throw conflictError(`第 ${chapter} 章已跳过分段计划；请使用默认 prose-first 策略`)
    case 'modified':
      throw conflictError(`第 ${chapter} 章分段计划在批准后已变化；请重新执行 weave segments approve`)
    case 'draft':
      throw conflictError(`第 ${chapter} 章分段计划尚未批准；请执行 weave segments approve`)
    case 'approved':
      return view.plan!
  }
}

async function loadPlanFile(root: string, chapter: number): Promise<ChapterSegmentPlan> {
  const plan = await readJsonIfExists<ChapterSegmentPlan>(segmentPlanPath(root, chapter))
  if (!plan) throw conflictError(`第 ${chapter} 章没有分段计划`)
  return normalizeStoredPlan(plan)
}

export async function markSegmentStatus(
  root: string,
  chapter: number,
  targetId: string,
  status: SegmentStatus,
  extra: { contentHash?: string; textPath?: string; runId?: string } = {},
): Promise<void> {
  const plan = await loadPlanFile(root, chapter)
  plan.segments = plan.segments.map(segment => segment.segmentId === targetId
    ? {
        ...segment,
        status,
        ...(extra.contentHash !== undefined ? { contentHash: extra.contentHash } : {}),
        ...(extra.textPath !== undefined ? { textPath: extra.textPath } : {}),
        ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
      }
    : segment)
  await atomicWriteJson(segmentPlanPath(root, chapter), plan)
}

export async function resetSegmentRun(root: string, chapter: number, keep: string[] = []): Promise<void> {
  const keepSet = new Set(keep)
  const plan = await loadPlanFile(root, chapter)
  plan.segments = plan.segments.map(segment => keepSet.has(segment.segmentId)
    ? segment
    : {
        ...segment,
        status: 'planned',
        textPath: `${segment.segmentId}.md`,
      })
  await atomicWriteJson(segmentPlanPath(root, chapter), plan)
}

export async function saveSegmentOutput(
  root: string,
  chapter: number,
  targetId: string,
  text: string,
  runId: string,
): Promise<{ contentHash: string; textPath: string }> {
  const textPath = `${targetId}.md`
  await atomicWrite(segmentTextPath(root, chapter, targetId), text)
  const contentHash = objectHash({ segmentId: targetId, text })
  await markSegmentStatus(root, chapter, targetId, 'draft', { contentHash, textPath, runId })
  return { contentHash, textPath }
}

