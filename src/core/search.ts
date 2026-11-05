import { DatabaseSync } from 'node:sqlite'
import { projectPaths } from './project.ts'
import { readCommit, readMainline, finalPath } from './ledger.ts'
import { readTextIfExists } from './io.ts'
import { conflictError } from './errors.ts'
import { loadContract } from './contract.ts'

export interface SearchResult {
  chunkId: string
  chapter: number
  paragraph: number
  text: string
  sourceCommit: string
  parentChunkId: string
  evidence: {
    sourceContentHash: string
    byteStart: number
    byteEnd: number
    quote: string
  }
}

export interface VectorFixture {
  query: number[]
  chunks: Record<string, number[]>
  weight?: number
}

function open(root: string): DatabaseSync {
  const db = new DatabaseSync(projectPaths(root).indexDb)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_chunks (
      chunk_id TEXT PRIMARY KEY,
      chapter INTEGER NOT NULL,
      paragraph INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      entities TEXT NOT NULL,
      storyline TEXT NOT NULL,
      time_label TEXT NOT NULL,
      location TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      length INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_terms (
      term TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      tf INTEGER NOT NULL,
      PRIMARY KEY(term, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS search_terms_term ON search_terms(term);
    CREATE TABLE IF NOT EXISTS search_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mainline_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  try {
    db.exec("ALTER TABLE search_chunks ADD COLUMN time_label TEXT NOT NULL DEFAULT ''")
  } catch {
    // Existing index already has the column.
  }
  try {
    db.exec("ALTER TABLE search_chunks ADD COLUMN location TEXT NOT NULL DEFAULT ''")
  } catch {
    // Existing index already has the column.
  }
  return db
}

export async function rebuildSearchIndex(root: string): Promise<{ chunks: number; terms: number }> {
  const head = await readMainline(root)
  const db = open(root)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM search_terms; DELETE FROM search_chunks;')
    db.prepare(
      `INSERT INTO search_state (id, mainline_revision, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mainline_revision = excluded.mainline_revision, updated_at = excluded.updated_at`,
    ).run(head.mainlineRevision, new Date().toISOString())
    let chunkCount = 0
    let termCount = 0
    for (const [chapterText, commitId] of Object.entries(head.selectedCommitByChapter)) {
      const chapter = Number(chapterText)
      const commit = await readCommit(root, commitId)
      if (!commit) continue
      const text = await readTextIfExists(finalPath(root, chapter))
      if (!text) continue
      const contract = await loadContract(root, chapter).catch(() => null)
      const storyline = contract?.threads.join(',') ?? ''
      const paragraphs = paragraphsWithOffsets(text)
      for (const paragraph of paragraphs) {
        const chunkId = `ch-${chapter}-${String(paragraph.index).padStart(3, '0')}`
        const chapterEntities = [
          ...new Set([
            ...(commit.ledger?.events.flatMap(event => event.participants) ?? []),
            ...(commit.ledger?.facts.map(fact => fact.subject) ?? []),
            ...(commit.ledger?.loops?.flatMap(loop => loop.relatedEntities) ?? []),
          ]),
        ]
        const entities = chapterEntities.filter(name => paragraph.text.includes(name))
        const tokens = tokenize(paragraph.text)
        const tf = new Map<string, number>()
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
        db.prepare(
          `INSERT INTO search_chunks
            (chunk_id, chapter, paragraph, text, start_byte, end_byte, entities, storyline,
             time_label, location, source_commit, content_hash, length)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          chunkId,
          chapter,
          paragraph.index,
          paragraph.text,
          paragraph.startByte,
          paragraph.endByte,
          [...new Set(entities)].join(','),
          storyline,
          contract?.time ?? '',
          contract?.location ?? '',
          commitId,
          commit.contentHash,
          tokens.length,
        )
        for (const [term, count] of tf) {
          db.prepare('INSERT INTO search_terms (term, chunk_id, tf) VALUES (?, ?, ?)').run(term, chunkId, count)
          termCount += 1
        }
        chunkCount += 1
      }
    }
    db.exec('COMMIT')
    return { chunks: chunkCount, terms: termCount }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export async function searchBook(
  root: string,
  query: string,
  options: {
    chapter?: number
    entity?: string
    storyline?: string
    time?: string
    location?: string
    limit?: number
    vectors?: VectorFixture
  } = {},
): Promise<{ query: string; results: SearchResult[]; fallback: boolean; fusion: 'keyword' | 'rrf' }> {
  if (!query.trim()) throw conflictError('搜索词不能为空')
  const db = open(root)
  try {
    const head = await readMainline(root)
    const indexed = db.prepare('SELECT mainline_revision FROM search_state WHERE id = 1')
      .get() as Record<string, unknown> | undefined
    if (!indexed) throw conflictError('检索索引为空；请先执行 weave index rebuild')
    if (Number(indexed.mainline_revision) !== head.mainlineRevision) {
      throw conflictError('检索索引已落后于主线；请执行 weave index rebuild')
    }
    const total = db.prepare('SELECT COUNT(*) AS count FROM search_chunks').get() as Record<string, unknown> | undefined
    const totalDocs = Number(total?.count ?? 0)
    if (totalDocs === 0) throw conflictError('检索索引为空；请先执行 weave index rebuild')
    const filterChapter = options.chapter
    const filterEntity = options.entity
    const filterStoryline = options.storyline
    const matches = (row: Record<string, unknown>): boolean =>
      (filterChapter === undefined || Number(row.chapter) === filterChapter)
      && (!filterEntity || String(row.entities).split(',').includes(filterEntity))
      && (!filterStoryline || String(row.storyline).split(',').includes(filterStoryline))
      && (!options.time || String(row.time_label).includes(options.time))
      && (!options.location || String(row.location).includes(options.location))
    const queryTerms = tokenize(query)
    const fallback = query.length <= 1 || queryTerms.length === 0
    if (!fallback) {
      const rows = db.prepare('SELECT * FROM search_chunks').all() as Array<Record<string, unknown>>
      const filtered = rows.filter(matches)
      const df = new Map<string, number>()
      for (const term of queryTerms) {
        const count = db.prepare('SELECT COUNT(DISTINCT chunk_id) AS count FROM search_terms WHERE term = ?')
          .get(term) as Record<string, unknown> | undefined
        df.set(term, Number(count?.count ?? 0))
      }
      const avgLength = filtered.length === 0
        ? 0
        : filtered.reduce((sum, row) => sum + Number(row.length), 0) / filtered.length
      const scored = filtered.map(row => {
        let score = 0
        for (const term of queryTerms) {
          const tfRow = db.prepare('SELECT tf FROM search_terms WHERE term = ? AND chunk_id = ?')
            .get(term, String(row.chunk_id)) as Record<string, unknown> | undefined
          const tf = Number(tfRow?.tf ?? 0)
          if (tf === 0) continue
          const idf = Math.log(1 + (totalDocs - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
          score += idf * ((tf * 2.5) / (tf + 1.5 * (0.25 + 0.75 * Number(row.length) / (avgLength || 1))))
        }
        return { row, score }
      }).filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || Number(a.row.chapter) - Number(b.row.chapter) || Number(a.row.paragraph) - Number(b.row.paragraph))
        .slice(0, options.limit ?? 8)
      if (scored.length > 0) {
        const keywordResults = scored.map(item => toResult(item.row))
        const fused = options.vectors
          ? fuseVectors(db, keywordResults, options.vectors, options.limit ?? 8, matches)
          : null
        return {
          query,
          fallback: false,
          results: fused ?? keywordResults,
          fusion: fused ? 'rrf' : 'keyword',
        }
      }
    }
    const rows = db.prepare('SELECT * FROM search_chunks').all() as Array<Record<string, unknown>>
    const keywordResults = rows
      .filter(row =>
        String(row.text).includes(query)
        && matches(row),
      )
      .sort((a, b) => Number(a.chapter) - Number(b.chapter) || Number(a.paragraph) - Number(b.paragraph))
      .slice(0, options.limit ?? 8)
      .map(toResult)
    const fused = options.vectors
      ? fuseVectors(db, keywordResults, options.vectors, options.limit ?? 8, matches)
      : null
    return { query, fallback: true, results: fused ?? keywordResults, fusion: fused ? 'rrf' : 'keyword' }
  } finally {
    db.close()
  }
}

function fuseVectors(
  db: DatabaseSync,
  keywordResults: SearchResult[],
  vectors: VectorFixture,
  limit: number,
  matches: (row: Record<string, unknown>) => boolean,
): SearchResult[] | null {
  if (vectors.query.length === 0) return null
  const rows = (db.prepare('SELECT * FROM search_chunks').all() as Array<Record<string, unknown>>)
    .filter(matches)
  const scored = rows.map(row => {
    const chunkId = String(row.chunk_id)
    const vector = vectors.chunks[chunkId]
    if (!vector || vector.length !== vectors.query.length
      || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) return null
    const score = cosine(vectors.query, vector)
    return Number.isFinite(score) && score > 0 ? { row, score } : null
  }).filter((item): item is { row: Record<string, unknown>; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .map(item => toResult(item.row))
  if (scored.length === 0) return null
  return reciprocalRankFusion(keywordResults, scored, limit, vectors.weight ?? 1)
}

export function reciprocalRankFusion(
  keywordResults: SearchResult[],
  vectorResults: SearchResult[],
  limit = 8,
  weight = 1,
): SearchResult[] {
  const scores = new Map<string, number>()
  const byId = new Map<string, SearchResult>()
  for (const [index, result] of keywordResults.entries()) {
    scores.set(result.chunkId, (scores.get(result.chunkId) ?? 0) + 1 / (60 + index + 1))
    byId.set(result.chunkId, result)
  }
  for (const [index, result] of vectorResults.entries()) {
    scores.set(result.chunkId, (scores.get(result.chunkId) ?? 0) + weight / (60 + index + 1))
    byId.set(result.chunkId, result)
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([chunkId]) => byId.get(chunkId)!)
}

function cosine(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}

export async function readSearchChunk(
  root: string,
  chunkId: string,
): Promise<(SearchResult & { parentText: string }) | null> {
  const db = open(root)
  try {
    const row = db.prepare('SELECT * FROM search_chunks WHERE chunk_id = ?').get(chunkId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const chapter = Number(row.chapter)
    const parentText = (await readTextIfExists(finalPath(root, chapter))) ?? ''
    return { ...toResult(row), parentText }
  } finally {
    db.close()
  }
}

function toResult(row: Record<string, unknown>): SearchResult {
  const chapter = Number(row.chapter)
  const text = String(row.text)
  return {
    chunkId: String(row.chunk_id),
    chapter,
    paragraph: Number(row.paragraph),
    text,
    sourceCommit: String(row.source_commit),
    parentChunkId: `chapter:${chapter}`,
    evidence: {
      sourceContentHash: String(row.content_hash),
      byteStart: Number(row.start_byte),
      byteEnd: Number(row.end_byte),
      quote: text,
    },
  }
}

function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.push(run[index]!)
      if (index + 1 < run.length) tokens.push(run.slice(index, index + 2))
    }
  }
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) tokens.push(word)
  return tokens
}

function paragraphsWithOffsets(text: string): Array<{
  index: number
  text: string
  startByte: number
  endByte: number
}> {
  const result: Array<{ index: number; text: string; startByte: number; endByte: number }> = []
  const parts = text.split(/\n{2,}/)
  let cursor = 0
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) {
      const start = text.indexOf(trimmed, cursor)
      const startByte = Buffer.byteLength(text.slice(0, start), 'utf8')
      result.push({
        index: result.length + 1,
        text: trimmed,
        startByte,
        endByte: startByte + Buffer.byteLength(trimmed, 'utf8'),
      })
      cursor = start + trimmed.length
    }
  }
  return result
}
