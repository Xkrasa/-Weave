import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeContract, saveContract } from '../src/core/contract.ts'
import { captureIdea, promoteIdea, applyPromotion, archiveIdea, markIdeaUsed } from '../src/core/ideas.ts'
import { buildIdeaMap } from '../src/core/idea-map.ts'
import { appendMainline } from '../src/core/ledger.ts'
import { initProject } from '../src/core/project.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import type { ChapterContract } from '../src/core/types.ts'

function contract(chapter: number, volume: number): ChapterContract {
  return normalizeContract({
    chapter,
    volume,
    title: `第 ${chapter} 章`,
    pov: '林岚',
    time: '第 1 天',
    location: '海港',
    openingState: '林岚回到海港',
    endingState: '林岚继续追查',
    goal: '找出线索',
    obstacle: '港务局阻挠',
    mustHappen: [],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: [],
    targetWords: 1000,
    previousLink: '前情',
    nextLink: '后续',
  })
}

async function project(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-idea-map-'))
  await initProject(dir, { title: '想法地图', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
  await saveContract(dir, contract(1, 1))
  await saveContract(dir, contract(2, 2))
  await appendMainline(dir, { '1': 'sha256:one', '2': 'sha256:two' })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function promote(dir: string, id: string, target: 'plan' | 'contract' | 'canon' = 'canon'): Promise<void> {
  const proposal = await promoteIdea(dir, id, target)
  await applyPromotion(dir, id, proposal)
}

test('the map counts promoted/used/unused per volume and never guesses usage', async () => {
  const { dir, cleanup } = await project()
  try {
    const unused = await captureIdea(dir, {
      body: '高优先级但还没用过的想法',
      scope: 'chapter:1',
      priority: 'high',
    })
    await promote(dir, unused.id)

    const linked = await captureIdea(dir, {
      body: '明确链接到已定稿章节',
      scope: 'chapter:1',
      links: { chapters: [1] },
    })
    await promote(dir, linked.id)

    const volume = await captureIdea(dir, {
      body: '第二卷的高优先级想法',
      scope: 'volume:2',
      priority: 'high',
    })
    await promote(dir, volume.id)

    const character = await captureIdea(dir, {
      body: '林岚的收件箱想法',
      scope: 'character:林岚',
    })

    const contractIdea = await captureIdea(dir, { body: '第二章合同候选', scope: 'chapter:2' })
    await promote(dir, contractIdea.id, 'contract')

    const archived = await captureIdea(dir, { body: '归档的想法' })
    await archiveIdea(dir, archived.id)

    const map = await buildIdeaMap(dir)
    assert.deepEqual(map.totals, { inbox: 1, promoted: 4, archived: 1, stale: 0 })

    const first = map.byVolume.find(bucket => bucket.volume === 1)!
    assert.deepEqual(first, {
      volume: 1,
      promoted: 2,
      used: 1,
      unused: 1,
      stale: 0,
      highPriorityUnused: [{ id: unused.id, title: unused.title }],
    })

    const second = map.byVolume.find(bucket => bucket.volume === 2)!
    assert.equal(second.promoted, 2)
    assert.equal(second.used, 0)
    assert.equal(second.unused, 2)
    assert.deepEqual(second.highPriorityUnused, [{ id: volume.id, title: volume.title }])

    assert.deepEqual(map.byCharacter, [{ name: '林岚', ideaIds: [character.id] }])
    assert.equal(map.byCharacter.length, 1)
  } finally {
    await cleanup()
  }
})

test('an author usage mark turns unused into used without touching the promotion', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '手动标记为已使用', scope: 'chapter:1' })
    await promote(dir, idea.id)
    assert.equal((await buildIdeaMap(dir)).byVolume[0]!.used, 0)

    const marked = await markIdeaUsed(dir, idea.id, [1])
    assert.equal(marked.usage?.markedBy, 'author')
    assert.equal((await buildIdeaMap(dir)).byVolume[0]!.used, 1)
    assert.deepEqual((await buildIdeaMap(dir)).byVolume[0]!.highPriorityUnused, [])
  } finally {
    await cleanup()
  }
})

test('a changed promotion target reports stale and is not counted as unused coverage', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '目标会被手改', scope: 'chapter:1' })
    await promote(dir, idea.id)
    assert.equal((await buildIdeaMap(dir)).totals.stale, 0)

    const target = path.join(dir, 'canon', `${idea.id}.candidate.md`)
    await (await import('node:fs/promises')).writeFile(target, '作者手改候选\n')
    const map = await buildIdeaMap(dir)
    assert.equal(map.totals.stale, 1)
    assert.equal(map.totals.promoted, 0)
    assert.equal(map.byVolume[0]!.stale, 1)
  } finally {
    await cleanup()
  }
})

test('/api/ideas/map and the used endpoint expose the same counts', async () => {
  const { dir, cleanup } = await project()
  const server = await startUiServer(dir)
  try {
    const idea = await captureIdea(dir, { body: '接口测试想法', scope: 'chapter:1', priority: 'high' })
    await promote(dir, idea.id)

    const initial = await (await fetch(`${server.url}/api/ideas/map`)).json() as {
      totals: { promoted: number }
      byVolume: Array<{ volume: number; used: number; highPriorityUnused: Array<{ id: string }> }>
    }
    assert.equal(initial.totals.promoted, 1)
    assert.equal(initial.byVolume[0]!.used, 0)
    assert.equal(initial.byVolume[0]!.highPriorityUnused[0]!.id, idea.id)

    const headers = { 'x-weave-token': server.token, 'content-type': 'application/json' }
    const response = await fetch(`${server.url}/api/ideas/${idea.id}/used`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chapters: [1] }),
    })
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { idea: { usage: { chapters: number[] } } }).idea.usage.chapters[0], 1)

    const after = await (await fetch(`${server.url}/api/ideas/map`)).json() as {
      byVolume: Array<{ used: number; unused: number }>
    }
    assert.equal(after.byVolume[0]!.used, 1)
    assert.equal(after.byVolume[0]!.unused, 0)

    const unauthorized = await fetch(`${server.url}/api/ideas/${idea.id}/used`, { method: 'DELETE' })
    assert.equal(unauthorized.status, 401)
    const cleared = await fetch(`${server.url}/api/ideas/${idea.id}/used`, { method: 'DELETE', headers })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as { idea: { usage?: unknown } }).idea.usage, undefined)
  } finally {
    await server.close()
    await cleanup()
  }
})
