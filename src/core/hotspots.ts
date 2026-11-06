import path from 'node:path'
import { atomicWriteJson, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { objectHash } from './hash.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'

export interface HotspotEntry {
  rank?: number
  title: string
  author?: string
  genre?: string
  tags: string[]
  status?: string
  wordCount?: number
  metricValue?: number
  metricText?: string
  url?: string
}

export interface HotspotSnapshot {
  schemaVersion: 1
  snapshotId: string
  platform: 'fanqie'
  capturedAt: string
  importedAt: string
  source: { type: 'csv' | 'markdown'; name: string }
  scope: {
    ranking: string
    channel: string
    filters: Record<string, string>
    metricName: string
    sampling: string
  }
  entries: HotspotEntry[]
  dataQuality: { warnings: string[]; skippedRows: number }
}

export interface TopicCandidate {
  candidateId: string
  kind: 'genre' | 'tag'
  value: string
  sampleCount: number
  titles: string[]
  status: 'suggested'
  note: string
}

function snapshotsDir(root: string): string {
  return path.join(projectPaths(root).references, 'hotspots')
}

export async function importHotspot(
  root: string,
  file: string,
  options: {
    capturedAt: string
    ranking: string
    channel?: string
    metricName?: string
    filters?: Record<string, string>
    sampling?: string
    snapshotId?: string
  },
): Promise<HotspotSnapshot> {
  const source = path.resolve(file)
  const text = await readTextIfExists(source)
  if (!text) throw validationError(`热点文件不存在或为空：${source}`)
  if (!/^\d{4}-\d{2}-\d{2}/.test(options.capturedAt)) throw validationError('capturedAt 必须是 YYYY-MM-DD 或 ISO 日期时间')
  if (!options.ranking.trim()) throw validationError('榜单名称不能为空')
  const type = path.extname(source).toLowerCase() === '.csv' ? 'csv' : 'markdown'
  const parsed = type === 'csv' ? parseCsv(text) : parseMarkdown(text)
  if (parsed.entries.length === 0) throw validationError('热点文件没有可识别的作品条目')
  const snapshotId = options.snapshotId ?? `fanqie-${options.capturedAt.slice(0, 10).replace(/-/g, '')}-${objectHash({ source, capturedAt: options.capturedAt, text }).slice(7, 15)}`
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(snapshotId)) throw validationError('snapshotId 只能包含字母、数字、- 和 _')
  const target = path.join(snapshotsDir(root), `${snapshotId}.json`)
  if (await readJsonIfExists(target)) throw conflictError(`热点快照 ${snapshotId} 已存在，不会覆盖`)
  const snapshot: HotspotSnapshot = {
    schemaVersion: 1,
    snapshotId,
    platform: 'fanqie',
    capturedAt: options.capturedAt,
    importedAt: new Date().toISOString(),
    source: { type, name: path.basename(source) },
    scope: {
      ranking: options.ranking.trim(),
      channel: options.channel ?? 'all',
      filters: options.filters ?? {},
      metricName: options.metricName ?? '在读',
      sampling: options.sampling ?? '作者提供样本，采样方式未完全说明',
    },
    entries: parsed.entries,
    dataQuality: parsed.dataQuality,
  }
  await atomicWriteJson(target, snapshot)
  return snapshot
}

export async function listHotspots(root: string): Promise<Array<Omit<HotspotSnapshot, 'entries'> & { entryCount: number }>> {
  const snapshots: Array<Omit<HotspotSnapshot, 'entries'> & { entryCount: number }> = []
  for (const name of await listFiles(snapshotsDir(root))) {
    if (!name.endsWith('.json')) continue
    const snapshot = await readJsonIfExists<HotspotSnapshot>(path.join(snapshotsDir(root), name))
    if (!snapshot) continue
    const { entries, ...metadata } = snapshot
    snapshots.push({ ...metadata, entryCount: entries.length })
  }
  return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
}

export async function readHotspot(root: string, snapshotId: string): Promise<HotspotSnapshot> {
  const snapshot = await readJsonIfExists<HotspotSnapshot>(path.join(snapshotsDir(root), `${snapshotId}.json`))
  if (!snapshot) throw validationError(`未知热点快照：${snapshotId}`)
  return snapshot
}

