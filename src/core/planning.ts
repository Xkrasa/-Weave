import path from 'node:path'
import { readJsonIfExists } from './io.ts'
import { atomicWriteJson } from './io.ts'
import { objectHash } from './hash.ts'
import { projectPaths } from './project.ts'
import { conflictError, usageError, validationError } from './errors.ts'

/**
 * Planning artifacts are author intent, not story facts. They are never written to the ledger and
 * only become authoritative after an explicit approval of a specific content hash.
 */
export interface StoryPromise {
  audience: string
  genre: string
  coreFantasy: string
  uniqueSellingPoint: string
  emotionalPromise: string
  protagonistDesire: string
}

export interface VolumeArc {
  volume: number
  title: string
  mainConflict: string
  antagonistEscalation: string
  protagonistChoice: string
  climax: string
  irreversibleChange: string
  threads: string[]
  readerPromises: string[]
}

export interface CharacterArc {
  name: string
  desire: string
  fear: string
  misbelief: string
  voice: string
  relationshipDirection: string
  growthCost: string
}

export interface RollingPlan {
  fromChapter: number
  chapters: Array<{
    chapter: number
    title: string
    goal: string
    beats: string[]
  }>
}

export type PlanKind = 'story' | 'volume' | 'character-arcs' | 'rolling'
export type PlanStatus = 'missing' | 'draft' | 'approved' | 'modified'

export interface PlanEnvelope<T> {
  schemaVersion: 1
  kind: PlanKind
  status: 'draft' | 'approved'
  provenance: 'author' | 'generated'
  contentHash: string
  approvedAt?: string
  approvedBy?: string
  content: T
}

export interface PlanEntry {
  kind: PlanKind
  path: string
  status: PlanStatus
  contentHash: string | null
  approvedAt?: string
  content?: unknown
}

export const PLAN_KINDS: PlanKind[] = ['story', 'volume', 'character-arcs', 'rolling']

export function planPath(root: string, kind: PlanKind, volume?: number): string {
  const dir = projectPaths(root).plans
  if (kind === 'story') return path.join(dir, 'story.json')
  if (kind === 'character-arcs') return path.join(dir, 'character-arcs.json')
  if (kind === 'rolling') return path.join(dir, 'rolling.json')
  return path.join(dir, 'volumes', `${String(volume ?? 1).padStart(3, '0')}.json`)
}

export async function readPlan<T>(root: string, kind: PlanKind, volume?: number): Promise<PlanEntry> {
  const file = planPath(root, kind, volume)
  const envelope = await readJsonIfExists<PlanEnvelope<T>>(file)
  if (!envelope) {
    return { kind, path: file, status: 'missing', contentHash: null }
  }
  const actual = objectHash(envelope.content)
  const status: PlanStatus = envelope.status !== 'approved'
    ? 'draft'
    : envelope.contentHash === actual ? 'approved' : 'modified'
  return {
    kind,
    path: file,
    status,
    contentHash: actual,
    ...(envelope.approvedAt ? { approvedAt: envelope.approvedAt } : {}),
    content: envelope.content,
  }
}

/** Approved content only; a modified-after-approval file stops being authoritative. */
export async function readApprovedPlan<T>(root: string, kind: PlanKind, volume?: number): Promise<T | null> {
  const entry = await readPlan<T>(root, kind, volume)
  return entry.status === 'approved' ? (entry.content as T) : null
}

export async function savePlanDraft<T>(
  root: string,
  kind: PlanKind,
  content: T,
  options: { provenance?: 'author' | 'generated'; volume?: number } = {},
): Promise<PlanEntry> {
  validatePlanContent(kind, content)
  const envelope: PlanEnvelope<T> = {
    schemaVersion: 1,
    kind,
    status: 'draft',
    provenance: options.provenance ?? 'generated',
    contentHash: objectHash(content),
    content,
  }
  const file = planPath(root, kind, options.volume)
  await atomicWriteJson(file, envelope)
  return readPlan(root, kind, options.volume)
}

export async function approvePlan(root: string, kind: PlanKind, volume?: number): Promise<PlanEntry> {
  const file = planPath(root, kind, volume)
  const envelope = await readJsonIfExists<PlanEnvelope<unknown>>(file)
  if (!envelope) throw conflictError(`规划文件不存在：${file}`)
  validatePlanContent(kind, envelope.content)
  const approved: PlanEnvelope<unknown> = {
    ...envelope,
    status: 'approved',
    contentHash: objectHash(envelope.content),
    approvedAt: new Date().toISOString(),
    approvedBy: 'author',
  }
  await atomicWriteJson(file, approved)
  return readPlan(root, kind, volume)
}

export async function listPlans(root: string): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = []
  for (const kind of PLAN_KINDS) {
    if (kind === 'volume') {
      const volumes = await volumeNumbers(root)
      if (volumes.length === 0) entries.push(await readPlan(root, 'volume', 1))
      for (const volume of volumes) entries.push(await readPlan(root, 'volume', volume))
      continue
    }
    entries.push(await readPlan(root, kind))
  }
  return entries
}

export function parsePlanKind(value: string | undefined): PlanKind {
  if (!value || !PLAN_KINDS.includes(value as PlanKind)) {
    throw usageError(`规划类型必须是 ${PLAN_KINDS.join('、')}`)
  }
  return value as PlanKind
}

async function volumeNumbers(root: string): Promise<number[]> {
  const { readdir } = await import('node:fs/promises')
  const dir = path.join(projectPaths(root).plans, 'volumes')
  try {
    return (await readdir(dir))
      .filter(name => /^\d+\.json$/.test(name))
      .map(name => Number(name.replace(/\.json$/, '')))
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

function validatePlanContent(kind: PlanKind, content: unknown): void {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw validationError(`${kind} 规划内容必须是 JSON 对象`)
  }
  const value = content as Record<string, unknown>
  const requireStrings = (fields: string[]): void => {
    for (const field of fields) {
      if (typeof value[field] !== 'string' || !(value[field] as string).trim()) {
        throw validationError(`${kind} 规划缺少字段：${field}`)
      }
    }
  }
  if (kind === 'story') {
    requireStrings(['audience', 'genre', 'coreFantasy', 'uniqueSellingPoint', 'emotionalPromise', 'protagonistDesire'])
  } else if (kind === 'volume') {
    requireStrings(['title', 'mainConflict', 'antagonistEscalation', 'protagonistChoice', 'climax', 'irreversibleChange'])
    if (!Number.isSafeInteger(value.volume) || (value.volume as number) <= 0) {
      throw validationError('volume 必须是正整数')
    }
  } else if (kind === 'rolling') {
    if (!Number.isSafeInteger(value.fromChapter) || (value.fromChapter as number) <= 0) {
      throw validationError('fromChapter 必须是正整数')
    }
    if (!Array.isArray(value.chapters) || value.chapters.length === 0) {
      throw validationError('rolling 规划至少需要一章')
    }
  } else if (kind === 'character-arcs') {
    const characters = value.characters
    if (!Array.isArray(characters) || characters.length === 0) {
      throw validationError('character-arcs 至少需要一个人物')
    }
    for (const character of characters) {
      if (!character || typeof character !== 'object' || typeof (character as Record<string, unknown>).name !== 'string') {
        throw validationError('character-arcs 的每个条目都需要 name')
      }
    }
  }
}
