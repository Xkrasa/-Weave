import path from 'node:path'
import type { ModelConfig } from './types.ts'
import { atomicWriteJson, readJsonIfExists } from './io.ts'
import { objectHash, hashText } from './hash.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'
import { loadContract, requirePassingContractCheck } from './contract.ts'
import { assertOutlineApproved } from './outline.ts'
import { collectMaterials } from './materials.ts'
import { assembleContext } from './context.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { finishRun, newRunId, saveRun } from './runs.ts'

export type DraftingStrategy = 'prose-first' | 'beat-first'
export type BeatCandidateStatus = 'draft' | 'approved' | 'modified' | 'skipped'

export interface SceneBeat {
  goal: string
  obstacle: string
  turn: string
  infoRelease?: string
  emotionalLanding?: string
  endingState: string
}

export interface BeatCandidate {
  schemaVersion: 1
  chapter: number
  status: 'draft' | 'approved' | 'skipped'
  provenance: 'author' | 'generated'
  contentHash: string
  beats: SceneBeat[]
  planningRunId?: string
  createdAt: string
  approvedAt?: string
  approvedBy?: 'author' | 'benchmark'
  skippedAt?: string
}

export interface BeatCandidateView {
  status: BeatCandidateStatus | 'missing'
  candidate?: BeatCandidate
}

function candidatePath(root: string, chapter: number): string {
  return path.join(projectPaths(root).plans, 'beats', `${String(chapter).padStart(3, '0')}.json`)
}

export async function readBeatCandidate(root: string, chapter: number): Promise<BeatCandidateView> {
  const candidate = await readJsonIfExists<BeatCandidate>(candidatePath(root, chapter))
  if (!candidate) return { status: 'missing' }
  const actual = objectHash({ chapter, beats: candidate.beats })
  const status: BeatCandidateStatus = candidate.status !== 'draft' && candidate.contentHash !== actual
    ? 'modified'
    : candidate.status
  return { status, candidate: { ...candidate, contentHash: actual } }
}

