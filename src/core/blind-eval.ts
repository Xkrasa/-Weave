import path from 'node:path'
import { appendFile, readdir } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { atomicWriteJson, ensureDir, readJsonIfExists, readTextIfExists } from './io.ts'
import { conflictError, usageError, validationError } from './errors.ts'

/**
 * Blind pairwise reading sessions. The reader only ever sees `left` / `right`; which strategy
 * produced each side lives in `mapping.json`, which no read API returns until the session is
 * complete (or the author explicitly forces a reveal). Scores are append-only JSONL so the raw
 * judgement history stays auditable; the latest score per (pair, reader) wins.
 */

export interface EvalPair {
  pairId: string
  seed?: string
  chapter?: number
  left: string
  right: string
}

export interface EvalMapping {
  a?: string
  b?: string
  entries: Array<{ pairId: string; left: 'a' | 'b'; right: 'a' | 'b' }>
}

export interface EvalSession {
  schemaVersion: 1
  sessionId: string
  title: string
  source: string
  createdAt: string
  labels?: { a?: string; b?: string }
}

export type EvalWinner = 'left' | 'right' | 'tie'

export interface EvalScore {
  pairId: string
  winner: EvalWinner
  reader: string
  note?: string
  /** Verbatim excerpt where the reader would have stopped reading this side. */
  stopLeft?: string
  stopRight?: string
  createdAt: string
}

export interface EvalSessionSummary {
  sessionId: string
  title: string
  source: string
  createdAt: string
  total: number
  scored: number
  sealed: boolean
}

export interface EvalReport {
  sessionId: string
  title: string
  total: number
  scored: number
  complete: boolean
  revealed: boolean
  ties: number
  wins?: { a: number; b: number }
  winRateA?: number | null
  labels?: { a?: string; b?: string }
  stopPoints: { left: number; right: number; a?: number; b?: number }
  note: string
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function evalsDir(root: string): string {
  return path.join(root, 'evals')
}

function sessionDir(root: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw usageError('盲评会话 id 只能包含字母、数字、- 和 _')
  return path.join(evalsDir(root), sessionId)
}

/** Copies a `benchmark pairs` output directory into the project as a reading session. */
export async function importEvalPairs(
  root: string,
  pairsDir: string,
  options: { sessionId?: string; title?: string } = {},
): Promise<EvalSessionSummary> {
  const source = path.resolve(pairsDir)
  const pairs = await readJsonIfExists<EvalPair[]>(path.join(source, 'pairs.json'))
  if (!pairs) throw validationError(`未找到 ${path.join(source, 'pairs.json')}`)
  const mapping = await readJsonIfExists<EvalMapping>(path.join(source, 'mapping.json'))
  const sessionId = options.sessionId ?? defaultSessionId(path.basename(source))
  return writeSession(root, {
    sessionId,
    title: options.title ?? path.basename(source),
    source,
    pairs,
    mapping,
  })
}

/**
 * Builds a session from two labelled versions of the same passages. Sides are shuffled per pair
 * so position bias cannot masquerade as preference.
 */
export async function createEvalSession(
  root: string,
  input: {
    sessionId: string
    title: string
    source: string
    labels?: { a?: string; b?: string }
    entries: Array<{ pairId: string; chapter?: number; a: string; b: string }>
  },
): Promise<EvalSessionSummary> {
  const pairs: EvalPair[] = []
  const entries: EvalMapping['entries'] = []
  for (const entry of input.entries) {
    const swapped = randomInt(2) === 1
    pairs.push({
      pairId: entry.pairId,
      ...(entry.chapter !== undefined ? { chapter: entry.chapter } : {}),
      left: swapped ? entry.b : entry.a,
      right: swapped ? entry.a : entry.b,
    })
    entries.push({ pairId: entry.pairId, left: swapped ? 'b' : 'a', right: swapped ? 'a' : 'b' })
  }
  return writeSession(root, {
    sessionId: input.sessionId,
    title: input.title,
    source: input.source,
    pairs,
    mapping: { a: input.labels?.a, b: input.labels?.b, entries },
    labels: input.labels,
  })
}

async function writeSession(
  root: string,
  input: {
    sessionId: string
    title: string
    source: string
    pairs: EvalPair[]
    mapping: EvalMapping | null
    labels?: { a?: string; b?: string }
  },
): Promise<EvalSessionSummary> {
  const dir = sessionDir(root, input.sessionId)
  if (await readJsonIfExists(path.join(dir, 'session.json'))) {
    throw conflictError(`盲评会话 ${input.sessionId} 已存在`)
  }
  validatePairs(input.pairs)
  if (input.mapping) validateMapping(input.pairs, input.mapping)
  await ensureDir(dir)
  const session: EvalSession = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    title: input.title,
    source: input.source,
    createdAt: new Date().toISOString(),
    ...(input.labels ? { labels: input.labels } : {}),
  }
  await atomicWriteJson(path.join(dir, 'pairs.json'), input.pairs)
  if (input.mapping) await atomicWriteJson(path.join(dir, 'mapping.json'), input.mapping)
  await atomicWriteJson(path.join(dir, 'session.json'), session)
  return summarize(root, session)
}

