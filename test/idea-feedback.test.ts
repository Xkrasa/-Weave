import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadContract, normalizeContract, saveContract } from '../src/core/contract.ts'
import { applyPromotion, captureIdea, promoteIdea, updateIdea } from '../src/core/ideas.ts'
import { assembleChapterContext } from '../src/core/materials.ts'
import { initProject } from '../src/core/project.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import type { ChapterContract } from '../src/core/types.ts'

function contract(overrides: Partial<ChapterContract> = {}): ChapterContract {
  return normalizeContract({
    chapter: 1,
    title: '雾港',
    pov: '林岚',
    time: '第 1 天',
    location: '海港',
    openingState: '林岚带着账本回到海港',
    endingState: '林岚发现缺页',
    goal: '找出账本缺页的原因',
    obstacle: '港务局不肯作证',
    mustHappen: ['林岚发现账本缺页'],
    mayHappen: [],
    mustNotHappen: ['杀死长老'],
    characters: ['林岚', '长老'],
    threads: ['账本主线'],
    targetWords: 1000,
    previousLink: '开篇',
    nextLink: '继续追查',
    ...overrides,
  })
}

async function project(options: { contract?: ChapterContract } = {}): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-idea-feedback-'))
  await initProject(dir, { title: '想法回灌', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
  await saveContract(dir, options.contract ?? contract())
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Each idea promotes to its own canon candidate, so earlier promotions stay active:
 * the shared `plan` target would change hash on every promotion and mark them stale.
 */
async function promoted(dir: string, id: string): Promise<string> {
  const proposal = await promoteIdea(dir, id, 'canon')
  await applyPromotion(dir, id, proposal)
  return proposal.targetPath
}

async function assemble(dir: string, options: { includeBookIdeas?: boolean } = {}) {
  // Use the persisted contract so the fixture's volume / chapter overrides survive the round trip.
  const saved = await loadContract(dir, 1)
  return assembleChapterContext(dir, saved, { includeBookIdeas: options.includeBookIdeas })
}

test('inbox ideas never enter context; promoted in-scope ideas do', async () => {
  const { dir, cleanup } = await project()
  try {
    const inbox = await captureIdea(dir, { body: '还没想清楚的一条灵感', scope: 'chapter:1' })
    let result = await assemble(dir)
    assert.equal(result.context?.included.some(item => item.sourceId === `idea:${inbox.id}`), false)

    await promoted(dir, inbox.id)
    result = await assemble(dir)
    const material = result.context?.included.find(item => item.sourceId === `idea:${inbox.id}`)
    assert.ok(material, 'promoted in-scope idea should be included')
    assert.equal(material.visibility, 'author-only')
    assert.equal(material.required, false)
    assert.match(material.text, /作者意图/)
    assert.match(material.text, /不是既成事实/)
    // The idea is labelled as author intent, not as finalized plot.
    assert.equal(material.category, 'author')
    assert.equal(material.provenance, 'author')
  } finally {
    await cleanup()
  }
})

test('scope matching uses chapter, volume, character and explicit book opt-in', async () => {
  const { dir, cleanup } = await project({ contract: contract({ volume: 2 }) })
  try {
    const current = await captureIdea(dir, { body: '当前章的想法', scope: 'chapter:1' })
    const otherChapter = await captureIdea(dir, { body: '别的章的想法', scope: 'chapter:2' })
    const volume = await captureIdea(dir, { body: '第二卷的想法', scope: 'volume:2' })
    const character = await captureIdea(dir, { body: '林岚的想法', scope: 'character:林岚' })
    const stranger = await captureIdea(dir, { body: '陌生人的想法', scope: 'character:陌生人' })
    const book = await captureIdea(dir, { body: '全书总纲', scope: 'book' })
    for (const idea of [current, otherChapter, volume, character, stranger, book]) await promoted(dir, idea.id)

    const scoped = await assemble(dir)
    const included = new Set(scoped.context!.included.map(item => item.sourceId))
    assert.ok(included.has(`idea:${current.id}`))
    assert.ok(included.has(`idea:${volume.id}`))
    assert.ok(included.has(`idea:${character.id}`))
    assert.equal(included.has(`idea:${otherChapter.id}`), false)
    assert.equal(included.has(`idea:${stranger.id}`), false)
    assert.equal(included.has(`idea:${book.id}`), false)

    const withBook = await assemble(dir, { includeBookIdeas: true })
    assert.ok(withBook.context!.included.some(item => item.sourceId === `idea:${book.id}`))
  } finally {
    await cleanup()
  }
})

test('reveal spoilers are withheld until the reveal chapter, then appear', async () => {
  const { dir, cleanup } = await project()
  try {
    const spoiler = await captureIdea(dir, {
      body: '长老其实是旧王的守墓人。',
      scope: 'character:长老',
      spoilerLevel: 'reveal',
      revealAfterChapter: 2,
    })
    await promoted(dir, spoiler.id)

    // Chapter 1 is before the reveal chapter: the idea is withheld, not silently dropped.
    const before = await assemble(dir)
    assert.equal(before.context!.included.some(item => item.sourceId === `idea:${spoiler.id}`), false)
    assert.deepEqual(before.context!.withheld, [{ sourceId: `idea:${spoiler.id}`, reason: 'idea-spoiler' }])

    // Dropping the reveal gate to the current chapter makes it eligible again.
    await updateIdea(dir, spoiler.id, { revealAfterChapter: 1 })
    const after = await assemble(dir)
    assert.ok(after.context!.included.some(item => item.sourceId === `idea:${spoiler.id}`))
    assert.equal(after.context!.withheld.some(item => item.sourceId === `idea:${spoiler.id}`), false)
  } finally {
    await cleanup()
  }
})

test('six-idea cap and 2000-token cap become omitted/degraded instead of silent drops', async () => {
  const { dir, cleanup } = await project()
  try {
    const ideas = []
    for (let index = 0; index < 7; index += 1) {
      const idea = await captureIdea(dir, {
        body: `普通想法 ${index}`,
        scope: 'chapter:1',
        priority: index === 6 ? 'low' : 'normal',
      })
      ideas.push(idea)
      await promoted(dir, idea.id)
    }
    const result = await assemble(dir)
    const included = result.context!.included.filter(item => item.sourceId.startsWith('idea:'))
    assert.equal(included.length, 6)
    const omitted = result.context!.omitted.filter(item => item.sourceId.startsWith('idea:'))
    assert.equal(omitted.length, 1)
    assert.equal(omitted[0]!.reason, 'budget')

    const big = await captureIdea(dir, {
      body: '很长的想法。'.repeat(900),
      scope: 'chapter:1',
      priority: 'high',
    })
    await promoted(dir, big.id)
    const withBig = await assemble(dir)
    const modes = withBig.context!.degraded.filter(item => item.sourceId === `idea:${big.id}`)
    assert.equal(modes.length, 1)
    const material = withBig.context!.included.find(item => item.sourceId === `idea:${big.id}`)
    assert.match(material!.text, /（想法，未展开）/)
  } finally {
    await cleanup()
  }
})

test('contract mustNotHappen wins and surfaces a conflict warning without deleting the idea', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '长老提议杀死长老来解决问题。', scope: 'chapter:1' })
    await promoted(dir, idea.id)
    const result = await assemble(dir)
    assert.ok(result.context!.included.some(item => item.sourceId === `idea:${idea.id}`))
    assert.ok(result.conflictWarnings.some(warning => warning.includes('杀死长老') && warning.includes('合同优先')))
  } finally {
    await cleanup()
  }
})

