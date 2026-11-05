import path from 'node:path'
import type { ReviewFinding, ReviewReport } from './stage-types.ts'
import { atomicWriteJson, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { objectHash } from './hash.ts'
import { loadStage, saveStage } from './stages.ts'
import { validationError } from './errors.ts'

export type WaiverScope = 'chapter' | 'entity' | 'storyline' | 'project'

export interface ReviewWaiver {
  waiverId: string
  fingerprint: string
  scope: WaiverScope
  scopeRef?: string
  reason: string
  createdAt: string
  expiresAtChapter?: number
  status: 'active' | 'revoked' | 'expired'
}

interface WaiverStore {
  schemaVersion: 1
  waivers: ReviewWaiver[]
}

function storePath(root: string): string {
  return path.join(projectPaths(root).metadata, 'waivers.json')
}

export async function loadWaivers(root: string): Promise<ReviewWaiver[]> {
  const store = await readJsonIfExists<WaiverStore>(storePath(root))
  return store?.waivers ?? []
}

async function saveWaivers(root: string, waivers: ReviewWaiver[]): Promise<void> {
  await atomicWriteJson(storePath(root), { schemaVersion: 1, waivers })
}

export function findingFingerprint(finding: ReviewFinding): string {
  return objectHash({ dimension: finding.dimension, description: finding.description })
}

export async function createWaivers(
  root: string,
  chapter: number,
  findingIds: string[],
  options: { reason: string; scope?: WaiverScope; scopeRef?: string; untilChapter?: number; allWarnings?: boolean },
): Promise<ReviewWaiver[]> {
  const report = await loadStage<ReviewReport>(root, 'review', chapter)
  if (!report) throw validationError(`第 ${chapter} 章没有审查报告`)
  const selected = options.allWarnings
    ? report.findings.filter(finding => finding.severity !== 'blocking')
    : report.findings.filter(finding => findingIds.includes(finding.findingId))
  if (selected.length === 0) throw validationError('没有匹配的审查意见')
  if (!options.reason.trim()) throw validationError('豁免必须提供理由')
  if (selected.some(finding => finding.severity === 'blocking') && options.allWarnings) {
    throw validationError('blocking 意见不能批量豁免')
  }
  const existing = await loadWaivers(root)
  const created: ReviewWaiver[] = []
  for (const finding of selected) {
    const fingerprint = findingFingerprint(finding)
    const active = existing.find(waiver =>
      waiver.fingerprint === fingerprint
      && waiver.scope === (options.scope ?? 'chapter')
      && waiver.scopeRef === (options.scope === 'project' ? undefined : options.scopeRef ?? String(chapter))
      && waiver.status === 'active',
    )
    if (active) {
      created.push(active)
      continue
    }
    const waiver: ReviewWaiver = {
      waiverId: `waiver-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fingerprint,
      scope: options.scope ?? 'chapter',
      ...(options.scope === 'project' ? {} : { scopeRef: options.scopeRef ?? String(chapter) }),
      reason: options.reason.trim(),
      createdAt: new Date().toISOString(),
      ...(options.untilChapter !== undefined ? { expiresAtChapter: options.untilChapter } : {}),
      status: 'active',
    }
    existing.push(waiver)
    created.push(waiver)
  }
  await saveWaivers(root, existing)
  return created
}

export async function revokeWaiver(root: string, waiverId: string): Promise<ReviewWaiver> {
  const waivers = await loadWaivers(root)
  const waiver = waivers.find(item => item.waiverId === waiverId)
  if (!waiver) throw validationError(`未找到豁免：${waiverId}`)
  waiver.status = 'revoked'
  await saveWaivers(root, waivers)
  return waiver
}

export async function applyWaivers(root: string, chapter: number, report: ReviewReport): Promise<ReviewReport> {
  const waivers = await loadWaivers(root)
  let changed = false
  for (const finding of report.findings) {
    if (finding.status === 'waived') continue
    const fingerprint = findingFingerprint(finding)
    const waiver = waivers.find(item => {
      if (item.status !== 'active' || item.fingerprint !== fingerprint) return false
      if (item.expiresAtChapter !== undefined && chapter > item.expiresAtChapter) return false
      if (item.scope === 'project') return true
      if (item.scope === 'chapter') return item.scopeRef === String(chapter)
      return Boolean(item.scopeRef && finding.description.includes(item.scopeRef))
    })
    if (waiver) {
      finding.status = 'waived'
      finding.waiveReason = waiver.reason
      changed = true
    }
  }
  if (changed) {
    report.blockingCount = report.findings.filter(
      finding => finding.severity === 'blocking' && finding.status !== 'waived',
    ).length
    report.passed = report.blockingCount === 0
    await saveStage(root, 'review', chapter, report)
  }
  return report
}