export async function listEvalSessions(root: string): Promise<EvalSessionSummary[]> {
  const names = await readdir(evalsDir(root), { withFileTypes: true }).catch(() => [])
  const summaries: EvalSessionSummary[] = []
  for (const entry of names) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
    const session = await readJsonIfExists<EvalSession>(path.join(evalsDir(root), entry.name, 'session.json'))
    if (session) summaries.push(await summarize(root, session))
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Next pair this reader has not judged yet; never includes mapping information. */
export async function nextEvalPair(
  root: string,
  sessionId: string,
  reader = 'author',
): Promise<{ pair: EvalPair | null; progress: { scored: number; total: number } }> {
  const { pairs } = await loadSession(root, sessionId)
  const scores = latestScores(await loadScores(root, sessionId))
  const judged = new Set(scores.filter(score => score.reader === reader).map(score => score.pairId))
  const pair = pairs.find(item => !judged.has(item.pairId)) ?? null
  return { pair, progress: { scored: judged.size, total: pairs.length } }
}

export async function recordEvalScore(
  root: string,
  sessionId: string,
  input: Partial<EvalScore>,
): Promise<EvalScore> {
  const { pairs } = await loadSession(root, sessionId)
  const pair = pairs.find(item => item.pairId === input.pairId)
  if (!pair) throw validationError(`盲评会话中没有 ${String(input.pairId)}`)
  if (input.winner !== 'left' && input.winner !== 'right' && input.winner !== 'tie') {
    throw validationError('winner 必须是 left、right 或 tie')
  }
  const reader = typeof input.reader === 'string' && input.reader.trim() ? input.reader.trim() : 'author'
  const score: EvalScore = {
    pairId: pair.pairId,
    winner: input.winner,
    reader,
    createdAt: new Date().toISOString(),
  }
  if (typeof input.note === 'string' && input.note.trim()) score.note = input.note.trim()
  for (const side of ['Left', 'Right'] as const) {
    const key = `stop${side}` as const
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const text = side === 'Left' ? pair.left : pair.right
    // A stop point must be locatable; otherwise it cannot be fed back as evidence.
    if (!text.includes(value.trim())) throw validationError(`弃读点引文不在${side === 'Left' ? '左' : '右'}栏正文中`)
    score[key] = value.trim()
  }
  await ensureDir(sessionDir(root, sessionId))
  await appendFile(path.join(sessionDir(root, sessionId), 'scores.jsonl'), `${JSON.stringify(score)}\n`, 'utf8')
  return score
}

/**
 * Win rates stay sealed until every pair has a judgement, so a reader cannot be nudged by a
 * running tally. `force` exists for the author to end a session early on purpose.
 */
export async function evalReport(root: string, sessionId: string, options: { force?: boolean } = {}): Promise<EvalReport> {
  const { session, pairs, mapping } = await loadSession(root, sessionId)
  const scores = latestScores(await loadScores(root, sessionId))
  const scoredPairs = new Set(scores.map(score => score.pairId))
  const complete = pairs.length > 0 && pairs.every(pair => scoredPairs.has(pair.pairId))
  const reveal = Boolean(mapping) && (complete || options.force === true)
  const ties = scores.filter(score => score.winner === 'tie').length
  const stopPoints: EvalReport['stopPoints'] = {
    left: scores.filter(score => score.stopLeft).length,
    right: scores.filter(score => score.stopRight).length,
  }
  const report: EvalReport = {
    sessionId,
    title: session.title,
    total: pairs.length,
    scored: scoredPairs.size,
    complete,
    revealed: reveal,
    ties,
    stopPoints,
    note: !mapping
      ? '会话没有 mapping.json，只能记录评分，无法换算策略胜率'
      : reveal
        ? '小样本平局不等于失败；单次胜率不能单独作为回滚或翻转默认值的依据'
        : '评分完成前胜率保持密封',
  }
  if (!reveal || !mapping) return report
  const byId = new Map(mapping.entries.map(entry => [entry.pairId, entry]))
  const wins = { a: 0, b: 0 }
  const stops = { a: 0, b: 0 }
  for (const score of scores) {
    const entry = byId.get(score.pairId)
    if (!entry) continue
    if (score.winner !== 'tie') wins[score.winner === 'left' ? entry.left : entry.right] += 1
    if (score.stopLeft) stops[entry.left] += 1
    if (score.stopRight) stops[entry.right] += 1
  }
  const decided = wins.a + wins.b
  report.wins = wins
  report.winRateA = decided === 0 ? null : Number((wins.a / decided).toFixed(3))
  report.labels = session.labels ?? { a: mapping.a, b: mapping.b }
  report.stopPoints = { ...stopPoints, ...stops }
  return report
}

async function loadSession(root: string, sessionId: string): Promise<{
  session: EvalSession
  pairs: EvalPair[]
  mapping: EvalMapping | null
}> {
  const dir = sessionDir(root, sessionId)
  const session = await readJsonIfExists<EvalSession>(path.join(dir, 'session.json'))
  if (!session) throw validationError(`未找到盲评会话：${sessionId}`)
  const pairs = (await readJsonIfExists<EvalPair[]>(path.join(dir, 'pairs.json'))) ?? []
  const mapping = await readJsonIfExists<EvalMapping>(path.join(dir, 'mapping.json'))
  return { session, pairs, mapping }
}

async function loadScores(root: string, sessionId: string): Promise<EvalScore[]> {
  const raw = await readTextIfExists(path.join(sessionDir(root, sessionId), 'scores.jsonl'))
  if (!raw) return []
  const scores: EvalScore[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      scores.push(JSON.parse(line) as EvalScore)
    } catch {
      // A torn final line must not hide every earlier judgement.
    }
  }
  return scores
}

