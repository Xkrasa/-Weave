import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyPromotion,
  archiveIdea,
  captureIdea,
  ideaBodyPath,
  ideaMetaPath,
  listIdeas,
  loadPromotionProposal,
  promoteIdea,
  readIdea,
  recordPromotion,
  savePromotionProposal,
  updateIdea,
} from '../src/core/ideas.ts'
import { initProject, projectPaths } from '../src/core/project.ts'
import { hashText } from '../src/core/hash.ts'
import { decidePending, listIdeaPromotionPendings } from '../src/core/pending.ts'
import { startUiServer } from '../src/core/ui-server.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')

async function project(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-ideas-'))
  await initProject(dir, { title: '想法', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

test('capture writes a JSON/Markdown pair and list/show read it back', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, {
      body: '# 长老在第三卷反目\n\n他其实一直在替旧王守墓。',
      tags: ['人物', '反转'],
      scope: { kind: 'volume', ref: 3 },
      priority: 'high',
      spoilerLevel: 'reveal',
      revealAfterChapter: 3,
    })
    assert.match(idea.id, /^idea-\d{8}-[0-9a-f]{6}$/)
    assert.equal(idea.title, '长老在第三卷反目')
    assert.equal(idea.status, 'inbox')
    assert.deepEqual(idea.scope, { kind: 'volume', ref: 3 })
    assert.equal(idea.priority, 'high')
    assert.equal(idea.promotionState, 'none')

    const files = await readdir(projectPaths(dir).ideas)
    assert.deepEqual(files.sort(), [`${idea.id}.json`, `${idea.id}.md`])

    const listed = await listIdeas(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.id, idea.id)

    const read = await readIdea(dir, idea.id)
    assert.equal(read.meta.title, '长老在第三卷反目')
    assert.match(read.body, /旧王守墓/)
  } finally {
    await cleanup()
  }
})

test('capture derives and truncates the title from the first non-empty body line', async () => {
  const { dir, cleanup } = await project()
  try {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分'
    const idea = await captureIdea(dir, { body: `\n\n- ${long}\n第二行` })
    assert.equal([...idea.title].length, 40)
    assert.ok(idea.title.startsWith('一二三四五'))
  } finally {
    await cleanup()
  }
})

test('invalid captures are rejected before any file is written', async () => {
  const { dir, cleanup } = await project()
  try {
    const before = (await readdir(projectPaths(dir).ideas)).length
    await assert.rejects(captureIdea(dir, { body: '   \n\t' }), /正文不能为空/)
    await assert.rejects(captureIdea(dir, { body: '一句话', scope: 'chapter:0' }), /正整数/)
    await assert.rejects(captureIdea(dir, { body: '一句话', scope: 'nope:1' }), /scope/)
    await assert.rejects(captureIdea(dir, { body: '一句话', priority: 'urgent' }), /priority/)
    await assert.rejects(captureIdea(dir, { body: '一句话', spoilerLevel: 'loud' }), /spoilerLevel/)
    await assert.rejects(captureIdea(dir, { body: '一句话', links: { chapters: [0] } }), /links\.chapters/)
    const after = (await readdir(projectPaths(dir).ideas)).length
    assert.equal(after, before)
  } finally {
    await cleanup()
  }
})

test('update edits metadata and body, and a hand-edited Markdown body stays authoritative', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '旧正文', tags: ['旧'] })
    const updated = await updateIdea(dir, idea.id, {
      title: '新标题',
      body: '新正文',
      tags: ['新', '新', ' '],
      scope: 'chapter:7',
      priority: 'low',
    })
    assert.equal(updated.title, '新标题')
    assert.deepEqual(updated.tags, ['新'])
    assert.deepEqual(updated.scope, { kind: 'chapter', ref: 7 })
    const stored = await readIdea(dir, idea.id)
    assert.equal(stored.body.trimEnd(), '新正文')

    await writeFile(ideaBodyPath(dir, idea.id), '# 手改标题\n作者在编辑器里改过的正文。\n')
    const handEdited = await readIdea(dir, idea.id)
    assert.match(handEdited.body, /作者在编辑器里改过的正文/)
    // Hand edits to the body do not silently rewrite metadata.
    assert.equal(handEdited.meta.title, '新标题')
    assert.equal(JSON.parse(await readFile(ideaMetaPath(dir, idea.id), 'utf8')).title, '新标题')
  } finally {
    await cleanup()
  }
})