test('a stale promotion is excluded until the target is re-evaluated', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '会被改掉目标的想法', scope: 'chapter:1' })
    const targetPath = await promoted(dir, idea.id)
    const result = await assemble(dir)
    assert.ok(result.context!.included.some(item => item.sourceId === `idea:${idea.id}`))
    // Deleting the target makes the recorded hash unresolvable -> stale, so it is not injected.
    await rm(path.join(dir, targetPath))
    const stale = await assemble(dir)
    assert.equal(stale.context!.included.some(item => item.sourceId === `idea:${idea.id}`), false)
  } finally {
    await cleanup()
  }
})

test('/api/context/preview reports idea sources and withheld reasons', async () => {
  const { dir, cleanup } = await project()
  const server = await startUiServer(dir)
  try {
    const included = await captureIdea(dir, { body: '港口的第二座灯塔', scope: 'chapter:1' })
    await promoted(dir, included.id)
    const spoiler = await captureIdea(dir, {
      body: '灯塔下面藏着旧王墓',
      scope: 'chapter:1',
      spoilerLevel: 'reveal',
      revealAfterChapter: 9,
    })
    await promoted(dir, spoiler.id)

    const response = await fetch(`${server.url}/api/context/preview?chapter=1`)
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      context: { included: string[]; withheld: Array<{ sourceId: string; reason: string }> }
    }
    assert.ok(payload.context.included.includes(`idea:${included.id}`))
    assert.deepEqual(payload.context.withheld.find(item => item.sourceId === `idea:${spoiler.id}`), {
      sourceId: `idea:${spoiler.id}`,
      reason: 'idea-spoiler',
    })
  } finally {
    await server.close()
    await cleanup()
  }
})
