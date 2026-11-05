import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CommitRecord } from './types.ts'
import { ensureDir } from './io.ts'
import { projectPaths } from './project.ts'
import { readCommit, readMainline } from './ledger.ts'
import { objectHash } from './hash.ts'
import { conflictError } from './errors.ts'

const NAME = 'ledger-index'

export interface LedgerProjectionState {
  name: string
  mainlineRevision: number
  appliedThrough: number
  invalidFrom: number | null
  replayBaseChapter: number | null
  status: 'current' | 'stale' | 'failed'
  updatedAt: string
}

function open(root: string): DatabaseSync {
  const db = new DatabaseSync(projectPaths(root).indexDb)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ledger_projection (
      chapter INTEGER PRIMARY KEY,
      commit_id TEXT NOT NULL,
      ledger_hash TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      fact_count INTEGER NOT NULL,
      belief_count INTEGER NOT NULL,
      loop_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_projection_state (
      name TEXT PRIMARY KEY,
      mainline_revision INTEGER NOT NULL,
      applied_through INTEGER NOT NULL,
      invalid_from INTEGER,
      replay_base_chapter INTEGER,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_projection_snapshots (
      chapter INTEGER PRIMARY KEY,
      mainline_revision INTEGER NOT NULL,
      last_commit TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  return db
}

export async function rebuildLedgerProjection(
  root: string,
  options: { fromChapter?: number } = {},
): Promise<LedgerProjectionState> {
  await ensureDir(projectPaths(root).metadata)
  const head = await readMainline(root)
  const db = open(root)
  try {
    const from = options.fromChapter ?? 1
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM ledger_projection WHERE chapter >= ?').run(from)
    db.prepare('DELETE FROM ledger_projection_snapshots WHERE chapter >= ?').run(from)
    const applied = await apply(db, root, head, Math.max(0, from - 1))
    db.exec('COMMIT')
    return writeState(db, {
      name: NAME,
      mainlineRevision: head.mainlineRevision,
      appliedThrough: applied,
      invalidFrom: null,
      replayBaseChapter: Math.max(0, from - 1),
      status: 'current',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export async function replayLedgerProjectionFrom(
  root: string,
  fromChapter: number,
  invalidate = true,
): Promise<LedgerProjectionState> {
  await ensureDir(projectPaths(root).metadata)
  const head = await readMainline(root)
  const db = open(root)
  try {
    const snapshot = db.prepare(
      'SELECT MAX(chapter) AS chapter FROM ledger_projection_snapshots WHERE chapter < ?',
    ).get(fromChapter) as Record<string, unknown> | undefined
    const base = snapshot?.chapter == null ? 0 : Number(snapshot.chapter)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM ledger_projection WHERE chapter > ?').run(base)
    db.prepare('DELETE FROM ledger_projection_snapshots WHERE chapter > ?').run(base)
    const applied = await apply(db, root, head, base)
    db.exec('COMMIT')
    return writeState(db, {
      name: NAME,
      mainlineRevision: head.mainlineRevision,
      appliedThrough: applied,
      invalidFrom: invalidate ? fromChapter : null,
      replayBaseChapter: base,
      status: 'current',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

async function apply(
  db: DatabaseSync,
  root: string,
  head: Awaited<ReturnType<typeof readMainline>>,
  base: number,
): Promise<number> {
  let applied = base
  const chapters = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .filter(chapter => chapter > base)
    .sort((a, b) => a - b)
  for (const chapter of chapters) {
    const commitId = head.selectedCommitByChapter[String(chapter)]
    if (!commitId) continue
    const commit = await readCommit(root, commitId)
    if (!commit) throw conflictError(`主线引用了不存在的提交：${commitId}`)
    if (commit.schemaVersion === 3) {
      const ledger = commit.ledger ?? { events: [], facts: [], beliefs: [] }
      if (commit.ledgerHash !== objectHash(ledger)) {
        throw conflictError(`第 ${chapter} 章账本哈希不一致`)
      }
      db.prepare(
        `INSERT OR REPLACE INTO ledger_projection
          (chapter, commit_id, ledger_hash, event_count, fact_count, belief_count, loop_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chapter,
        commit.commitId,
        commit.ledgerHash ?? '',
        ledger.events.length,
        ledger.facts.length,
        ledger.beliefs.length,
        ledger.loops?.length ?? 0,
      )
    }
    applied = chapter
  }
  if (applied > 0) {
    const commitId = head.selectedCommitByChapter[String(applied)]
    if (commitId) {
      db.prepare(
        `INSERT OR REPLACE INTO ledger_projection_snapshots (chapter, mainline_revision, last_commit, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(applied, head.mainlineRevision, commitId, new Date().toISOString())
    }
  }
  return applied
}

export async function readLedgerProjectionState(root: string): Promise<LedgerProjectionState | null> {
  await ensureDir(projectPaths(root).metadata)
  const db = open(root)
  try {
    const row = db.prepare(
      `SELECT name, mainline_revision, applied_through, invalid_from,
              replay_base_chapter, status, updated_at
       FROM ledger_projection_state WHERE name = ?`,
    ).get(NAME) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      name: String(row.name),
      mainlineRevision: Number(row.mainline_revision),
      appliedThrough: Number(row.applied_through),
      invalidFrom: row.invalid_from == null ? null : Number(row.invalid_from),
      replayBaseChapter: row.replay_base_chapter == null ? null : Number(row.replay_base_chapter),
      status: String(row.status) as LedgerProjectionState['status'],
      updatedAt: String(row.updated_at),
    }
  } finally {
    db.close()
  }
}

export async function assertLedgerProjectionCurrent(root: string): Promise<void> {
  const head = await readMainline(root)
  let hasLedger = false
  for (const commitId of Object.values(head.selectedCommitByChapter)) {
    const commit = await readCommit(root, commitId)
    if (commit?.schemaVersion === 3) {
      hasLedger = true
      break
    }
  }
  if (!hasLedger) return
  const state = await readLedgerProjectionState(root)
  if (!state) throw conflictError('账本投影缺失；请执行 weave rebuild --projection ledger')
  if (state.mainlineRevision !== head.mainlineRevision) {
    throw conflictError('账本投影落后于主线；请执行 weave rebuild --projection ledger')
  }
  if (state.status !== 'current') {
    throw conflictError(`账本投影不可用（${state.status}）；请先重建`)
  }
  const maxChapter = Math.max(...Object.keys(head.selectedCommitByChapter).map(Number))
  if (state.appliedThrough < maxChapter) {
    throw conflictError('账本投影未应用到最新章节；请先重建')
  }
}

function writeState(db: DatabaseSync, state: LedgerProjectionState): LedgerProjectionState {
  db.prepare(
    `INSERT INTO ledger_projection_state
      (name, mainline_revision, applied_through, invalid_from, replay_base_chapter, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       mainline_revision = excluded.mainline_revision,
       applied_through = excluded.applied_through,
       invalid_from = excluded.invalid_from,
       replay_base_chapter = excluded.replay_base_chapter,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(
    state.name,
    state.mainlineRevision,
    state.appliedThrough,
    state.invalidFrom,
    state.replayBaseChapter,
    state.status,
    state.updatedAt,
  )
  return state
}

export async function markLedgerProjectionFailed(root: string): Promise<void> {
  const state = await readLedgerProjectionState(root)
  if (!state) return
  const db = open(root)
  try {
    writeState(db, { ...state, status: 'failed', updatedAt: new Date().toISOString() })
  } finally {
    db.close()
  }
}
