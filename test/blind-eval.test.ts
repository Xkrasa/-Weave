import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject } from '../src/core/project.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import {
  createEvalSession,
  evalReport,
  importEvalPairs,
  listEvalSessions,
  nextEvalPair,
  recordEvalScore,
} from '../src/core/blind-eval.ts'

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-eval-'))
  await initProject(dir, { title: '盲评测试', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1', workflowVersion: 2 })
  return dir
}

test('imported benchmark pairs keep mapping sealed until every pair is judged', async () => {
  const dir = await project()
  const pairsDir = path.join(dir, 'tmp-pairs')
  try {
    await mkdir(pairsDir, { recursive: true })
    await writeFile(path.join(pairsDir, 'pairs.json'), JSON.stringify([
      { pairId: 'seed-ch1', seed: 'seed', chapter: 1, left: '左边第一章。她推开门。', right: '右边第一章。雨下了很久。' },
      { pairId: 'seed-ch2', seed: 'seed', chapter: 2, left: '左边第二章。', right: '右边第二章。' },
    ]))
    await writeFile(path.join(pairsDir, 'mapping.json'), JSON.stringify({
      a: 'runs/json', b: 'runs/mission',
      entries: [{ pairId: 'seed-ch1', left: 'a', right: 'b' }, { pairId: 'seed-ch2', left: 'b', right: 'a' }],
    }))
    const summary = await importEvalPairs(dir, pairsDir, { sessionId: 'json-vs-mission' })
    assert.equal(summary.total, 2)
    assert.equal(summary.sealed, true)

    const first = await nextEvalPair(dir, 'json-vs-mission')
    assert.equal(first.pair?.pairId, 'seed-ch1')
    assert.equal(JSON.stringify(first).includes('runs/json'), false, 'next pair must not leak mapping')

    await assert.rejects(
      recordEvalScore(dir, 'json-vs-mission', { pairId: 'seed-ch1', winner: 'left', stopRight: '不存在的句子' }),
      /弃读点引文/,
    )
    await recordEvalScore(dir, 'json-vs-mission', { pairId: 'seed-ch1', winner: 'right', stopRight: '雨下了很久。' })
    // A re-judgement replaces the earlier one for the same reader.
    await recordEvalScore(dir, 'json-vs-mission', { pairId: 'seed-ch1', winner: 'left', stopRight: '雨下了很久。' })

    const partial = await evalReport(dir, 'json-vs-mission')
    assert.equal(partial.revealed, false)
    assert.equal(partial.wins, undefined)
    assert.equal(partial.scored, 1)

    await recordEvalScore(dir, 'json-vs-mission', { pairId: 'seed-ch2', winner: 'right' })
    assert.equal((await nextEvalPair(dir, 'json-vs-mission')).pair, null)
    const report = await evalReport(dir, 'json-vs-mission')
    assert.equal(report.complete, true)
    assert.equal(report.revealed, true)
    // ch1 left=a wins; ch2 right=a wins.
    assert.deepEqual(report.wins, { a: 2, b: 0 })
    assert.equal(report.winRateA, 1)
    assert.equal(report.stopPoints.b, 1)
    assert.equal((await listEvalSessions(dir))[0]?.scored, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('created sessions shuffle sides and reject unsafe ids', async () => {
  const dir = await project()
  try {
    await assert.rejects(
      createEvalSession(dir, { sessionId: '../escape', title: 'x', source: 'test', entries: [{ pairId: 'p', a: '甲', b: '乙' }] }),
      /会话 id/,
    )
    const entries = Array.from({ length: 24 }, (_, index) => ({ pairId: `p${index}`, a: `A${index}`, b: `B${index}` }))
    await createEvalSession(dir, { sessionId: 'shuffle', title: '洗牌', source: 'test', labels: { a: 'base', b: 'beat' }, entries })
    const lefts = new Set<string>()
    for (let index = 0; index < entries.length; index += 1) {
      const { pair } = await nextEvalPair(dir, 'shuffle')
      assert.ok(pair)
      lefts.add(pair.left.slice(0, 1))
      await recordEvalScore(dir, 'shuffle', { pairId: pair.pairId, winner: 'tie' })
    }
    assert.equal(lefts.size, 2, 'both strategies should appear on the left at least once')
    const report = await evalReport(dir, 'shuffle')
    assert.equal(report.ties, 24)
    assert.equal(report.winRateA, null)
    assert.deepEqual(report.labels, { a: 'base', b: 'beat' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('UI blind eval endpoints serve pairs, require the token to score, and seal results', async () => {
  const dir = await project()
  const ui = await startUiServer(dir)
  try {
    await createEvalSession(dir, {
      sessionId: 'ui-session', title: '界面盲评', source: 'test',
      entries: [{ pairId: 'only', a: '甲版正文。', b: '乙版正文。' }],
    })
    const list = await (await fetch(`${ui.url}/api/evals`)).json() as { sessions: Array<{ sessionId: string }> }
    assert.equal(list.sessions[0]?.sessionId, 'ui-session')
    const next = await (await fetch(`${ui.url}/api/evals/ui-session/next`)).json() as { pair: { pairId: string } }
    assert.equal(next.pair.pairId, 'only')

    const anonymous = await fetch(`${ui.url}/api/evals/ui-session/scores`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: 'only', winner: 'left' }),
    })
    assert.equal(anonymous.status, 401)

    const sealed = await (await fetch(`${ui.url}/api/evals/ui-session/report`)).json() as { revealed: boolean }
    assert.equal(sealed.revealed, false)

    const scored = await fetch(`${ui.url}/api/evals/ui-session/scores`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-weave-token': ui.token },
      body: JSON.stringify({ pairId: 'only', winner: 'left', note: '开头更快' }),
    })
    assert.equal(scored.status, 200)
    const report = await (await fetch(`${ui.url}/api/evals/ui-session/report`)).json() as { revealed: boolean; wins: { a: number; b: number } }
    assert.equal(report.revealed, true)
    assert.equal(report.wins.a + report.wins.b, 1)
  } finally {
    await ui.close()
    await rm(dir, { recursive: true, force: true })
  }
})
