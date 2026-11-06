import path from 'node:path'
import { appendFile } from 'node:fs/promises'
import type { Material } from './types.ts'
import { atomicWriteJson, ensureDir, readJsonIfExists, readTextIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { conflictError, validationError } from './errors.ts'
import { hashText } from './hash.ts'

export type PreferenceKind = 'accepted' | 'rejected'
export type PreferenceSource = 'merge' | 'ignore' | 'waive'

export interface PreferenceSignal {
  kind: PreferenceKind
  source: PreferenceSource
  chapter: number
  dimension: string
  reason?: string
  findingId?: string
  revisionId?: string
  at: string
}

export interface PreferenceCandidate {
  id: string
  dimension: string
  rule: string
  evidenceCount: number
  status: 'draft' | 'approved' | 'disabled'
  createdAt: string
}

function dirOf(root: string): string {
  return path.join(projectPaths(root).metadata, 'preferences')
}

function signalsPath(root: string): string {
  return path.join(dirOf(root), 'signals.jsonl')
}

function candidatesPath(root: string): string {
  return path.join(dirOf(root), 'candidates.json')
}

function approvedPath(root: string): string {
  return path.join(dirOf(root), 'approved.json')
}

export async function recordPreferenceSignal(
  root: string,
  signal: Omit<PreferenceSignal, 'at'>,
): Promise<void> {
  if (!signal.dimension.trim()) return
  await ensureDir(dirOf(root))
  await appendFile(signalsPath(root), `${JSON.stringify({ ...signal, at: new Date().toISOString() })}\n`)
}

export async function listPreferenceSignals(root: string): Promise<PreferenceSignal[]> {
  const text = await readTextIfExists(signalsPath(root))
  const signals: PreferenceSignal[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      signals.push(JSON.parse(line) as PreferenceSignal)
    } catch {
      // A corrupt line must not block the rest of the learning history.
    }
  }
  return signals
}

/**
 * Only repeated rejection becomes a candidate. One ignored warning never turns into a rule.
 */
export async function reviewPreferenceCandidates(root: string): Promise<PreferenceCandidate[]> {
  const signals = await listPreferenceSignals(root)
  const existing = await readJsonIfExists<PreferenceCandidate[]>(candidatesPath(root)) ?? []
  const approved = await readApprovedPreferences(root)
  const byDimension = new Map<string, PreferenceSignal[]>()
  for (const signal of signals) {
    if (signal.kind !== 'rejected') continue
    const list = byDimension.get(signal.dimension) ?? []
    list.push(signal)
    byDimension.set(signal.dimension, list)
  }
  const candidates: PreferenceCandidate[] = []
  for (const [dimension, list] of byDimension) {
    if (list.length < 2) continue
    const reasons = [...new Set(list.map(signal => signal.reason?.trim()).filter(Boolean))].slice(0, 3)
    const rule = reasons.length > 0
      ? `在「${dimension}」方面，作者通常不接受以下建议：${reasons.join('；')}。改写时优先保留作者原意。`
      : `在「${dimension}」方面，作者连续 ${list.length} 次未采纳系统建议；除非有正文证据，不要重复提出。`
    const id = `pref-${dimension.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 24)}`
    const prior = existing.find(item => item.id === id)
    const isApproved = approved.some(item => item.id === id)
    candidates.push({
      id,
      dimension,
      rule,
      evidenceCount: list.length,
      status: isApproved ? 'approved' : prior?.status === 'disabled' ? 'disabled' : 'draft',
      createdAt: prior?.createdAt ?? new Date().toISOString(),
    })
  }
  await ensureDir(dirOf(root))
  await atomicWriteJson(candidatesPath(root), candidates)
  return candidates
}

export async function listPreferenceCandidates(root: string): Promise<PreferenceCandidate[]> {
  return await readJsonIfExists<PreferenceCandidate[]>(candidatesPath(root)) ?? []
}

export async function readApprovedPreferences(root: string): Promise<PreferenceCandidate[]> {
  return await readJsonIfExists<PreferenceCandidate[]>(approvedPath(root)) ?? []
}

export async function approvePreference(root: string, id: string): Promise<PreferenceCandidate> {
  const candidates = await reviewPreferenceCandidates(root)
  const candidate = candidates.find(item => item.id === id)
  if (!candidate) throw conflictError(`未找到偏好候选：${id}`)
  const approved = (await readApprovedPreferences(root)).filter(item => item.id !== id)
  const entry: PreferenceCandidate = { ...candidate, status: 'approved' }
  approved.push(entry)
  await atomicWriteJson(approvedPath(root), approved)
  await atomicWriteJson(
    candidatesPath(root),
    candidates.map(item => item.id === id ? entry : item),
  )
  return entry
}

export async function disablePreference(root: string, id: string): Promise<void> {
  const approved = await readApprovedPreferences(root)
  if (!approved.some(item => item.id === id)) throw validationError(`未找到已批准的偏好：${id}`)
  await atomicWriteJson(approvedPath(root), approved.filter(item => item.id !== id))
  const candidates = await listPreferenceCandidates(root)
  await atomicWriteJson(
    candidatesPath(root),
    candidates.map(item => item.id === id ? { ...item, status: 'disabled' as const } : item),
  )
}

export async function clearPreferences(root: string): Promise<void> {
  await atomicWriteJson(approvedPath(root), [])
  await atomicWriteJson(candidatesPath(root), [])
}

/** Approved rules are author intent for style, never story facts. */
export function preferenceMaterial(preferences: PreferenceCandidate[]): Material | null {
  const active = preferences.filter(item => item.status === 'approved')
  if (active.length === 0) return null
  const text = active.map(item => `- ${item.rule}`).join('\n')
  return {
    sourceId: 'preference:approved',
    category: 'author',
    provenance: 'author',
    required: false,
    label: '已批准的创作偏好（不是故事事实）',
    text,
    contentHash: hashText(text),
    visibility: 'project',
    purpose: '减少重复的无效建议',
    priority: 4,
  }
}

/** Dimensions of the findings a merged revision resolved. */
export async function recordMergeAccepted(
  root: string,
  chapter: number,
  revisionId: string,
  dimensions: string[],
): Promise<void> {
  for (const dimension of dimensions) {
    await recordPreferenceSignal(root, { kind: 'accepted', source: 'merge', chapter, dimension, revisionId })
  }
}
