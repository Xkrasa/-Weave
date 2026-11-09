import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts')

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
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

function parseJson<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, `no JSON in output: ${stdout.slice(0, 300)}`)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

type Behaviour = 'ok' | '429' | '500' | 'break' | 'empty' | 'length'

class ScriptedModel {
  readonly requests: Array<Record<string, unknown>> = []
  private readonly behaviours: Behaviour[]
  private readonly server: Server
  private readonly responses = new Set<ServerResponse>()
  private readonly text: string
  baseUrl = ''

  constructor(behaviours: Behaviour[], text = '林岚把账本摊在桌上，缺页的边缘还留着新鲜折痕。') {
    this.behaviours = [...behaviours]
    this.text = text
    this.server = createServer((request, response) => this.handle(request, response))
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    assert.ok(address && typeof address === 'object')
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`
  }

  async close(): Promise<void> {
    for (const response of this.responses) response.destroy()
    this.responses.clear()
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try {
        this.requests.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        this.requests.push({ raw: body })
      }
      const behaviour = this.behaviours.shift() ?? 'ok'
      this.responses.add(response)
      response.on('close', () => this.responses.delete(response))
      if (behaviour === '429') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        response.end(JSON.stringify({ error: 'rate limited' }))
        return
      }
      if (behaviour === '500') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'upstream exploded' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (behaviour === 'empty') {
        response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      if (behaviour === 'break') {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半' } }] })}\n\n`)
        setTimeout(() => response.destroy(), 10)
        return
      }
      if (behaviour === 'length') {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: this.text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: this.text } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  }
}

async function initBook(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-stream-'))
  const result = await runCli(dir, [
    'init', '.', '--title', '重试测试', '--model', 'fake-model', '--base-url', baseUrl, '--workflow', 'p0',
  ])
  assert.equal(result.code, 0, result.stderr)
  const configPath = path.join(dir, '.weave', 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  config.retryBaseMs = 5
  config.maxRetries = 3
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  await writeFile(
    path.join(dir, 'canon', 'characters.json'),
    `${JSON.stringify({ characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }] }, null, 2)}\n`,
  )
  await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
    chapter: 1,
    title: '缺页',
    pov: '林岚',
    time: '第一日',
    location: '旧仓库',
    openingState: '林岚回到仓库',
    endingState: '她确认缺页',
    goal: '找到账本',
    obstacle: '管理员不开灯',
    mustHappen: ['林岚发现缺页'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: ['账本'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
  }, null, 2)}\n`)
  const checked = await runCli(dir, ['contract', 'check', '1', '--json'])
  assert.equal(checked.code, 0, checked.stderr)
  return dir
}

async function latestRun(dir: string): Promise<{
  runId: string
  status: string
  finishReason?: string
  attempts?: Array<{ status: string; finishReason?: string }>
  recovery?: unknown
}> {
  const runsDir = path.join(dir, '.weave', 'runs')
  const names = (await readdir(runsDir)).filter(name => name.endsWith('.json')).sort()
  assert.ok(names.length > 0)
  return JSON.parse(await readFile(path.join(runsDir, names[names.length - 1]!), 'utf8'))
}

test('retries 429 and 5xx before the first delta, then records every attempt', async () => {
  const model = new ScriptedModel(['429', '500', 'ok'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    assert.equal(model.requests.length, 3)
    const payload = parseJson<{ attempts: Array<{ status: string }> }>(written.stdout)
    assert.deepEqual(payload.attempts.map(item => item.status), ['retry', 'retry', 'ok'])

    const run = await latestRun(dir)
    assert.equal(run.status, 'completed')
    assert.deepEqual((run.attempts ?? []).map(item => (item as { status: string }).status), ['retry', 'retry', 'ok'])
    assert.ok(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('gives up after the retry budget and never writes a draft', async () => {
  const model = new ScriptedModel(['500', '500', '500', '500', '500'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 5)
    assert.equal(model.requests.length, 4)
    const run = await latestRun(dir)
    assert.equal(run.status, 'failed')
    assert.deepEqual((run.attempts ?? []).map(item => (item as { status: string }).status), ['retry', 'retry', 'retry', 'failed'])
    const drafts = await readdir(path.join(dir, 'chapters', 'drafts'))
    assert.equal(drafts.filter(name => name.endsWith('.md')).length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('does not transparently retry after prose has started streaming', async () => {
  const model = new ScriptedModel(['break', 'ok'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 5, written.stdout)
    assert.equal(model.requests.length, 1, 'a stream that already emitted prose must not be replayed')
    const run = await latestRun(dir)
    assert.equal(run.status, 'failed')
    const partialPath = (run as unknown as { partialPath?: string }).partialPath
    assert.ok(partialPath)
    assert.match(await readFile(path.join(dir, partialPath!), 'utf8'), /半/)

    const resumed = await runCli(dir, ['write', '1', '--json', '--resume'])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(model.requests.length, 2)
    const resumedPayload = parseJson<{ recovery?: { fromRunId: string; strategy: string } }>(resumed.stdout)
    assert.equal(resumedPayload.recovery?.fromRunId, run.runId)
    assert.equal(resumedPayload.recovery?.strategy, 'regenerate')
    const fresh = await latestRun(dir)
    assert.notEqual(fresh.runId, run.runId)
    assert.equal(fresh.status, 'completed')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resume rejects a run from another chapter or without a partial', async () => {
  const model = new ScriptedModel(['ok'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const missing = await runCli(dir, ['write', '1', '--json', '--from-run', 'run-missing'])
    assert.equal(missing.code, 3)
    const payload = parseJson<{ error: { message: string } }>(missing.stdout)
    assert.match(payload.error.message, /未找到运行记录/)
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('retries a reasoning-only or empty response before surfacing failure', async () => {
  const model = new ScriptedModel(['empty', 'ok'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stdout + written.stderr)
    assert.equal(model.requests.length, 2)
    const payload = parseJson<{ attempts: Array<{ status: string }> }>(written.stdout)
    assert.deepEqual(payload.attempts.map(item => item.status), ['retry', 'ok'])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('records stop for a normal completion', async () => {
  const model = new ScriptedModel(['ok'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const run = await latestRun(dir)
    assert.equal(run.status, 'completed')
    assert.equal(run.finishReason, 'stop')
    assert.equal(run.attempts?.[0]?.finishReason, 'stop')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('records length so max-token truncation stays diagnosable', async () => {
  const model = new ScriptedModel(['length'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const run = await latestRun(dir)
    assert.equal(run.status, 'completed')
    assert.equal(run.finishReason, 'length')
    assert.equal(run.attempts?.[0]?.finishReason, 'length')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty responses exhaust the retry budget without writing a draft', async () => {
  const model = new ScriptedModel(['empty', 'empty', 'empty', 'empty'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 5)
    assert.equal(model.requests.length, 4)
    const run = await latestRun(dir)
    assert.equal(run.status, 'failed')
    assert.deepEqual((run.attempts ?? []).map(item => (item as { status: string }).status), ['retry', 'retry', 'retry', 'failed'])
    const drafts = await readdir(path.join(dir, 'chapters', 'drafts'))
    assert.equal(drafts.filter(name => name.endsWith('.md')).length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
