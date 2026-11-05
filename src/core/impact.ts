import path from 'node:path'
import type { ChapterContract, CommitRecord, ImpactItem, ImpactReport } from './types.ts'
import { atomicWriteJson, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { impactPath, readMainline, currentCommit, finalPath } from './ledger.ts'
import { loadContract } from './contract.ts'
import { projectPaths } from './project.ts'
import { conflictError, usageError } from './errors.ts'

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

  const items: ImpactItem[] = []
  for (const targetChapter of targets) {
    const targetContract = await safeContract(root, targetChapter)
    const text = (await readTextIfExists(finalPath(root, targetChapter))) ?? ''
    const item = classifyImpact(contract, targetContract, text, targetChapter)
    items.push({
      targetChapter,
      level: item.level,
      reason: item.reason,
      dependencies: item.dependencies,
      status: 'pending',
    })
  }

  const report: ImpactReport = {
    schemaVersion: 1,
    sourceChapter,
    sourceRevision: sourceCommit.revision,
    sourceCommit: sourceCommit.commitId,
    createdAt: new Date().toISOString(),
    items,
  }
  await atomicWriteJson(impactPath(root, sourceChapter), report)
  return report
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
  return readJsonIfExists<ImpactReport>(impactPath(root, chapter))
}

export async function loadImpactReports(root: string): Promise<ImpactReport[]> {
  const dir = projectPaths(root).impacts
  const reports: ImpactReport[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const report = await readJsonIfExists<ImpactReport>(path.join(dir, name))
    if (report) reports.push(report)
  }
  return reports.sort((a, b) => a.sourceChapter - b.sourceChapter)
}

export async function pendingImpactItems(root: string): Promise<Array<ImpactReport & { items: ImpactItem[] }>> {
  const reports = await loadImpactReports(root)
  return reports
    .map(report => ({
      ...report,
      items: report.items.filter(item => item.status === 'pending' || item.status === 'deferred'),
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
