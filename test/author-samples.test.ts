import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject } from '../src/core/project.ts'
import { loadAuthorSamples, selectAuthorSamples } from '../src/core/style.ts'
import type { ChapterContract } from '../src/core/types.ts'

const CLI = path.resolve('src/cli.ts')
interface Result { code: number; stdout: string; stderr: string }
interface SampleRoute {
  selection: {
    samples: Array<{ id: string }>
    selected: Array<{ id: string; reasons: string[] }>
  }
}
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

function contract(overrides: Partial<ChapterContract> = {}): ChapterContract {
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
    characters: ['许舟', '小罗'],
    threads: ['异常退款'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
    readerIntent: { purpose: 'release', payoff: '读者看到错误罚单被撤销' },
    sceneTypes: ['battle'],
    ...overrides,
  }
}

async function samples(dir: string): Promise<void> {
  const root = path.join(dir, 'canon', 'samples')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'a-daily.md'), `---\nsceneTypes: daily\ncharacters: 林岚\npov: 林岚\nstyleTags: quiet\n---\n林岚慢慢翻开账本。`)
  await writeFile(path.join(root, 'b-battle.md'), `---\nsceneTypes: battle, confrontation\ncharacters: 许舟, 小罗\npov: 许舟\nstyleTags: direct\n---\n许舟把两份时间线拍在邱岳面前。`)
  await writeFile(path.join(root, 'c-battle-other.md'), `---\nsceneTypes: battle\ncharacters: 唐姨\npov: 唐姨\nstyleTags: quiet\n---\n唐姨指着退回的药品。`)
}

test('author samples use metadata before limit, deterministic scoring, fallback and budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-samples-select-'))
  try {
    await initProject(dir, { title: '样本选择', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1', workflowVersion: 2 })
    await samples(dir)
    assert.equal((await loadAuthorSamples(dir, 1))[0]?.id, 'a-daily')

    const first = await selectAuthorSamples(dir, contract(), { limit: 2 })
    assert.equal(first.samples[0]?.id, 'b-battle')
    assert.equal(first.fallback, false)
    assert.ok(first.selected[0]?.reasons.some(reason => reason.includes('battle')))
    assert.ok(first.selected[0]?.reasons.some(reason => reason.includes('许舟')))
    assert.deepEqual(first.samples.map(sample => sample.id), (await selectAuthorSamples(dir, contract(), { limit: 2 })).samples.map(sample => sample.id))

    const fallback = await selectAuthorSamples(dir, contract({
      pov: '不存在',
      characters: ['不存在'],
      sceneTypes: ['mystery'],
      readerIntent: { purpose: 'unknown', payoff: '无匹配' },
      mustHappen: ['没有匹配标签'],
    }), { limit: 2 })
    assert.equal(fallback.fallback, true)
    assert.deepEqual(fallback.samples.map(sample => sample.id), ['a-daily', 'b-battle'])

    const overBudget = await selectAuthorSamples(dir, contract(), { limit: 2, maxTokens: 1 })
    assert.equal(overBudget.samples.length, 0)
    assert.ok(overBudget.reasons.some(reason => reason.includes('预算')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

class FakeModel {
  readonly requests: Array<Record<string, unknown>> = []
  baseUrl = ''
  private server: Server
  constructor() {
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        this.requests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '许舟撤销了罚单。' } }] })}\n\n`)
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

test('writing and style samples expose the selected sample ids and reasons', async () => {
  const model = new FakeModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-samples-write-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '样本写作', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code, 0)
    await samples(dir)
    await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [
      { name: '许舟', status: 'alive', introducedIn: 1 },
      { name: '小罗', status: 'alive', introducedIn: 1 },
    ] })}\n`)
    await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify(contract(), null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stdout + written.stderr)
    const prompt = JSON.stringify(model.requests[0])
    assert.ok(prompt.includes('许舟把两份时间线拍在邱岳面前'))
    assert.equal(prompt.includes('林岚慢慢翻开账本'), false)

    const route = json<SampleRoute>(
      (await runCli(dir, ['style', 'samples', '--chapter', '1', '--json'])).stdout,
    )
    assert.equal(route.selection.samples[0]?.id, 'b-battle')
    assert.ok(route.selection.selected[0]?.reasons.length)

    const runsDir = path.join(dir, '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as { task: string; sampleSelection?: { samples: Array<{ id: string }> } }))
    assert.equal(runs.find(run => run.task === 'writing')?.sampleSelection?.samples[0]?.id, 'b-battle')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