export async function compareHotspots(root: string, previousId: string, currentId: string): Promise<{
  previousSnapshotId: string
  currentSnapshotId: string
  previousMedian: number | null
  currentMedian: number | null
  added: HotspotEntry[]
  removed: HotspotEntry[]
  changed: Array<{ title: string; author?: string; previous?: number; current?: number; delta?: number }>
  notes: string[]
}> {
  const [previous, current] = await Promise.all([readHotspot(root, previousId), readHotspot(root, currentId)])
  if (signature(previous) !== signature(current)) {
    throw validationError('只有平台、榜单、频道、筛选和指标口径完全相同的快照才能比较')
  }
  const key = (entry: HotspotEntry): string => `${entry.title}\u0000${entry.author ?? ''}`
  const before = new Map(previous.entries.map(entry => [key(entry), entry]))
  const after = new Map(current.entries.map(entry => [key(entry), entry]))
  const added = current.entries.filter(entry => !before.has(key(entry)))
  const removed = previous.entries.filter(entry => !after.has(key(entry)))
  const changed: Array<{ title: string; author?: string; previous?: number; current?: number; delta?: number }> = []
  for (const entry of current.entries) {
    const old = before.get(key(entry))
    if (!old) continue
    if (old.metricValue === undefined || entry.metricValue === undefined || old.metricValue === entry.metricValue) continue
    changed.push({
      title: entry.title,
      ...(entry.author ? { author: entry.author } : {}),
      previous: old.metricValue,
      current: entry.metricValue,
      delta: entry.metricValue - old.metricValue,
    })
  }
  changed.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.title.localeCompare(b.title))
  return {
    previousSnapshotId: previousId,
    currentSnapshotId: currentId,
    previousMedian: median(previous.entries.map(entry => entry.metricValue).filter((value): value is number => value !== undefined)),
    currentMedian: median(current.entries.map(entry => entry.metricValue).filter((value): value is number => value !== undefined)),
    added,
    removed,
    changed,
    notes: [
      '中位数只描述当前导入样本，不代表平台题材份额或完读率。',
      '新增、移除和数值变化可能来自榜单范围或采样变化；原始数据质量警告必须一并阅读。',
    ],
  }
}

export async function topicCandidates(root: string, snapshotId: string): Promise<TopicCandidate[]> {
  const snapshot = await readHotspot(root, snapshotId)
  const groups = new Map<string, { kind: 'genre' | 'tag'; titles: Set<string> }>()
  for (const entry of snapshot.entries) {
    const values = [
      ...(entry.genre ? [{ kind: 'genre' as const, value: entry.genre }] : []),
      ...entry.tags.map(value => ({ kind: 'tag' as const, value })),
    ]
    for (const { kind, value } of values) {
      if (!value.trim()) continue
      const key = `${kind}\u0000${value}`
      const group = groups.get(key) ?? { kind, titles: new Set<string>() }
      group.titles.add(entry.title)
      groups.set(key, group)
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const [kind, value] = key.split('\u0000') as ['genre' | 'tag', string]
    const titles = [...group.titles].sort()
    return {
      candidateId: `topic-${objectHash({ snapshotId, kind, value }).slice(7, 23)}`,
      kind,
      value,
      sampleCount: titles.length,
      titles,
      status: 'suggested' as const,
      note: '仅为本快照中的重复样本，不代表平台份额；作者确认前不进入故事规划。',
    }
  }).filter(candidate => candidate.sampleCount > 1)
    .sort((a, b) => b.sampleCount - a.sampleCount || a.value.localeCompare(b.value))
}

function signature(snapshot: HotspotSnapshot): string {
  return objectHash({
    platform: snapshot.platform,
    ranking: snapshot.scope.ranking,
    channel: snapshot.scope.channel,
    filters: snapshot.scope.filters,
    metricName: snapshot.scope.metricName,
  })
}

