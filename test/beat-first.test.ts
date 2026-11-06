import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
  readonly requests: Array<Record<string, unknown>> = []
  baseUrl = ''
  private server: Server
  private readonly planningText: string
  constructor(planningText: string) {
    this.planningText = planningText
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        this.requests.push(parsed)
        const text = JSON.stringify(parsed.messages).includes('场景节拍规划器') ? this.planningText : '许舟用新证据撤销了罚单。'
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

async function contract(dir: string, chapter: number): Promise<void> {
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '许舟', status: 'alive', introducedIn: 1 }] })}\n`)
  await writeFile(path.join(dir, 'outlines', 'chapters', `${String(chapter).padStart(3, '0')}.json`), `${JSON.stringify({
    chapter,
    title: chapter === 1 ? '退单' : '第七单',
    pov: '许舟',
    time: '午高峰',
    location: '站点',
    openingState: '许舟收到异常罚单',
    endingState: '罚单被撤销',
    goal: '证明罚单错误',
    obstacle: '平台记录与顾客记录不一致',
    mustHappen: ['许舟核对订单'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['许舟'],
    threads: ['异常退款'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续追查',
    readerIntent: { purpose: 'release', payoff: '读者看到许舟撤销错误罚单' },
  }, null, 2)}\n`)
  assert.equal((await runCli(dir, ['contract', 'check', String(chapter), '--json'])).code, 0)
}

test('beat-first requires approved beats, then writes one chapter with auditable planning', async () => {
  const planning = JSON.stringify({ beats: [{
    goal: '许舟核对订单时间线',
    obstacle: '平台显示提前退款',
    turn: '顾客端保存了另一份时间',
    infoRelease: '两份记录来自不同账号',
    emotionalLanding: '许舟从慌乱转为有据可依',
    endingState: '罚单进入人工复核',
  }] })
  const model = new FakeModel(planning)
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-beat-first-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '节拍实验', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code, 0)
    await contract(dir, 1)
    assert.equal((await runCli(dir, ['write', '1', '--strategy', 'beat-first', '--json'])).code, 4)
    assert.equal(model.requests.length, 0)

    const generated = await runCli(dir, ['beats', 'generate', '1', '--json'])
    assert.equal(generated.code, 0, generated.stdout + generated.stderr)
    assert.equal(json<{ status: string }>(generated.stdout).status, 'draft')
    assert.equal(model.requests.length, 1)
    assert.equal((await runCli(dir, ['write', '1', '--strategy', 'beat-first', '--json'])).code, 4)
    assert.equal(model.requests.length, 1)

    const edited = path.join(dir, 'edited-beats.json')
    await writeFile(edited, planning)
    assert.equal((await runCli(dir, ['beats', 'set', '1', '--file', edited, '--json'])).code, 0)
    assert.equal((await runCli(dir, ['beats', 'approve', '1', '--json'])).code, 0)
    const written = await runCli(dir, ['write', '1', '--strategy', 'beat-first', '--json'])
    assert.equal(written.code, 0, written.stdout + written.stderr)
    assert.equal(json<{ draftingStrategy: string }>(written.stdout).draftingStrategy, 'beat-first')
    assert.equal(model.requests.length, 2)
    const writingRequest = JSON.stringify(model.requests[1])
    assert.ok(writingRequest.includes('许舟核对订单时间线'))
    assert.ok(writingRequest.includes('读者看到许舟撤销错误罚单'))
    assert.ok((await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')).includes('撤销了罚单'))

    const candidateFile = path.join(dir, 'plans', 'beats', '001.json')
    const candidate = JSON.parse(await readFile(candidateFile, 'utf8')) as { approvedBy: string; beats: Array<{ goal: string }> }
    assert.equal(candidate.approvedBy, 'author')
    candidate.beats[0]!.goal = '作者改过但尚未重新批准'
    await writeFile(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`)
    assert.equal((await runCli(dir, ['write', '1', '--strategy', 'beat-first', '--json'])).code, 4)
    assert.equal(model.requests.length, 2, 'modified approved beats must not reach the writer')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await contract(dir, 2)
    const defaultWritten = await runCli(dir, ['write', '2', '--json'])
    assert.equal(defaultWritten.code, 0, defaultWritten.stdout + defaultWritten.stderr)
    assert.equal(model.requests.length, 3, 'default strategy must not call planning')
    assert.equal((await runCli(dir, ['beats', 'generate', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['beats', 'skip', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['write', '2', '--strategy', 'beat-first', '--json'])).code, 4)
    assert.equal((await runCli(dir, ['write', '2', '--json'])).code, 0)

    const runsDir = path.join(dir, '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).filter(name => name.endsWith('.json')).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as { task: string; status: string; draftingStrategy?: string }))
    assert.ok(runs.some(run => run.task === 'planning' && run.status === 'completed'))
    assert.ok(runs.some(run => run.task === 'writing' && run.draftingStrategy === 'beat-first'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed beat planning leaves no approved candidate or story facts', async () => {
  const model = new FakeModel('not valid json')
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-beat-failure-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '节拍失败', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code, 0)
    await contract(dir, 1)
    const generated = await runCli(dir, ['beats', 'generate', '1', '--json'])
    assert.notEqual(generated.code, 0)
    const candidate = await readFile(path.join(dir, 'plans', 'beats', '001.json'), 'utf8').catch(() => null)
    assert.equal(candidate, null)
    assert.equal((await runCli(dir, ['write', '1', '--strategy', 'beat-first', '--json'])).code, 4)
    const runsDir = path.join(dir, '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as { task: string; status: string }))
    assert.ok(runs.some(run => run.task === 'planning' && run.status === 'failed'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
