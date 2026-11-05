import path from 'node:path'
import { appendFile } from 'node:fs/promises'
import type { CommitRecord, MainlineHead } from './types.ts'
import { atomicWrite, atomicWriteJson, ensureDir, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { commitFileName, hashFileBytes, objectHash } from './hash.ts'
import { chapterFileStem } from './contract.ts'
import { projectPaths } from './project.ts'
import { conflictError } from './errors.ts'
import { readFile } from 'node:fs/promises'

export function emptyMainline(): MainlineHead {
  return { mainlineRevision: 0, selectedCommitByChapter: {}, previousHead: null, updatedAt: new Date(0).toISOString() }
}

export async function readMainline(root: string): Promise<MainlineHead> {
  const text = await readTextIfExists(projectPaths(root).mainline)
  if (!text) return emptyMainline()
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return emptyMainline()
  return JSON.parse(lines[lines.length - 1]!) as MainlineHead
}

export async function appendMainline(root: string, selectedCommitByChapter: Record<string, string>): Promise<MainlineHead> {
  const paths = projectPaths(root)
  const previous = await readMainline(root)
  const head: MainlineHead = {
    mainlineRevision: previous.mainlineRevision + 1,
    selectedCommitByChapter: { ...selectedCommitByChapter },
    previousHead: previous.mainlineRevision === 0 ? null : objectHash(previous),
    updatedAt: new Date().toISOString(),
  }
  await ensureDir(path.dirname(paths.mainline))
  await appendFile(paths.mainline, `${JSON.stringify(head)}\n`, 'utf8')
  return head
}

export function versionPath(root: string, chapter: number, revision: number): string {
  return path.join(
    projectPaths(root).versionsDir,
    chapterFileStem(chapter),
    `rev-${String(revision).padStart(3, '0')}.md`,
  )
}

export function finalPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).finalDir, `${chapterFileStem(chapter)}.md`)
}

export function draftPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).draftsDir, `${chapterFileStem(chapter)}.md`)
}

export function impactPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).impacts, `${chapterFileStem(chapter)}.json`)
}

export async function readCommit(root: string, commitId: string): Promise<CommitRecord | null> {
  return readJsonIfExists<CommitRecord>(path.join(projectPaths(root).commits, commitFileName(commitId)))
}

export async function writeCommit(root: string, commit: CommitRecord): Promise<string> {
  const target = path.join(projectPaths(root).commits, commitFileName(commit.commitId))
  await atomicWriteJson(target, commit)
  return target
}

export async function listCommits(root: string): Promise<CommitRecord[]> {
  const dir = projectPaths(root).commits
  const names = await listFiles(dir)
  const commits: CommitRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const commit = await readJsonIfExists<CommitRecord>(path.join(dir, name))
    if (commit) commits.push(commit)
  }
  return commits.sort((a, b) => a.chapter - b.chapter || a.revision - b.revision)
}

export async function commitsForChapter(root: string, chapter: number): Promise<CommitRecord[]> {
  return (await listCommits(root)).filter(commit => commit.chapter === chapter)
}

export async function currentCommit(root: string, chapter: number): Promise<CommitRecord | null> {
  const head = await readMainline(root)
  const commitId = head.selectedCommitByChapter[String(chapter)]
  if (!commitId) return null
  return readCommit(root, commitId)
}

export function buildCommit(input: {
  chapter: number
  revision: number
  supersedes: string | null
  contentHash: string
  contractHash: string
  contextHash: string
  contentPath: string
}): CommitRecord {
  const body = {
    schemaVersion: 1 as const,
    commitId: '',
    chapter: input.chapter,
    revision: input.revision,
    supersedes: input.supersedes,
    contentHash: input.contentHash,
    contractHash: input.contractHash,
    contextHash: input.contextHash,
    contentPath: input.contentPath,
    createdAt: new Date().toISOString(),
    evidence: [] as never[],
  }
  body.commitId = objectHash({
    schemaVersion: 1,
    chapter: input.chapter,
    supersedes: input.supersedes,
    contentHash: input.contentHash,
    contractHash: input.contractHash,
    contextHash: input.contextHash,
  })
  return body
}

export async function materializeFinal(root: string, commit: CommitRecord): Promise<void> {
  const source = path.join(root, commit.contentPath)
  const bytes = await readFile(source)
  const actualHash = hashFileBytes(bytes)
  if (actualHash !== commit.contentHash) {
    throw conflictError(`历史版本哈希不一致：第 ${commit.chapter} 章 ${commit.commitId}`)
  }
  await atomicWrite(finalPath(root, commit.chapter), bytes)
}

export async function assertFinalIntegrity(root: string): Promise<void> {
  const head = await readMainline(root)
  for (const chapter of Object.keys(head.selectedCommitByChapter).map(Number)) {
    const commit = await currentCommit(root, chapter)
    if (!commit) throw conflictError(`第 ${chapter} 章主线提交缺失`)
    let bytes: Uint8Array
    try {
      bytes = await readFile(finalPath(root, chapter))
    } catch {
      throw conflictError(`第 ${chapter} 章正式正文缺失`)
    }
    if (hashFileBytes(bytes) !== commit.contentHash) {
      throw conflictError(`第 ${chapter} 章正式正文与提交不一致；请先恢复或执行 weave amend ${chapter}`, {
        chapter,
        expected: commit.contentHash,
        actual: hashFileBytes(bytes),
      })
    }
  }
}

export async function ensureUniqueCommit(root: string, commit: CommitRecord): Promise<void> {
  const existing = await readCommit(root, commit.commitId)
  if (existing) throw conflictError(`提交已存在：${commit.commitId}`)
}