function latestScores(scores: EvalScore[]): EvalScore[] {
  const latest = new Map<string, EvalScore>()
  for (const score of scores) latest.set(`${score.pairId}\u0000${score.reader ?? 'author'}`, score)
  return [...latest.values()]
}

async function summarize(root: string, session: EvalSession): Promise<EvalSessionSummary> {
  const { pairs, mapping } = await loadSession(root, session.sessionId)
  const scored = new Set(latestScores(await loadScores(root, session.sessionId)).map(score => score.pairId))
  return {
    sessionId: session.sessionId,
    title: session.title,
    source: session.source,
    createdAt: session.createdAt,
    total: pairs.length,
    scored: pairs.filter(pair => scored.has(pair.pairId)).length,
    sealed: Boolean(mapping),
  }
}

function validatePairs(pairs: unknown): asserts pairs is EvalPair[] {
  if (!Array.isArray(pairs) || pairs.length === 0) throw validationError('盲评会话至少需要一对正文')
  const seen = new Set<string>()
  for (const pair of pairs) {
    const value = pair as Partial<EvalPair> | null
    if (!value || typeof value.pairId !== 'string' || !value.pairId) throw validationError('每一对都需要 pairId')
    if (seen.has(value.pairId)) throw validationError(`pairId 重复：${value.pairId}`)
    seen.add(value.pairId)
    if (typeof value.left !== 'string' || typeof value.right !== 'string' || !value.left.trim() || !value.right.trim()) {
      throw validationError(`${value.pairId} 缺少左右正文`)
    }
  }
}

function validateMapping(pairs: EvalPair[], mapping: EvalMapping): void {
  const ids = new Set(pairs.map(pair => pair.pairId))
  for (const entry of mapping.entries ?? []) {
    if (!ids.has(entry.pairId)) throw validationError(`mapping 中的 ${entry.pairId} 不在 pairs.json`)
    const sides = [entry.left, entry.right].sort().join()
    if (sides !== 'a,b') throw validationError(`mapping ${entry.pairId} 的左右必须分别是 a 和 b`)
  }
}

function defaultSessionId(base: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  return `${cleaned}-${stamp}`
}
