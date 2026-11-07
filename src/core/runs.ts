import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DraftMeta, RunRecord, RunRecovery, RunUsage, StreamAttempt } from './types.ts'
import { atomicWrite, atomicWriteJson, ensureDir, listFiles, readJsonIfExists } from './io.ts'
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
  extra: {
    usage?: RunUsage
    error?: string
    partialPath?: string
    attempts?: StreamAttempt[]
    recovery?: RunRecovery
  } = {},
): RunRecord {
  return {
    ...run,
    status,
    finishedAt: new Date().toISOString(),
    usage: extra.usage,
    error: extra.error,
    partialPath: extra.partialPath,
    ...(extra.attempts ? { attempts: extra.attempts } : {}),
    ...(extra.recovery ? { recovery: extra.recovery } : {}),
  }
}

/** Latest failed/cancelled run of this chapter that left a partial worth recovering from. */
export async function findRecoverableRun(root: string, chapter: number): Promise<RunRecord | null> {
  const dir = projectPaths(root).runs
  const candidates: RunRecord[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const run = await readJsonIfExists<RunRecord>(path.join(dir, name))
    if (!run) continue
    if (run.chapter !== chapter) continue
    if (run.status !== 'failed' && run.status !== 'cancelled') continue
    // Segmented runs keep recoverable work at segment boundaries even before a partial exists.
    if (!run.partialPath && run.draftingStrategy !== 'segmented') continue
    candidates.push(run)
  }
  candidates.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  return candidates[0] ?? null
}
