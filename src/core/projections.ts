import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CommitRecord, MainlineHead, ProjectionState } from './types.ts'
import { ensureDir, fileHash, readJsonIfExists } from './io.ts'
import { loadModelConfig, projectPaths } from './project.ts'
import { materializeFinal, readCommit, readMainline } from './ledger.ts'
import { conflictError } from './errors.ts'

const PROJECTION_NAME = 'content-index'

function openIndex(root: string): DatabaseSync {
  const paths = projectPaths(root)
  const db = new DatabaseSync(paths.indexDb)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projection_state (
      name TEXT PRIMARY KEY,
      mainline_revision INTEGER NOT NULL,
      applied_through INTEGER NOT NULL,
      last_commit TEXT,
      invalid_from INTEGER,
      replay_base_chapter INTEGER,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_index (
      commit_id TEXT PRIMARY KEY,
      chapter INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      chars INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projection_snapshots (
      name TEXT NOT NULL,
      chapter INTEGER NOT NULL,
      mainline_revision INTEGER NOT NULL,
      last_commit TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (name, chapter)
    );
    CREATE INDEX IF NOT EXISTS idx_content_index_chapter ON content_index(chapter);
  `)
  const columns = db.prepare('PRAGMA table_info(projection_state)').all() as Array<Record<string, unknown>>
  if (!columns.some(column => column.name === 'replay_base_chapter')) {
    db.exec('ALTER TABLE projection_state ADD COLUMN replay_base_chapter INTEGER')
  }
  return db
}

export async function rebuildProjection(root: string, options: { materialize?: boolean } = {}): Promise<ProjectionState> {
  await ensureDir(projectPaths(root).metadata)
  const head = await readMainline(root)
  const snapshotEvery = await snapshotInterval(root)
  const db = openIndex(root)
  try {
    const prior = readStateFromDb(db)
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM content_index')
    db.exec('DELETE FROM projection_snapshots')
    const applied = await applyChapters(db, root, head, 0, options, snapshotEvery, prior?.lastCommit ?? null)
    const updatedAt = new Date().toISOString()
    const state: ProjectionState = {
      name: PROJECTION_NAME,
      mainlineRevision: head.mainlineRevision,
      appliedThrough: applied.appliedThrough,
      lastCommit: applied.lastCommit,
      invalidFrom: prior?.invalidFrom ?? null,
      replayBaseChapter: 0,
      status: 'current',
      updatedAt,
    }
    writeState(db, state)
    db.exec('COMMIT')
    return state
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export async function replayProjectionFrom(
  root: string,
  fromChapter: number,
  options: { materialize?: boolean } = {},
): Promise<ProjectionState> {
  await ensureDir(projectPaths(root).metadata)
  const head = await readMainline(root)
  const snapshotEvery = await snapshotInterval(root)
  const db = openIndex(root)
  try {
    const prior = readStateFromDb(db)
    const base = nearestSnapshot(db, fromChapter)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM content_index WHERE chapter > ?').run(base)
    db.prepare('DELETE FROM projection_snapshots WHERE chapter > ?').run(base)
    const applied = await applyChapters(db, root, head, base, options, snapshotEvery, prior?.lastCommit ?? null)
    const state: ProjectionState = {
      name: PROJECTION_NAME,
      mainlineRevision: head.mainlineRevision,
      appliedThrough: applied.appliedThrough,
      lastCommit: applied.lastCommit,
      invalidFrom: prior?.invalidFrom ?? fromChapter,
      replayBaseChapter: base,
      status: 'current',
      updatedAt: new Date().toISOString(),
    }
    writeState(db, state)
    db.exec('COMMIT')
    return state
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

async function applyChapters(
  db: DatabaseSync,
  root: string,
  head: MainlineHead,
  baseChapter: number,
  options: { materialize?: boolean },
  snapshotEvery: number,
  previousLastCommit: string | null,
): Promise<{ appliedThrough: number; lastCommit: string | null }> {
  const snapshotRow = baseChapter > 0
    ? db.prepare('SELECT last_commit FROM projection_snapshots WHERE name = ? AND chapter = ?')
      .get(PROJECTION_NAME, baseChapter) as Record<string, unknown> | undefined
    : undefined
  let lastCommit = snapshotRow?.last_commit
    ? String(snapshotRow.last_commit)
    : baseChapter === 0 ? null : previousLastCommit
  let appliedThrough = baseChapter
  const chapters = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .filter(chapter => chapter > baseChapter)
    .sort((a, b) => a - b)

  for (const chapter of chapters) {
    const commitId = head.selectedCommitByChapter[String(chapter)]
    if (!commitId) continue
    const commit = await readCommit(root, commitId)
    if (!commit) throw conflictError(`主线引用了不存在的提交：${commitId}`)
    const contentPath = path.join(root, commit.contentPath)
    const actual = await fileHash(contentPath)
    if (actual !== commit.contentHash) throw conflictError(`第 ${chapter} 章历史版本哈希不一致`)
    if (options.materialize) await materializeFinal(root, commit)
    const title = await chapterTitle(root, commit)
    const size = await byteLength(contentPath)
    db.prepare(
      `INSERT OR REPLACE INTO content_index (commit_id, chapter, revision, content_hash, path, title, chars)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(commit.commitId, chapter, commit.revision, commit.contentHash, commit.contentPath, title, size)
    lastCommit = commit.commitId
    appliedThrough = Math.max(appliedThrough, chapter)
    if (chapter % snapshotEvery === 0) {
      insertSnapshot(db, chapter, head.mainlineRevision, commit.commitId)
    }
  }

  if (appliedThrough > 0 && lastCommit) {
    insertSnapshot(db, appliedThrough, head.mainlineRevision, lastCommit)
  }
  return { appliedThrough, lastCommit }
}

function insertSnapshot(db: DatabaseSync, chapter: number, revision: number, commitId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO projection_snapshots (name, chapter, mainline_revision, last_commit, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(PROJECTION_NAME, chapter, revision, commitId, new Date().toISOString())
}

function nearestSnapshot(db: DatabaseSync, beforeChapter: number): number {
  const row = db.prepare(
    'SELECT MAX(chapter) AS chapter FROM projection_snapshots WHERE name = ? AND chapter < ?',
  ).get(PROJECTION_NAME, beforeChapter) as Record<string, unknown> | undefined
  return row?.chapter == null ? 0 : Number(row.chapter)
}

async function snapshotInterval(root: string): Promise<number> {
  try {
    const config = await loadModelConfig(root)
    return Number.isSafeInteger(config.snapshotEvery) && config.snapshotEvery > 0 ? config.snapshotEvery : 10
  } catch {
    return 10
  }
}

export async function invalidateProjection(root: string, chapter: number): Promise<ProjectionState> {
  await ensureDir(projectPaths(root).metadata)
  const db = openIndex(root)
  try {
    const head = await readMainline(root)
    const previous = readStateFromDb(db)
    const invalidFrom = previous?.invalidFrom == null ? chapter : Math.min(previous.invalidFrom, chapter)
    const state: ProjectionState = {
      name: PROJECTION_NAME,
      mainlineRevision: head.mainlineRevision,
      appliedThrough: Math.max(0, chapter - 1),
      lastCommit: previous?.lastCommit ?? null,
      invalidFrom,
      replayBaseChapter: previous?.replayBaseChapter ?? null,
      status: 'stale',
      updatedAt: new Date().toISOString(),
    }
    writeState(db, state)
    return state
  } finally {
    db.close()
  }
}

export async function readProjectionState(root: string): Promise<ProjectionState | null> {
  await ensureDir(projectPaths(root).metadata)
  const db = openIndex(root)
  try {
    return readStateFromDb(db)
  } finally {
    db.close()
  }
}

export async function assertProjectionCurrent(root: string): Promise<void> {
  const head = await readMainline(root)
  if (Object.keys(head.selectedCommitByChapter).length === 0) return
  const state = await readProjectionState(root)
  if (!state) throw conflictError('派生投影缺失；请先执行 weave rebuild')
  if (state.mainlineRevision !== head.mainlineRevision) {
    throw conflictError('派生投影落后于当前主线；请执行 weave rebuild')
  }
  if (state.status !== 'current') {
    throw conflictError(`派生投影不可用（${state.status}）；请先执行 weave rebuild`)
  }
  const maxChapter = Math.max(...Object.keys(head.selectedCommitByChapter).map(Number))
  if (state.appliedThrough < maxChapter) {
    throw conflictError(`派生投影只应用到第 ${state.appliedThrough} 章；请执行 weave rebuild`)
  }
}

export async function markProjectionFailed(root: string, _message: string): Promise<ProjectionState> {
  const current = (await readProjectionState(root)) ?? {
    name: PROJECTION_NAME,
    mainlineRevision: 0,
    appliedThrough: 0,
    lastCommit: null,
    invalidFrom: 1,
    replayBaseChapter: null,
    status: 'failed' as const,
    updatedAt: new Date().toISOString(),
  }
  const state: ProjectionState = {
    ...current,
    status: 'failed',
    updatedAt: new Date().toISOString(),
  }
  const db = openIndex(root)
  try {
    writeState(db, state)
  } finally {
    db.close()
  }
  return state
}

function readStateFromDb(db: DatabaseSync): ProjectionState | null {
  const row = db.prepare(
    `SELECT name, mainline_revision, applied_through, last_commit, invalid_from,
            replay_base_chapter, status, updated_at
     FROM projection_state WHERE name = ?`,
  ).get(PROJECTION_NAME) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    name: String(row.name),
    mainlineRevision: Number(row.mainline_revision),
    appliedThrough: Number(row.applied_through),
    lastCommit: row.last_commit ? String(row.last_commit) : null,
    invalidFrom: row.invalid_from == null ? null : Number(row.invalid_from),
    replayBaseChapter: row.replay_base_chapter == null ? null : Number(row.replay_base_chapter),
    status: String(row.status) as ProjectionState['status'],
    updatedAt: String(row.updated_at),
  }
}

function writeState(db: DatabaseSync, state: ProjectionState): void {
  db.prepare(
    `INSERT INTO projection_state
       (name, mainline_revision, applied_through, last_commit, invalid_from, replay_base_chapter, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       mainline_revision = excluded.mainline_revision,
       applied_through = excluded.applied_through,
       last_commit = excluded.last_commit,
       invalid_from = excluded.invalid_from,
       replay_base_chapter = excluded.replay_base_chapter,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(
    state.name,
    state.mainlineRevision,
    state.appliedThrough,
    state.lastCommit,
    state.invalidFrom,
    state.replayBaseChapter,
    state.status,
    state.updatedAt,
  )
}

async function byteLength(filePath: string): Promise<number> {
  const { stat } = await import('node:fs/promises')
  return (await stat(filePath)).size
}

async function chapterTitle(root: string, commit: CommitRecord): Promise<string> {
  const contractPath = path.join(
    projectPaths(root).outlines,
    'chapters',
    `${String(commit.chapter).padStart(3, '0')}.json`,
  )
  const parsed = await readJsonIfExists<{ title?: string }>(contractPath)
  return parsed?.title ?? ''
}
