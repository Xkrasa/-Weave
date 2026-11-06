import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

class ScriptedModel {
  readonly requests: Array<Record<string, unknown>> = []
  private readonly texts: string[]
  private readonly server: Server
  baseUrl = ''

  constructor(texts: string[]) {
    this.texts = [...texts]
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        try {
          this.requests.push(JSON.parse(body) as Record<string, unknown>)
        } catch {
          this.requests.push({ raw: body })
        }
        const text = this.texts.shift() ?? '林岚把账本摊在桌上。'
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\n`)
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

const DRAFT = '林岚在码头翻开账本。\n\n她发现缺页上留着港务局的印。'

function extractionPayload(): string {
  return JSON.stringify({
    summary: '林岚发现账本缺页。',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚发现账本缺页',
      participants: ['林岚'],
      location: '海港',
      storyTime: '第一天',
      payload: {},
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    }],
    timeline: [{
      eventId: 'e1',
      recordId: 'r1',
      summary: '林岚发现账本缺页',
      dayOffset: 0,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    }],
    facts: [],
    beliefs: [],
    loops: [],
  })
}

async function initBook(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-policy-'))
  const result = await runCli(dir, ['init', '.', '--title', '模型策略', '--model', 'base-model', '--base-url', baseUrl, '--workflow', 'p05'])
  assert.equal(result.code, 0, result.stderr)
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
    mustHappen: ['林岚发现账本缺页'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: ['账本'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
  }, null, 2)}\n`)
  assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
  return dir
}

async function patchConfig(dir: string, patch: Record<string, unknown>): Promise<void> {
  const file = path.join(dir, '.weave', 'config.json')
  const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  await writeFile(file, `${JSON.stringify({ ...config, ...patch }, null, 2)}\n`)
}

test('task policies route model and temperature per stage, and usage aggregates', async () => {
  const model = new ScriptedModel([DRAFT, extractionPayload()])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await patchConfig(dir, {
      taskModels: {
        writing: { model: 'writer-model', temperature: 0.25 },
        extraction: { model: 'extract-model', temperature: 0.05 },
      },
    })
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    assert.equal(model.requests[0]?.model, 'writer-model')
    assert.equal(model.requests[0]?.temperature, 0.25)

    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    assert.equal(model.requests[1]?.model, 'extract-model')
    assert.equal(model.requests[1]?.temperature, 0.05)

    const usage = parseJson<{
      totals: { runs: number; totalTokens: number }
      byModel: Record<string, { runs: number; promptTokens: number }>
      byTask: Record<string, { runs: number }>
    }>((await runCli(dir, ['usage', '--json'])).stdout)
    assert.equal(usage.totals.runs, 2)
    assert.equal(usage.byModel['writer-model']?.promptTokens, 100)
    assert.equal(usage.byModel['extract-model']?.runs, 1)
    assert.equal(usage.byTask['writing']?.runs, 1)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy extractionModel still applies when no task policy overrides it', async () => {
  const model = new ScriptedModel([DRAFT, extractionPayload()])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await patchConfig(dir, { extractionModel: 'legacy-extract' })
    assert.equal((await runCli(dir, ['write', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal(model.requests[1]?.model, 'legacy-extract')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unparseable JSON gets one repair pass before failing', async () => {
  const model = new ScriptedModel([DRAFT, '这不是 JSON', extractionPayload()])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    assert.equal((await runCli(dir, ['write', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    assert.equal(model.requests.length, 3)
    assert.match(JSON.stringify(model.requests[2]), /无法解析为 JSON/)

    const badModel = new ScriptedModel([DRAFT, '不是 JSON', '仍然不是 JSON'])
    await badModel.start()
    const other = await initBook(badModel.baseUrl)
    try {
      assert.equal((await runCli(other, ['write', '1', '--json'])).code, 0)
      assert.equal((await runCli(other, ['check', '1', '--json'])).code, 0)
      const failed = await runCli(other, ['extract', '1', '--json'])
      assert.equal(failed.code, 3)
      assert.match(parseJson<{ error: { message: string } }>(failed.stdout).error.message, /可解析|没有返回 JSON/)
    } finally {
      await badModel.close()
      await rm(other, { recursive: true, force: true })
    }
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