test('archive keeps the files, hides the idea from the default list and shows it on demand', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '可以归档的灵感' })
    const archived = await archiveIdea(dir, idea.id)
    assert.equal(archived.status, 'archived')
    assert.deepEqual((await readdir(projectPaths(dir).ideas)).sort(), [`${idea.id}.json`, `${idea.id}.md`])
    assert.equal((await listIdeas(dir)).length, 0)
    assert.equal((await listIdeas(dir, { status: 'archived' })).length, 1)
    assert.equal((await archiveIdea(dir, idea.id)).status, 'archived')
  } finally {
    await cleanup()
  }
})

test('promotion state is derived from the current target hash and never auto-reapplies', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '晋升测试' })
    const target = path.join(dir, 'plans', 'story.md')
    await writeFile(target, '原始计划\n')
    const promoted = await recordPromotion(dir, idea.id, {
      target: 'plan',
      targetPath: 'plans/story.md',
      targetHash: hashText('原始计划\n'),
      promotedAt: new Date().toISOString(),
      approvedBy: 'author',
    })
    assert.equal(promoted.status, 'promoted')
    assert.equal((await listIdeas(dir))[0]!.promotionState, 'active')

    await writeFile(target, '目标被改过了\n')
    assert.equal((await listIdeas(dir))[0]!.promotionState, 'stale')
    // Stale is a read-time signal only: the idea stays promoted and the target is untouched.
    assert.equal((await readIdea(dir, idea.id)).meta.status, 'promoted')
    assert.equal(await readFile(target, 'utf8'), '目标被改过了\n')
  } finally {
    await cleanup()
  }
})

test('CLI add/list/show/edit/archive round-trips through ideas/', async () => {
  const { dir, cleanup } = await project()
  try {
    const add = await runCli(dir, [
      'idea', 'add', '长老在第三卷反目',
      '--tag', '人物', '--tag', '反转',
      '--scope', 'volume:3',
      '--priority', 'high',
      '--json',
    ])
    assert.equal(add.code, 0, add.stderr)
    const created = JSON.parse(add.stdout) as { idea: { id: string; title: string; tags: string[]; scope: unknown } }
    assert.equal(created.idea.title, '长老在第三卷反目')
    assert.deepEqual(created.idea.tags, ['人物', '反转'])
    assert.deepEqual(created.idea.scope, { kind: 'volume', ref: 3 })

    const list = await runCli(dir, ['idea', 'list', '--tag', '反转', '--json'])
    assert.equal(list.code, 0, list.stderr)
    assert.equal((JSON.parse(list.stdout) as { ideas: unknown[] }).ideas.length, 1)

    const show = await runCli(dir, ['idea', 'show', created.idea.id, '--json'])
    assert.equal(show.code, 0, show.stderr)
    assert.equal((JSON.parse(show.stdout) as { body: string }).body.trim(), '长老在第三卷反目')

    const edit = await runCli(dir, ['idea', 'edit', created.idea.id, '--title', '改过的标题', '--body', '新正文', '--json'])
    assert.equal(edit.code, 0, edit.stderr)
    assert.equal((JSON.parse(edit.stdout) as { idea: { title: string } }).idea.title, '改过的标题')

    const archived = await runCli(dir, ['idea', 'archive', created.idea.id, '--json'])
    assert.equal(archived.code, 0, archived.stderr)
    const hidden = await runCli(dir, ['idea', 'list', '--json'])
    assert.equal((JSON.parse(hidden.stdout) as { ideas: unknown[] }).ideas.length, 0)
    const visible = await runCli(dir, ['idea', 'list', '--status', 'archived', '--json'])
    assert.equal((JSON.parse(visible.stdout) as { ideas: unknown[] }).ideas.length, 1)

    const bad = await runCli(dir, ['idea', 'add', ''])
    assert.notEqual(bad.code, 0)
  } finally {
    await cleanup()
  }
})

