import path from 'node:path'
import { atomicWriteJson, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { readCommit, readMainline } from './ledger.ts'
import { loadContract } from './contract.ts'
import { collectLoopState } from './story-ledger.ts'

/**
 * Bounded, derived long-form memory. It is a locator, never a source of truth:
 * precise questions still resolve through the ledger, and nothing here may answer "what happened".
 */
export interface StoryMemory {
  schemaVersion: 1
  mainlineRevision: number
  throughChapter: number
  updatedAt: string
  /** Author-facing arc summary. Never injected into a limited POV prompt. */
  storySoFar: string
  /** Author-facing current-volume summary. */
  volume: string
  /** Per-POV summaries: only events this character participated in. */
  pov: Record<string, string>
}

const STORY_CAP = 1500
const VOLUME_CAP = 900
const POV_CAP = 700
const RECENT_VOLUME_CHAPTERS = 10
const RECENT_POV_CHAPTERS = 15

export function memoryPath(root: string): string {
  return path.join(projectPaths(root).metadata, 'memory.json')
}

export async function loadStoryMemory(root: string): Promise<StoryMemory | null> {
  return readJsonIfExists<StoryMemory>(memoryPath(root))
}

export async function ensureStoryMemory(root: string): Promise<StoryMemory> {
  const head = await readMainline(root)
  const existing = await loadStoryMemory(root)
  if (existing && existing.mainlineRevision === head.mainlineRevision) return existing
  const memory = await buildStoryMemory(root)
  await atomicWriteJson(memoryPath(root), memory)
  return memory
}

export async function buildStoryMemory(root: string): Promise<StoryMemory> {
  const head = await readMainline(root)
  const chapters = Object.keys(head.selectedCommitByChapter).map(Number).sort((a, b) => a - b)
  const rows: Array<{
    chapter: number
    title: string
    pov: string
    narrativeMode: 'limited' | 'omniscient'
    summaries: string[]
    participants: Set<string>
  }> = []
  for (const chapter of chapters) {
    const commitId = head.selectedCommitByChapter[String(chapter)]
    const commit = commitId ? await readCommit(root, commitId) : null
    if (!commit) continue
    const contract = await loadContract(root, chapter).catch(() => null)
    const events = commit.ledger?.events ?? []
    rows.push({
      chapter,
      title: contract?.title ?? '',
      pov: contract?.pov ?? '',
      narrativeMode: contract?.narrativeMode ?? 'limited',
      summaries: events.slice(-2).map(event => event.summary),
      participants: new Set(events.flatMap(event => event.participants)),
    })
  }

  const storyRows = rows.length <= 45
    ? rows
    : [...rows.slice(0, 5), ...rows.slice(-40)]
  const loops = await collectLoopState(root).catch(() => null)
  const openLoops = (loops?.loops ?? [])
    .filter(loop => loop.status !== 'paid_off' && loop.status !== 'abandoned')
    .slice(0, 5)

  const pov: Record<string, string> = {}
  const povCharacters = [...new Set(rows.map(row => row.pov).filter(Boolean))]
  for (const character of povCharacters) {
    const relevant = rows
      .filter(row => row.pov === character || row.participants.has(character))
      .slice(-RECENT_POV_CHAPTERS)
    // Limited POV may only see the planted prose it actually narrated. Loop summaries are
    // model-authored and can assert facts the POV never observed, so they stay out of pov memory.
    const observedLoops = openLoops
      .map(loop => ({ loop, row: rows.find(item => item.chapter === loop.plantedChapter) }))
      .filter(item => item.row
        && item.row.pov === character
        && item.row.narrativeMode !== 'omniscient'
        && item.loop.evidence.length > 0)
    const lines = [
      ...relevant.map(row => `第${row.chapter}章：${row.summaries.join('；') || row.title}`),
      ...(observedLoops.length > 0
        ? ['未解线索（原文）：', ...observedLoops.map(item =>
            `- 第${item.loop.plantedChapter}章：${(item.loop.evidence[0]?.quote ?? '').slice(0, 80)}（${item.loop.status}）`)]
        : []),
    ]
    pov[character] = cap(lines.join('\n'), POV_CAP)
  }

  return {
    schemaVersion: 1,
    mainlineRevision: head.mainlineRevision,
    throughChapter: Math.max(0, ...chapters),
    updatedAt: new Date().toISOString(),
    storySoFar: cap(renderStory(storyRows), STORY_CAP),
    volume: cap(
      [
        ...renderVolumeRows(rows.slice(-RECENT_VOLUME_CHAPTERS)),
        ...(openLoops.length > 0
          ? ['', '未回收伏笔：', ...openLoops.map(loop => `- ${loop.summary}（${loop.status}）`)]
          : []),
      ].join('\n'),
      VOLUME_CAP,
    ),
    pov,
  }
}

function renderStory(rows: Array<{ chapter: number; title: string; summaries: string[] }>): string {
  if (rows.length === 0) return ''
  const lines = rows.map(row =>
    `${String(row.chapter).padStart(3, '0')} ${row.title || '未命名'}：${row.summaries.join('；') || '（无事件记录）'}`,
  )
  return lines.join('\n')
}

function renderVolumeRows(rows: Array<{ chapter: number; title: string; summaries: string[] }>): string[] {
  return rows.map(row =>
    `第${row.chapter}章 ${row.title || ''}${row.summaries.length > 0 ? `：${row.summaries.join('；')}` : ''}`,
  )
}

function cap(text: string, limit: number): string {
  const characters = [...text]
  if (characters.length <= limit) return text
  return `${characters.slice(0, limit).join('')}…`
}

export function memoryIsCurrent(memory: StoryMemory | null, mainlineRevision: number): boolean {
  return Boolean(memory) && memory?.mainlineRevision === mainlineRevision
}

/** Bounded POV material gets the current scene first, then the most recent experience. */
export function povMemory(memory: StoryMemory, pov: string): string | undefined {
  const text = memory.pov[pov]
  return text?.trim() ? text : undefined
}
