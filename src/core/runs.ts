import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DraftMeta, RunRecord, RunUsage } from './types.ts'
import { atomicWrite, atomicWriteJson, ensureDir, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { draftPath } from './ledger.ts'
import { chapterFileStem } from './contract.ts'

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
}

export function runPath(root: string, runId: string): string {
  return path.join(projectPaths(root).runs, `${runId}.json`)
}

export function partialPath(root: string, runId: string): string {
  return path.join(projectPaths(root).runs, runId, 'partial.md')
}

export function draftMetaPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).drafts, `${chapterFileStem(chapter)}.json`)
}

export async function saveRun(root: string, run: RunRecord): Promise<void> {
  await ensureDir(projectPaths(root).runs)
  await atomicWriteJson(runPath(root, run.runId), run)
}

export async function loadRun(root: string, runId: string): Promise<RunRecord | null> {
  return readJsonIfExists<RunRecord>(runPath(root, runId))
}

export async function saveDraftMeta(root: string, meta: DraftMeta): Promise<void> {
  await atomicWriteJson(draftMetaPath(root, meta.chapter), meta)
}

export async function loadDraftMeta(root: string, chapter: number): Promise<DraftMeta | null> {
  return readJsonIfExists<DraftMeta>(draftMetaPath(root, chapter))
}

export async function savePartial(root: string, runId: string, text: string): Promise<string> {
  const target = partialPath(root, runId)
  await atomicWrite(target, text)
  return target
}

export async function saveDraft(root: string, chapter: number, text: string): Promise<string> {
  const target = draftPath(root, chapter)
  await atomicWrite(target, text)
  return target
}

export function finishRun(
  run: RunRecord,
  status: RunRecord['status'],
  extra: { usage?: RunUsage; error?: string; partialPath?: string } = {},
): RunRecord {
  return {
    ...run,
    status,
    finishedAt: new Date().toISOString(),
    usage: extra.usage,
    error: extra.error,
    partialPath: extra.partialPath,
  }
}