test('API exposes capture/list/read/edit/archive and requires the session token for writes', async () => {
  const { dir, cleanup } = await project()
  const server = await startUiServer(dir)
  try {
    const headers = { 'x-weave-token': server.token, 'content-type': 'application/json' }
    const created = await fetch(`${server.url}/api/ideas`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: '港口的第二座灯塔', tags: ['地点'], scope: { kind: 'world' } }),
    })
    assert.equal(created.status, 200)
    const createdPayload = await created.json() as { idea: { id: string; title: string } }
    assert.equal(createdPayload.idea.title, '港口的第二座灯塔')

    const listed = await fetch(`${server.url}/api/ideas?status=inbox`)
    assert.equal(listed.status, 200)
    assert.equal((await listed.json() as { ideas: unknown[] }).ideas.length, 1)

    const shown = await fetch(`${server.url}/api/ideas/${createdPayload.idea.id}`)
    assert.equal(shown.status, 200)
    const shownPayload = await shown.json() as { idea: { id: string }; body: string }
    assert.match(shownPayload.body, /第二座灯塔/)

    const patched = await fetch(`${server.url}/api/ideas/${createdPayload.idea.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: '第二座灯塔', priority: 'high' }),
    })
    assert.equal(patched.status, 200)
    assert.equal((await patched.json() as { idea: { title: string; priority: string } }).idea.priority, 'high')

    const unauthorized = await fetch(`${server.url}/api/ideas/${createdPayload.idea.id}`, { method: 'DELETE' })
    assert.equal(unauthorized.status, 401)

    const archived = await fetch(`${server.url}/api/ideas/${createdPayload.idea.id}`, { method: 'DELETE', headers })
    assert.equal(archived.status, 200)
    assert.equal((await archived.json() as { idea: { status: string } }).idea.status, 'archived')
    assert.equal((await (await fetch(`${server.url}/api/ideas`)).json() as { ideas: unknown[] }).ideas.length, 0)
  } finally {
    await server.close()
    await cleanup()
  }
})

test('promote previews a diff without writing, and apply writes only a candidate', async () => {
  const { dir, cleanup } = await project()
  try {
    const official = path.join(projectPaths(dir).outlines, 'chapters', '003.json')
    await writeFile(official, `${JSON.stringify({
      chapter: 3,
      title: '守墓人',
      pov: '许舟',
      time: '夜',
      location: '旧王墓',
      openingState: '许舟发现墓门',
      endingState: '长老承认身份',
      goal: '确认长老的身份',
      mustHappen: [],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['许舟', '长老'],
      threads: ['旧王'],
      targetWords: 2000,
      previousLink: '开篇',
      nextLink: '继续',
    }, null, 2)}\n`)

    const idea = await captureIdea(dir, {
      body: '长老其实是旧王的守墓人。',
      scope: { kind: 'chapter', ref: 3 },
      tags: ['人物'],
    })
    const target = path.join(projectPaths(dir).plans, 'candidates', 'chapters', '003.json')
    const proposal = await promoteIdea(dir, idea.id, 'contract')
    assert.equal(proposal.target, 'contract')
    assert.match(proposal.targetPath, /plans\/candidates\/chapters\/003\.json/)
    assert.ok(proposal.diff.includes('+'))
    // The proposal is a preview only.
    await assert.rejects(readFile(target, 'utf8'), /ENOENT/)
    // The official chapter contract is never touched by promotion.
    const before = JSON.parse(await readFile(official, 'utf8')) as { goal: string }
    assert.equal(before.goal, '确认长老的身份')

    const loaded = await loadPromotionProposal(dir, idea.id)
    assert.equal(loaded?.currentHash, proposal.currentHash)

    const applied = await applyPromotion(dir, idea.id, proposal)
    assert.equal(applied.status, 'promoted')
    assert.equal(applied.promotion?.target, 'contract')
    assert.equal(applied.promotion?.approvedBy, 'author')
    assert.equal(applied.promotionState, 'active')
    const candidate = JSON.parse(await readFile(target, 'utf8')) as {
      status: string
      model: string
      contract: { goal: string; chapter: number }
    }
    assert.equal(candidate.status, 'draft')
    assert.equal(candidate.model, `idea:${idea.id}`)
    assert.equal(candidate.contract.chapter, 3)
    assert.match(candidate.contract.goal, /长老其实是旧王的守墓人/)
    const after = JSON.parse(await readFile(official, 'utf8')) as { goal: string }
    assert.equal(after.goal, '确认长老的身份', '正式合同在 outline apply 前保持不变')

    // Decisions are traceable in the shared pending log.
    const decisions = await readFile(path.join(projectPaths(dir).metadata, 'pending-decisions.log.jsonl'), 'utf8')
    assert.match(decisions, /idea-promote/)
    assert.match(decisions, new RegExp(idea.id))
    // Nothing under ledger/ was produced by the promotion.
    const ledgerFiles = (await readdir(projectPaths(dir).ledger, { recursive: true })).map(String)
    assert.equal(ledgerFiles.filter(file => file.includes('idea')).length, 0)
  } finally {
    await cleanup()
  }
})

test('changing the target after promotion marks it stale and blocks stale applies', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '灯塔在退潮时会熄灭。', scope: 'world' })
    const proposal = await promoteIdea(dir, idea.id, 'plan')
    assert.equal(proposal.targetPath, 'plans/rolling.json')
    await applyPromotion(dir, idea.id, proposal)
    assert.equal((await listIdeas(dir, { status: 'promoted' }))[0]!.promotionState, 'active')

    const planFile = path.join(dir, proposal.targetPath)
    const envelope = JSON.parse(await readFile(planFile, 'utf8')) as {
      status: string
      content: { chapters: Array<{ goal: string }> }
    }
    assert.equal(envelope.status, 'draft')
    assert.match(envelope.content.chapters[0]!.goal, /灯塔在退潮时会熄灭/)
    envelope.content.chapters[0]!.goal = '作者手改的计划草稿'
    await writeFile(planFile, `${JSON.stringify(envelope, null, 2)}\n`)

    assert.equal((await listIdeas(dir, { status: 'promoted' }))[0]!.promotionState, 'stale')
    const stale = await promoteIdea(dir, idea.id, 'plan')
    assert.notEqual(stale.currentHash, proposal.currentHash)
    await assert.rejects(applyPromotion(dir, idea.id, proposal), /目标已变化/)
  } finally {
    await cleanup()
  }
})

test('promise promotion appends to the volume plan draft and never approves it', async () => {
  const { dir, cleanup } = await project()
  try {
    const volumePlan = path.join(projectPaths(dir).plans, 'volumes', '002.json')
    await writeFile(volumePlan, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'volume',
      status: 'approved',
      provenance: 'author',
      contentHash: hashText('approved'),
      content: {
        volume: 2,
        title: '退潮',
        mainConflict: '灯塔熄灭',
        antagonistEscalation: '守塔人失控',
        protagonistChoice: '留下维修',
        climax: '风暴夜',
        irreversibleChange: '灯塔易主',
        threads: ['灯塔'],
        readerPromises: ['解释灯塔为何熄灭'],
      },
    }, null, 2)}\n`)

    const idea = await captureIdea(dir, { body: '灯塔在退潮时熄灭，是因为守塔人欠了债。', scope: { kind: 'volume', ref: 2 } })
    const proposal = await promoteIdea(dir, idea.id, 'promise')
    assert.equal(proposal.targetPath, 'plans/volumes/002.json')
    await applyPromotion(dir, idea.id, proposal)

    const saved = JSON.parse(await readFile(volumePlan, 'utf8')) as {
      status: string
      content: { readerPromises: string[] }
    }
    assert.equal(saved.status, 'draft')
    assert.equal(saved.content.readerPromises.includes('解释灯塔为何熄灭'), true)
    assert.equal(saved.content.readerPromises.includes('灯塔在退潮时熄灭，是因为守塔人欠了债。'), true)
  } finally {
    await cleanup()
  }
})

