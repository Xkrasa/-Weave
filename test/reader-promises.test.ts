import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readerPromiseFindings } from '../src/core/reader-promises.ts'
import { collectLoopState } from '../src/core/story-ledger.ts'

const CLI = path.resolve('src/cli.ts')
interface Result { code: number; stdout: string; stderr: string }

function runCli(cwd: string, args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function json<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, stdout)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

class FakeModel {
  baseUrl = ''
  private server: Server
  private readonly responseText: string
  constructor(responseText: string) {
    this.responseText = responseText
    this.server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: this.responseText } }] })}\n\n`)
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

async function contract(dir: string, withPromise = true, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }] })}\n`)
  await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
    chapter: 1,
    title: '换页',
    pov: '林岚',
    time: '第一日',
    location: '档案室',
    openingState: '林岚发现编号不符',
    endingState: '她确认有人换页',
    goal: '查明缺页去向',
    obstacle: '原始编号被涂改',
    mustHappen: ['林岚确认有人换页'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: ['账本'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
    ...(withPromise ? {
      readerIntent: {
        purpose: 'reveal',
        payoff: '读者知道谁换过账页',
        promiseIds: ['rp-ledger'],
        payoffPromiseIds: ['rp-ledger'],
      },
    } : {}),
    ...overrides,
  }, null, 2)}\n`)
}

async function finalize(dir: string, text: string): Promise<void> {
  await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), `${text}\n`)
  const result = await runCli(dir, ['finalize', '1', '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
}

test('ReaderPromise approval, evidence, extraction candidates and amendment stay separate from OpenLoop', async () => {
  const candidateText = JSON.stringify({
    candidates: [{ promiseId: 'rp-ledger', action: 'payoff', quote: '林岚确认有人换过账页', occurrence: 1 }],
  })
  const model = new FakeModel(candidateText)
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-reader-promise-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '承诺测试', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code, 0)
    await contract(dir)
    const promiseFile = path.join(dir, 'promise-input.json')
    await writeFile(promiseFile, `${JSON.stringify({ promises: [{
      promiseId: 'rp-ledger',
      description: '读者知道谁换过账页',
      status: 'active',
      targetToChapter: 1,
      relatedLoopIds: [],
    }] }, null, 2)}\n`)

    type PromiseList = {
      bookStatus: string
      promises: Array<{
        effectiveStatus: string
        advanceCount: number
        stalePayoff: boolean
        payoff?: { evidence: { quote: string } }
      }>
    }
    assert.equal((await runCli(dir, ['promise', 'set', '--file', promiseFile, '--json'])).code, 0)
    let listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.bookStatus, 'draft')
    assert.equal(listed.promises.length, 0)
    assert.equal((await runCli(dir, ['promise', 'approve', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    await finalize(dir, '林岚确认有人换过账页。')

    listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.promises[0]?.effectiveStatus, 'active')
    assert.equal(listed.promises[0]?.advanceCount, 1)

    const extracted = await runCli(dir, ['promise', 'extract', '1', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    const candidateId = json<{ candidates: Array<{ candidateId: string }> }>(extracted.stdout).candidates[0]!.candidateId
    listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.promises[0]?.effectiveStatus, 'active', 'unconfirmed extraction must not change state')
    assert.equal((await runCli(dir, ['promise', 'confirm', candidateId, '--json'])).code, 0)
    listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.promises[0]?.effectiveStatus, 'paid_off')
    assert.equal(listed.promises[0]?.payoff?.evidence.quote, '林岚确认有人换过账页')

    assert.equal((await runCli(dir, ['amend', '1', '--json'])).code, 0)
    await finalize(dir, '林岚发现账页编号与旧照片一致。')
    listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.promises[0]?.effectiveStatus, 'active')
    assert.equal(listed.promises[0]?.stalePayoff, true)
    const findings = await readerPromiseFindings(dir, 2)
    assert.ok(findings.some(finding => finding.ruleId === 'reader-promise-stale-payoff' && finding.severity === 'warning'))
    assert.ok(findings.some(finding => finding.ruleId === 'reader-promise-overdue' && finding.severity === 'warning'))

    const paid = await runCli(dir, ['promise', 'payoff', 'rp-ledger', '--chapter', '1', '--quote', '林岚发现账页编号与旧照片一致', '--json'])
    assert.equal(paid.code, 0, paid.stdout + paid.stderr)
    assert.equal((await readerPromiseFindings(dir, 2)).some(finding => finding.ruleId === 'reader-promise-stale-payoff'), false)
    assert.equal((await runCli(dir, ['promise', 'confirm', candidateId, '--json'])).code, 3, 'confirmed candidates must be removed')
    assert.equal((await runCli(dir, ['promise', 'abandon', 'rp-ledger', '--reason', '作者改换调查方向', '--json'])).code, 0)
    listed = json<PromiseList>((await runCli(dir, ['promise', 'list', '--json'])).stdout)
    assert.equal(listed.promises[0]?.effectiveStatus, 'abandoned')
    assert.equal((await collectLoopState(dir)).loops.length, 0, 'ReaderPromise must not create OpenLoop records')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('promise references require approved known IDs and tolerate projects without promise files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-promise-validation-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '引用检查', '--model', 'fake', '--base-url', 'http://127.0.0.1:1/v1', '--workflow', 'p0'])).code, 0)
    await contract(dir, false)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    await contract(dir, true)
    const invalid = await runCli(dir, ['contract', 'check', '1', '--json'])
    assert.equal(invalid.code, 3)
    assert.match(invalid.stdout, /UNKNOWN_READER_PROMISE/)

    const promiseFile = path.join(dir, 'promise-input.json')
    await writeFile(promiseFile, `${JSON.stringify({ promises: [{
      promiseId: 'rp-ledger', description: '读者知道谁换过账页', status: 'active', volume: 2, relatedLoopIds: [],
    }] })}\n`)
    assert.equal((await runCli(dir, ['promise', 'set', '--file', promiseFile, '--json'])).code, 0)
    assert.equal((await runCli(dir, ['promise', 'approve', '--json'])).code, 0)
    await contract(dir, true, { volume: 1 })
    const wrongVolume = await runCli(dir, ['contract', 'check', '1', '--json'])
    assert.equal(wrongVolume.code, 3)
    assert.match(wrongVolume.stdout, /READER_PROMISE_VOLUME_MISMATCH/)

    await contract(dir, true, { volume: 2 })
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    const approvedFile = path.join(dir, 'plans', 'reader-promises.json')
    const approved = JSON.parse(await readFile(approvedFile, 'utf8')) as {
      content: { promises: Array<{ targetToChapter?: number }> }
    }
    approved.content.promises[0]!.targetToChapter = 99
    await writeFile(approvedFile, `${JSON.stringify(approved, null, 2)}\n`)
    const stale = await runCli(dir, ['contract', 'check', '1', '--json'])
    assert.equal(stale.code, 3)
    assert.match(stale.stdout, /READER_PROMISE_APPROVAL_STALE/)

    assert.equal((await runCli(dir, ['promise', 'abandon', 'rp-ledger', '--reason', '测试废弃引用', '--json'])).code, 0)
    const abandoned = await runCli(dir, ['contract', 'check', '1', '--json'])
    assert.equal(abandoned.code, 3)
    assert.match(abandoned.stdout, /ABANDONED_READER_PROMISE/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
