import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject, loadModelConfig } from '../src/core/project.ts'
import { normalizeContract, saveContract, writeContractCheck } from '../src/core/contract.ts'
import { saveDraft } from '../src/core/runs.ts'
import { draftHash } from '../src/core/stages.ts'
import {
  discardSelectionRevision,
  mergeRevision,
  reviseSelection,
  type SelectionRevisionCandidate,
} from '../src/core/revisions.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import type { ChapterContract } from '../src/core/types.ts'

function contract(): ChapterContract {
  return {
    chapter: 1,
    title: '退单',
    pov: '许舟',
    time: '午高峰',
    location: '站点',
    openingState: '许舟收到罚单',
    endingState: '罚单被撤销',
    goal: '撤销错误罚单',
    obstacle: '平台记录不一致',
    mustHappen: ['许舟核对订单'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['许舟'],
    threads: ['异常退款'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
    readerIntent: { purpose: 'release', payoff: '读者看到错误罚单被撤销' },
  }
}

class FakeModel {
  baseUrl = ''
  readonly requests: Array<Record<string, unknown>> = []
  private server: Server
  private texts: string[]
  constructor(texts: string[]) {
    this.texts = [...texts]
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        this.requests.push(JSON.parse(body) as Record<string, unknown>)
        const text = this.texts.shift() ?? JSON.stringify({ text: '修正后的文字' })
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
  }
  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    assert.ok(address && typeof address === 'object')
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
}

async function project(model: FakeModel): Promise<{ dir: string; draft: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-selection-'))
  await initProject(dir, { title: '划词测试', model: 'fake', baseUrl: model.baseUrl, workflowVersion: 2 })
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '许舟', status: 'alive', introducedIn: 1 }] })}\n`)
  await saveContract(dir, normalizeContract(contract()))
  await writeContractCheck(dir, normalizeContract(contract()))
  const draft = '许舟收到罚单。\n\n邱岳拒绝复核。'
  await saveDraft(dir, 1, draft)
  return { dir, draft }
}

test('selection merge replaces only the authorized occurrence and records discard', async () => {
  const model = new FakeModel([
    JSON.stringify({ text: '错误扣款' }),
    JSON.stringify({ text: '小罗核对订单' }),
  ])
  await model.start()
  const { dir, draft } = await project(model)
  try {
    const config = await loadModelConfig(dir)
    const first = await reviseSelection(dir, 1, {
      baseDraftHash: draftHash(draft), selectedText: '罚单', operation: 'polish',
    }, config, new AbortController().signal)
    assert.equal(first.selection.replacement, '错误扣款')
    const merged = await mergeRevision(dir, 1, first.revisionId)
    assert.equal(merged.status, 'merged')
    const text = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.equal(text, '许舟收到错误扣款。\n\n邱岳拒绝复核。')
    assert.ok('durationMs' in merged)

    const second = await reviseSelection(dir, 1, {
      baseDraftHash: draftHash(text), selectedText: '许舟', operation: 'custom', instruction: '改为小罗主动核对订单',
    }, config, new AbortController().signal)
    const discarded = await discardSelectionRevision(dir, 1, second.revisionId)
    assert.equal(discarded.status, 'discarded')
    assert.equal(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), text)
    assert.equal((await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')).includes('小罗核对订单'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('selection rejects ambiguous, stale and out-of-scope edits without overwriting prose', async () => {
  const model = new FakeModel([
    JSON.stringify({ text: '修正后的文字' }),
    JSON.stringify({ text: '许舟收到罚单。\n\n邱岳拒绝复核。' }),
  ])
  await model.start()
  const { dir, draft } = await project(model)
  try {
    const config = await loadModelConfig(dir)
    await assert.rejects(reviseSelection(dir, 1, {
      baseDraftHash: draftHash(draft), selectedText: '  ', operation: 'polish',
    }, config, new AbortController().signal), /不能为空/)
    await assert.rejects(reviseSelection(dir, 1, {
      baseDraftHash: draftHash(draft), selectedText: '许舟', operation: 'custom', instruction: '',
    }, config, new AbortController().signal), /修改要求/)

    await saveDraft(dir, 1, '罚单与罚单同时出现。')
    await assert.rejects(reviseSelection(dir, 1, {
      baseDraftHash: draftHash('罚单与罚单同时出现。'), selectedText: '罚单', operation: 'polish',
    }, config, new AbortController().signal), /重复出现/)

    const candidate = await reviseSelection(dir, 1, {
      baseDraftHash: draftHash('罚单与罚单同时出现。'), selectedText: '罚单', occurrence: 2, operation: 'polish',
    }, config, new AbortController().signal)
    await saveDraft(dir, 1, '作者已经改成另一段。')
    const conflict = await mergeRevision(dir, 1, candidate.revisionId)
    assert.equal(conflict.status, 'conflict')
    assert.equal(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), '作者已经改成另一段。')

    await assert.rejects(reviseSelection(dir, 1, {
      baseDraftHash: draftHash('作者已经改成另一段。'), selectedText: '另一段', operation: 'expand',
    }, config, new AbortController().signal), /多段文字/)
    assert.equal(model.requests.length, 2, 'invalid custom request must fail before the model')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('selection HTTP API requires token and returns scoped candidates', async () => {
  const model = new FakeModel([JSON.stringify({ text: '小罗' })])
  await model.start()
  const { dir, draft } = await project(model)
  const ui = await startUiServer(dir)
  try {
    const body = {
      baseDraftHash: draftHash(draft), selectedText: '许舟', occurrence: 1, operation: 'correct',
    }
    const unauthorized = await fetch(`${ui.url}/api/chapters/1/selection-revisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(unauthorized.status, 401)

    const created = await fetch(`${ui.url}/api/chapters/1/selection-revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-weave-token': ui.token },
      body: JSON.stringify(body),
    })
    assert.equal(created.status, 200)
    const payload = await created.json() as { candidate: SelectionRevisionCandidate }
    assert.equal(payload.candidate.selection.replacement, '小罗')
    const merged = await fetch(`${ui.url}/api/chapters/1/merge`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-weave-token': ui.token },
      body: JSON.stringify({ revisionId: payload.candidate.revisionId }),
    })
    assert.equal(merged.status, 200)
    const report = await merged.json() as { status: string }
    assert.equal(report.status, 'merged')
    assert.equal(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), '小罗收到罚单。\n\n邱岳拒绝复核。')

    const stale = await fetch(`${ui.url}/api/chapters/1/selection-revisions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-weave-token': ui.token },
      body: JSON.stringify({ ...body, baseDraftHash: 'stale' }),
    })
    assert.equal(stale.status, 409)
  } finally {
    await ui.close()
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