test('canon promotion can only write a .candidate.md and never the formal file', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '旧王的名字不可被说出。', scope: 'world' })
    const formal = path.join(projectPaths(dir).canon, 'world.md')
    await assert.rejects(
      promoteIdea(dir, idea.id, 'canon', { targetPath: 'canon/world.md' }),
      /candidate\.md/,
    )
    const proposal = await promoteIdea(dir, idea.id, 'canon')
    assert.match(proposal.targetPath, /\.candidate\.md$/)
    const formalBefore = await readFile(formal, 'utf8')
    await applyPromotion(dir, idea.id, proposal)
    assert.equal(await readFile(formal, 'utf8'), formalBefore)
    assert.match(await readFile(path.join(dir, proposal.targetPath), 'utf8'), /旧王的名字/)
  } finally {
    await cleanup()
  }
})

test('an idea promotion is an open pending until the author decides', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '灯塔在退潮时会熄灭。', scope: 'world' })
    await promoteIdea(dir, idea.id, 'plan')
    assert.deepEqual(
      (await listIdeaPromotionPendings(dir)).map(item => item.pendingId),
      [`idea-promotion-${idea.id}`],
    )

    const promoted = await decidePending(dir, 0, `idea-promotion-${idea.id}`, 'promote', '作者确认晋升')
    assert.equal(promoted.choice, 'promote')
    assert.equal((await listIdeas(dir, { status: 'promoted' })).length, 1)
    assert.equal((await listIdeaPromotionPendings(dir)).length, 0)

    const second = await captureIdea(dir, { body: '另一条暂不推进的想法', scope: 'world' })
    await promoteIdea(dir, second.id, 'plan')
    const dismissed = await decidePending(dir, 0, `idea-promotion-${second.id}`, 'dismiss', '暂不使用')
    assert.equal(dismissed.choice, 'dismiss')
    assert.equal((await listIdeas(dir)).find(item => item.id === second.id)!.status, 'inbox')
    assert.equal((await listIdeaPromotionPendings(dir)).length, 0)
  } finally {
    await cleanup()
  }
})

