import path from 'node:path'
import type { ChapterContract, CommitRecord, ImpactItem, ImpactReport } from './types.ts'
import { atomicWriteJson, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { impactPath, readCommit, readMainline, currentCommit, finalPath } from './ledger.ts'
import { loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { conflictError, usageError } from './errors.ts'

interface ImpactWaiver {
  sourceChapter: number
  targetChapter: number
  reason: string
  createdAt: string
}

function waiverPath(root: string): string {
  return path.join(projectPaths(root).impacts, 'waivers.json')
}

async function loadImpactWaivers(root: string): Promise<ImpactWaiver[]> {
  const data = await readJsonIfExists<{ waivers?: ImpactWaiver[] }>(waiverPath(root))
  return data?.waivers ?? []
}

async function saveImpactWaiver(root: string, waiver: ImpactWaiver): Promise<void> {
  const waivers = await loadImpactWaivers(root)
  if (waivers.some(item => item.sourceChapter === waiver.sourceChapter && item.targetChapter === waiver.targetChapter)) {
    return
  }
  waivers.push(waiver)
  await atomicWriteJson(waiverPath(root), { schemaVersion: 1, waivers })
}

export async function createImpactReport(
  root: string,
  sourceChapter: number,
  sourceCommit: CommitRecord,
): Promise<ImpactReport> {
  const contract = await loadContract(root, sourceChapter)
  const head = await readMainline(root)
  const targets = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .filter(chapter => chapter > sourceChapter)
    .sort((a, b) => a - b)
  const waivers = await loadImpactWaivers(root)

  const items: ImpactItem[] = []
  for (const targetChapter of targets) {
    const targetContract = await safeContract(root, targetChapter)
    const targetCommitId = head.selectedCommitByChapter[String(targetChapter)]
    const targetCommit = targetCommitId ? await readCommit(root, targetCommitId) : null
    const text = (await readTextIfExists(finalPath(root, targetChapter))) ?? ''
    const item = classifyImpact(contract, targetContract, text, targetChapter)
    const ledger = ledgerDependencies(sourceCommit, targetCommit, targetContract)
    const dependencies = [...new Set([...item.dependencies, ...ledger.dependencies])]
    const level = ledger.dependencies.length > 0 && item.level === 'unknown' ? 'confirmed' : item.level
    const waived = waivers.some(waiver =>
      waiver.sourceChapter === sourceChapter && waiver.targetChapter === targetChapter,
    )
    items.push({
      targetChapter,
      level,
      reason: ledger.dependencies.length > 0 ? `${item.reason}；账本依赖：${ledger.dependencies.join('、')}` : item.reason,
      dependencies,
      evidence: ledger.evidence,
      status: waived ? 'accepted' : level === 'unknown' ? 'deferred' : 'pending',
    })
  }

  const report: ImpactReport = {
    schemaVersion: 1,
    sourceChapter,
    sourceRevision: sourceCommit.revision,
    sourceCommit: sourceCommit.commitId,
    mainlineRevision: head.mainlineRevision,
    createdAt: new Date().toISOString(),
    items,
  }
  await atomicWriteJson(impactPath(root, sourceChapter), report)
  return report
}

function ledgerDependencies(
  source: CommitRecord,
  target: CommitRecord | null,
  targetContract: ChapterContract | null,
): { dependencies: string[]; evidence: string[] } {
  const dependencies: string[] = []
  const evidence: string[] = []
  if (!source.ledger) return { dependencies, evidence }
  const targetEntities = new Set<string>(targetContract?.characters ?? [])
  for (const event of target?.ledger?.events ?? []) {
    for (const participant of event.participants) targetEntities.add(participant)
  }
  for (const fact of target?.ledger?.facts ?? []) targetEntities.add(fact.subject)
  for (const loop of target?.ledger?.loops ?? []) {
    for (const entity of loop.relatedEntities) targetEntities.add(entity)
  }
  for (const event of source.ledger.events) {
    if (event.participants.some(participant => targetEntities.has(participant))) {
      dependencies.push(`event:${event.eventId}`)
      evidence.push(`event:${event.eventId}:${event.evidence.map(span => span.quote).join('|')}`)
    }
  }
  for (const fact of source.ledger.facts) {
    if (targetEntities.has(fact.subject)) {
      dependencies.push(`fact:${fact.factId}`)
      evidence.push(`fact:${fact.factId}:${fact.evidence.map(span => span.quote).join('|')}`)
    }
  }
  for (const loop of source.ledger.loops ?? []) {
    if (loop.relatedEntities.some(entity => targetEntities.has(entity))) {
      dependencies.push(`loop:${loop.loopId}`)
      evidence.push(`loop:${loop.loopId}:${loop.evidence.map(span => span.quote).join('|')}`)
    }
  }
  return { dependencies: [...new Set(dependencies)], evidence: [...new Set(evidence)] }
}

export function classifyImpact(
  source: ChapterContract,
  target: ChapterContract | null,
  targetText: string,
  targetChapter: number,
): { level: ImpactItem['level']; reason: string; dependencies: string[] } {
  if (!target) return { level: 'unknown', reason: `第 ${targetChapter} 章合同缺失，无法建立依赖`, dependencies: [] }
  const sharedCharacters = source.characters.filter(name => target.characters.includes(name))
  if (sharedCharacters.length > 0) {
    return {
      level: 'confirmed',
      reason: `共享人物：${sharedCharacters.join('、')}`,
      dependencies: sharedCharacters.map(name => `character:${name}`),
    }
  }
  if (source.location && target.location === source.location) {
    return {
      level: 'confirmed',
      reason: `同一地点：${source.location}`,
      dependencies: [`location:${source.location}`],
    }
  }
  const sharedThreads = source.threads.filter(thread => target.threads.includes(thread))
  if (sharedThreads.length > 0) {
    return {
      level: 'confirmed',
      reason: `共同故事线：${sharedThreads.join('、')}`,
      dependencies: sharedThreads.map(thread => `thread:${thread}`),
    }
  }
  const mentioned = source.characters.filter(name => name && targetText.includes(name))
  if (mentioned.length > 0) {
    return {
      level: 'likely',
      reason: `后文提及：${mentioned.join('、')}`,
      dependencies: mentioned.map(name => `text:${name}`),
    }
  }
  if (source.location && targetText.includes(source.location)) {
    return {
      level: 'likely',
      reason: `后文提及地点：${source.location}`,
      dependencies: [`text:${source.location}`],
    }
  }
  return { level: 'unknown', reason: '没有可机读的依赖关系，需人工判断', dependencies: [] }
}

export async function loadImpactReport(root: string, chapter: number): Promise<ImpactReport | null> {
  const report = await readJsonIfExists<ImpactReport>(impactPath(root, chapter))
  if (!report) return null
  const head = await readMainline(root)
  if (report.mainlineRevision !== undefined && report.mainlineRevision !== head.mainlineRevision) return null
  return report
}

export async function loadImpactReports(root: string): Promise<ImpactReport[]> {
  const dir = projectPaths(root).impacts
  const head = await readMainline(root)
  const reports: ImpactReport[] = []
  for (const name of await listFiles(dir)) {
    if (!/^\d{3}\.json$/.test(name)) continue
    const report = await readJsonIfExists<ImpactReport>(path.join(dir, name))
    if (!report) continue
    if (report.mainlineRevision !== undefined && report.mainlineRevision !== head.mainlineRevision) continue
    reports.push(report)
  }
  return reports.sort((a, b) => a.sourceChapter - b.sourceChapter)
}

export async function pendingImpactItems(root: string): Promise<Array<ImpactReport & { items: ImpactItem[] }>> {
  const reports = await loadImpactReports(root)
  return reports
    .map(report => ({
      ...report,
      items: report.items.filter(item => item.status === 'pending'),
    }))
    .filter(report => report.items.length > 0)
}

export async function assertNoPendingImpacts(root: string): Promise<void> {
  const pending = await pendingImpactItems(root)
  if (pending.length === 0) return
  throw conflictError('存在未处理的影响面，暂不能定稿', {
    sources: pending.map(report => ({
      chapter: report.sourceChapter,
      targets: report.items.map(item => ({ chapter: item.targetChapter, level: item.level })),
    })),
  })
}

export async function resolveImpact(
  root: string,
  sourceChapter: number,
  options: { target?: number; all?: boolean; decision: 'accept' | 'revise' | 'defer' },
): Promise<ImpactReport> {
  const target = impactPath(root, sourceChapter)
  const report = await readJsonIfExists<ImpactReport>(target)
  if (!report) throw usageError(`第 ${sourceChapter} 章没有影响面报告`)
  if (!options.all && options.target === undefined) {
    throw usageError('请指定 --target <chapter> 或 --all')
  }
  const selected = report.items.filter(item => options.all || item.targetChapter === options.target)
  if (selected.length === 0) throw usageError('指定章节不在影响面报告中')

  const status: ImpactItem['status'] =
    options.decision === 'accept' ? 'accepted' : options.decision === 'revise' ? 'revision-planned' : 'deferred'
  for (const item of report.items) {
    if (!selected.includes(item)) continue
    item.status = status
    item.decidedAt = new Date().toISOString()
    if (options.decision === 'accept') {
      await saveImpactWaiver(root, {
        sourceChapter,
        targetChapter: item.targetChapter,
        reason: '作者接受漂移',
        createdAt: new Date().toISOString(),
      })
    }
  }
  await atomicWriteJson(target, report)
  return report
}

export async function impactSummary(root: string): Promise<Array<{ chapter: number; pending: number; targets: number[] }>> {
  const reports = await loadImpactReports(root)
  return reports.map(report => ({
    chapter: report.sourceChapter,
    pending: report.items.filter(item => item.status === 'pending' || item.status === 'deferred').length,
    targets: report.items.map(item => item.targetChapter),
  }))
}

async function safeContract(root: string, chapter: number): Promise<ChapterContract | null> {
  try {
    return await loadContract(root, chapter)
  } catch {
    return null
  }
}