export async function generateBeatCandidate(
  root: string,
  chapter: number,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<BeatCandidate> {
  const existing = await readBeatCandidate(root, chapter)
  if (existing.status !== 'missing') throw conflictError(`第 ${chapter} 章已有节拍候选；请编辑现有候选或明确跳过`)
  await assertOutlineApproved(root, chapter)
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  const taskConfig = resolveTaskConfig(config, 'planning')
  const materials = await collectMaterials(root, contract)
  const assembled = assembleContext(contract, materials, taskConfig)
  if (assembled.decision.decision !== 'ready' || !assembled.context) {
    throw validationError(assembled.decision.decision === 'ready' ? '节拍材料装配失败' : assembled.decision.message)
  }
  const context = assembled.context
  const system = [
    '你是场景节拍规划器，不是正文写作模型。只输出 JSON 对象，不要解释或 Markdown 围栏。',
    '节拍是未来写作的辅助候选，不是已发生事实，不得新增关键设定或越过人物信息边界。',
    '输出 beats 数组；每拍包含 goal、obstacle、turn、endingState，可选 infoRelease、emotionalLanding。',
    '拍数由本章需要决定，不固定。每拍都要改变局势、信息、关系或情绪中的至少一项。',
  ].join('\n')
  const user = [
    '为以下章节规划少量可编辑场景节拍：',
    JSON.stringify(contract, null, 2),
    '',
    '可用材料（保持各自出处，不把未来计划写成事实）：',
    ...context.included.map(item => `【${item.label}｜${item.category}/${item.provenance}】\n${item.text}`),
    '',
    '输出结构：{"beats":[{"goal":"目标","obstacle":"阻力","turn":"转折","infoRelease":"信息释放","emotionalLanding":"情绪落点","endingState":"结束状态"}]}',
  ].join('\n')
  const run = {
    schemaVersion: 1 as const,
    runId: newRunId(),
    chapter,
    status: 'running' as const,
    task: 'planning' as const,
    model: taskConfig.model,
    baseUrl: taskConfig.baseUrl,
    startedAt: new Date().toISOString(),
    contextHash: context.contextHash,
    promptHash: hashText(`${system}\n${user}`),
    materialSourceIds: context.included.map(item => item.sourceId),
  }
  await saveRun(root, run)
  try {
    const result = await completeJsonObject({ config: taskConfig, system, user, signal })
    await appendUsage(root, { task: 'planning', model: taskConfig.model, usage: result.usage })
    const beats = normalizeBeats(result.raw.beats)
    const candidate: BeatCandidate = {
      schemaVersion: 1,
      chapter,
      status: 'draft',
      provenance: 'generated',
      contentHash: objectHash({ chapter, beats }),
      beats,
      planningRunId: run.runId,
      createdAt: new Date().toISOString(),
    }
    await atomicWriteJson(candidatePath(root, chapter), candidate)
    await saveRun(root, finishRun(run, 'completed', { usage: result.usage }))
    return candidate
  } catch (error) {
    await saveRun(root, finishRun(run, 'failed', { error: error instanceof Error ? error.message : String(error) }))
    throw error
  }
}

export async function saveBeatDraft(
  root: string,
  chapter: number,
  beats: SceneBeat[],
  provenance: 'author' | 'generated' = 'author',
): Promise<BeatCandidate> {
  const normalized = normalizeBeats(beats)
  const previous = await readJsonIfExists<BeatCandidate>(candidatePath(root, chapter))
  const candidate: BeatCandidate = {
    schemaVersion: 1,
    chapter,
    status: 'draft',
    provenance,
    contentHash: objectHash({ chapter, beats: normalized }),
    beats: normalized,
    ...(previous?.planningRunId ? { planningRunId: previous.planningRunId } : {}),
    createdAt: new Date().toISOString(),
  }
  await atomicWriteJson(candidatePath(root, chapter), candidate)
  return candidate
}

export async function approveBeatCandidate(
  root: string,
  chapter: number,
  approvedBy: 'author' | 'benchmark' = 'author',
): Promise<BeatCandidate> {
  const candidate = await readJsonIfExists<BeatCandidate>(candidatePath(root, chapter))
  if (!candidate) throw conflictError(`第 ${chapter} 章没有节拍候选`)
  const beats = normalizeBeats(candidate.beats)
  const approved: BeatCandidate = {
    ...candidate,
    status: 'approved',
    contentHash: objectHash({ chapter, beats }),
    approvedAt: new Date().toISOString(),
    approvedBy,
  }
  await atomicWriteJson(candidatePath(root, chapter), approved)
  return approved
}

export async function skipBeatCandidate(root: string, chapter: number): Promise<BeatCandidate> {
  const candidate = await readJsonIfExists<BeatCandidate>(candidatePath(root, chapter))
  if (!candidate) throw conflictError(`第 ${chapter} 章没有节拍候选`)
  const skipped: BeatCandidate = {
    ...candidate,
    status: 'skipped',
    contentHash: objectHash({ chapter, beats: candidate.beats }),
    skippedAt: new Date().toISOString(),
  }
  await atomicWriteJson(candidatePath(root, chapter), skipped)
  return skipped
}

export async function requireApprovedBeats(root: string, chapter: number): Promise<BeatCandidate> {
  const view = await readBeatCandidate(root, chapter)
  if (view.status === 'modified') throw conflictError(`第 ${chapter} 章节拍在批准后已修改，请重新批准`)
  if (view.status === 'skipped') throw conflictError(`第 ${chapter} 章已跳过节拍，请使用默认 prose-first 策略`)
  if (view.status !== 'approved' || !view.candidate) {
    throw conflictError(`第 ${chapter} 章节拍尚未批准；请先执行 beats generate/set 和 beats approve`)
  }
  return view.candidate
}

export function formatBeats(candidate: BeatCandidate): string {
  return JSON.stringify({ chapter: candidate.chapter, beats: candidate.beats, contentHash: candidate.contentHash }, null, 2)
}

function normalizeBeats(value: unknown): SceneBeat[] {
  if (!Array.isArray(value) || value.length === 0) throw validationError('节拍输出必须是非空 beats 数组')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw validationError(`第 ${index + 1} 拍不是对象`)
    const raw = item as Record<string, unknown>
    const goal = requiredText(raw.goal, `第 ${index + 1} 拍 goal`)
    const obstacle = requiredText(raw.obstacle, `第 ${index + 1} 拍 obstacle`)
    const turn = requiredText(raw.turn, `第 ${index + 1} 拍 turn`)
    const endingState = requiredText(raw.endingState, `第 ${index + 1} 拍 endingState`)
    return {
      goal,
      obstacle,
      turn,
      endingState,
      ...(typeof raw.infoRelease === 'string' && raw.infoRelease.trim() ? { infoRelease: raw.infoRelease.trim() } : {}),
      ...(typeof raw.emotionalLanding === 'string' && raw.emotionalLanding.trim() ? { emotionalLanding: raw.emotionalLanding.trim() } : {}),
    }
  })
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${label} 不能为空`)
  return value.trim()
}