test('the pending API lists and decides idea promotions without a chapter', async () => {
  const { dir, cleanup } = await project()
  const server = await startUiServer(dir)
  try {
    const idea = await captureIdea(dir, { body: '灯塔在退潮时会熄灭。', scope: 'world' })
    await promoteIdea(dir, idea.id, 'plan')

    const listed = await (await fetch(`${server.url}/api/pending`)).json() as {
      pending: unknown[]
      ideaPromotions: Array<{ pendingId: string; ideaId: string }>
    }
    assert.deepEqual(listed.ideaPromotions.map(item => item.pendingId), [`idea-promotion-${idea.id}`])
    assert.equal(listed.pending.length, 0)

    const headers = { 'x-weave-token': server.token, 'content-type': 'application/json' }
    const unauthorized = await fetch(`${server.url}/api/pending/decide`, {
      method: 'POST',
      body: JSON.stringify({ pendingId: `idea-promotion-${idea.id}`, as: 'promote', reason: '作者确认' }),
    })
    assert.equal(unauthorized.status, 401)

    const decided = await fetch(`${server.url}/api/pending/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pendingId: `idea-promotion-${idea.id}`, as: 'promote', reason: '作者确认' }),
    })
    assert.equal(decided.status, 200)
    assert.equal(((await decided.json()) as { choice: string }).choice, 'promote')
    assert.equal((await (await fetch(`${server.url}/api/pending`)).json() as { ideaPromotions: unknown[] }).ideaPromotions.length, 0)

    const bad = await fetch(`${server.url}/api/pending/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pendingId: `idea-promotion-${idea.id}`, as: 'text', reason: '错误分支' }),
    })
    assert.equal(bad.status, 400)
  } finally {
    await server.close()
    await cleanup()
  }
})

test('ledger is rejected as a promotion target for every target kind', async () => {
  const { dir, cleanup } = await project()
  try {
    const idea = await captureIdea(dir, { body: '一条想写进账本的想法' })
    for (const target of ['plan', 'outline', 'canon', 'promise'] as const) {
      await assert.rejects(
        promoteIdea(dir, idea.id, target, { targetPath: 'ledger/facts.jsonl' }),
        /ledger/,
      )
    }
  } finally {
    await cleanup()
  }
})
