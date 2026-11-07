import path from 'node:path'
import { normalizeContract } from './contract.ts'
import { listIdeas, type IdeaView } from './ideas.ts'
import { readJsonIfExists, listFiles } from './io.ts'
import { readMainline } from './ledger.ts'
import { projectPaths } from './project.ts'

export interface IdeaMapVolume {
  volume: number
  promoted: number
  used: number
  unused: number
  stale: number
  highPriorityUnused: Array<{ id: string; title: string }>
}

export interface IdeaCharacterGroup {
  name: string
  ideaIds: string[]
}

export interface IdeaTagGroup {
  tag: string
  ideaIds: string[]
}

export interface IdeaMap {
  totals: { inbox: number; promoted: number; archived: number; stale: number }
  byVolume: IdeaMapVolume[]
  byCharacter: IdeaCharacterGroup[]
  byTag: IdeaTagGroup[]
}

/**
 * Builds a read-only map. "Used" is deliberately conservative: only an author mark,
 * an explicitly linked finalized chapter, or a promoted contract that belongs to a
 * finalized chapter counts. Anything ambiguous stays unused.
 */
export async function buildIdeaMap(root: string): Promise<IdeaMap> {
  const active = await listIdeas(root)
  const archived = await listIdeas(root, { status: 'archived' })
  const all = [...active, ...archived]
  const finalized = await finalizedChapters(root)
  const chapterVolume = await chapterVolumeMap(root)

  const totals = {
    inbox: all.filter(idea => idea.status === 'inbox').length,
    promoted: all.filter(idea => idea.status === 'promoted' && idea.promotionState === 'active').length,
    archived: archived.length,
    stale: all.filter(idea => idea.promotionState === 'stale').length,
  }

  const volumes = new Map<number, IdeaMapVolume>()
  const ensureVolume = (volume: number): IdeaMapVolume => {
    const existing = volumes.get(volume)
    if (existing) return existing
    const created: IdeaMapVolume = {
      volume,
      promoted: 0,
      used: 0,
      unused: 0,
      stale: 0,
      highPriorityUnused: [],
    }
    volumes.set(volume, created)
    return created
  }
  for (const volume of new Set(chapterVolume.values())) ensureVolume(volume)

  for (const idea of all) {
    const volume = ideaVolume(idea, chapterVolume)
    const bucket = ensureVolume(volume)
    if (idea.promotionState === 'stale') {
      bucket.stale += 1
      continue
    }
    if (idea.status !== 'promoted') continue
    bucket.promoted += 1
    if (isUsed(idea, finalized)) {
      bucket.used += 1
    } else {
      bucket.unused += 1
      if (idea.priority === 'high') bucket.highPriorityUnused.push({ id: idea.id, title: idea.title })
    }
  }

  const byCharacter = groupBy(all, idea => (idea.scope.kind === 'character' ? idea.scope.ref : null))
  const byTag = groupBy(all, idea => (idea.tags.length > 0 ? idea.tags : null))

  return {
    totals,
    byVolume: [...volumes.values()].sort((left, right) => left.volume - right.volume),
    byCharacter: [...byCharacter.entries()]
      .map(([name, ideaIds]) => ({ name, ideaIds }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    byTag: [...byTag.entries()]
      .map(([tag, ideaIds]) => ({ tag, ideaIds }))
      .sort((left, right) => right.ideaIds.length - left.ideaIds.length || left.tag.localeCompare(right.tag)),
  }
}

function isUsed(idea: IdeaView, finalized: Set<number>): boolean {
  if (idea.usage) return true
  // Only an explicit author mark or a finalized chapter link counts. A promotion target
  // (outline candidate / draft plan) is never proof that the idea reached the mainline.
  return idea.links.chapters.some(chapter => finalized.has(chapter))
}

function ideaVolume(idea: IdeaView, chapterVolume: Map<number, number>): number {
  const scope = idea.scope
  if (scope.kind === 'volume') return scope.ref
  if (scope.kind === 'chapter') return chapterVolume.get(scope.ref) ?? 0
  const linked = idea.usage?.chapters ?? idea.links.chapters
  const linkedVolumes = new Set(linked.map(chapter => chapterVolume.get(chapter)).filter((value): value is number => value !== undefined))
  if (linkedVolumes.size === 1) return [...linkedVolumes][0]!
  return 0
}

async function finalizedChapters(root: string): Promise<Set<number>> {
  const head = await readMainline(root)
  const chapters = new Set<number>()
  for (const raw of Object.keys(head.selectedCommitByChapter)) {
    const chapter = Number(raw)
    if (Number.isSafeInteger(chapter) && chapter > 0) chapters.add(chapter)
  }
  return chapters
}

async function chapterVolumeMap(root: string): Promise<Map<number, number>> {
  const dir = path.join(projectPaths(root).outlines, 'chapters')
  const map = new Map<number, number>()
  for (const file of await listFiles(dir)) {
    if (!file.endsWith('.json') || file.includes('.idea-')) continue
    const stem = Number(file.slice(0, -'.json'.length))
    if (!Number.isSafeInteger(stem) || stem <= 0) continue
    const raw = await readJsonIfExists<unknown>(path.join(dir, file))
    if (!raw) continue
    try {
      const contract = normalizeContract(raw)
      if (contract.volume !== undefined) map.set(contract.chapter, contract.volume)
    } catch {
      // An unreadable contract does not block the map; that chapter simply has no volume.
    }
  }
  return map
}

function groupBy(ideas: IdeaView[], keys: (idea: IdeaView) => string | string[] | null): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const idea of ideas) {
    const value = keys(idea)
    if (value === null) continue
    for (const key of Array.isArray(value) ? value : [value]) {
      const bucket = groups.get(key) ?? []
      bucket.push(idea.id)
      groups.set(key, bucket)
    }
  }
  return groups
}