function parseCsv(text: string): { entries: HotspotEntry[]; dataQuality: HotspotSnapshot['dataQuality'] } {
  const rows = csvRows(text)
  if (rows.length === 0) return { entries: [], dataQuality: { warnings: ['CSV 为空'], skippedRows: 0 } }
  const aliases: Record<string, string> = {
    rank: 'rank', 排名: 'rank', title: 'title', 书名: 'title', author: 'author', 作者: 'author',
    genre: 'genre', 题材: 'genre', tags: 'tags', 标签: 'tags', status: 'status', 状态: 'status',
    wordCount: 'wordCount', 字数: 'wordCount', metricValue: 'metricValue', metric: 'metricValue', 在读: 'metricValue',
    url: 'url', 链接: 'url',
  }
  const headers = rows[0]!.map(header => header.trim())
  const warnings: string[] = []
  const entries: HotspotEntry[] = []
  let skippedRows = 0
  for (const header of headers) {
    if (!aliases[header]) warnings.push(`未知列：${header}`)
  }
  for (const row of rows.slice(1)) {
    if (row.every(cell => !cell.trim())) continue
    const record = Object.fromEntries(headers.map((header, index) => [aliases[header] ?? header, row[index]?.trim() ?? '']))
    if (!record.title) {
      skippedRows += 1
      warnings.push(`第 ${entries.length + skippedRows + 1} 条数据缺少书名，已跳过`)
      continue
    }
    const entry: HotspotEntry = {
      title: record.title,
      tags: splitTags(record.tags),
      ...(record.rank ? { rank: Number(record.rank.replace(/^#/, '')) || undefined } : {}),
      ...(record.author ? { author: record.author } : {}),
      ...(record.genre ? { genre: record.genre } : {}),
      ...(record.status ? { status: record.status } : {}),
      ...(record.wordCount ? { wordCount: parseNumber(record.wordCount) } : {}),
      ...(record.metricValue ? { metricValue: parseNumber(record.metricValue), metricText: record.metricValue } : {}),
      ...(record.url ? { url: record.url } : {}),
    }
    if (record.metricValue && entry.metricValue === undefined) warnings.push(`《${entry.title}》热度无法解析：${record.metricValue}`)
    entries.push(entry)
  }
  return { entries, dataQuality: { warnings, skippedRows } }
}

function parseMarkdown(text: string): { entries: HotspotEntry[]; dataQuality: HotspotSnapshot['dataQuality'] } {
  const lines = text.split(/\r?\n/)
  const entries: HotspotEntry[] = []
  const warnings: string[] = []
  let skippedRows = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s+#(\d+)\s+(.+)$/.exec(lines[index]!.trim())
    if (!match) continue
    const title = match[2]!.trim()
    const details: string[] = []
    for (let cursor = index + 1; cursor < lines.length && !/^###\s+/.test(lines[cursor]!); cursor += 1) {
      if (lines[cursor]!.trim()) details.push(lines[cursor]!.trim())
      index = cursor
    }
    const metadata = details.find(line => line.includes('·'))
    const parts = metadata?.replace(/^\*+|\*+$/g, '').split('·').map(part => part.trim()) ?? []
    const tagsText = details.join(' ').match(/标签：\*+\s*([^*]+)/)?.[1]
    const metricText = parts.find(part => /[\d.]/.test(part) && !/万字$/.test(part) && !/^(?:连载中|已完结)$/.test(part))
    entries.push({
      rank: Number(match[1]),
      title,
      ...(parts[0] ? { author: parts[0] } : {}),
      ...(parts[1] ? { genre: parts[1] } : {}),
      ...(parts[2] ? { status: parts[2] } : {}),
      ...(parts[3] ? { wordCount: parseNumber(parts[3]) } : {}),
      ...(metricText ? { metricValue: parseNumber(metricText), metricText } : {}),
      tags: splitTags(tagsText),
    })
    if (!metadata) {
      skippedRows += 1
      warnings.push(`《${title}》缺少作者、题材或热度元信息`)
    }
  }
  return { entries, dataQuality: { warnings, skippedRows } }
}

function splitTags(value?: string): string[] {
  return (value ?? '').split(/[+、/|]/).map(item => item.trim()).filter(Boolean)
}

function parseNumber(value: string): number | undefined {
  const match = /([\d.]+)\s*(万|千)?/.exec(value.replace(/,/g, ''))
  if (!match) return undefined
  const number = Number(match[1])
  if (!Number.isFinite(number)) return undefined
  return Math.round(number * (match[2] === '万' ? 10000 : match[2] === '千' ? 1000 : 1))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      cell = ''
      if (row.some(value => value.trim())) rows.push(row)
      row = []
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some(value => value.trim())) rows.push(row)
  return rows
}
