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

const REFERENCE = [
  '第一章 起点',
  '她把账本推到桌子中央，先开口的人就输了。',
  '',
  '第二章 试探',
  '他问了一个不该问的问题，她答得更快。',
  '',
  '第三章 兑价',
  '两个人都不肯先起身，门外的雨停了。',
  '',
].join('\n')

const ANALYSIS = JSON.stringify({
  summary: '三章都用一次交换推进关系，章末停在未完成的动作上。',
  scenes: [{
    chapter: 1,
    goal: '拿到账本',
    obstacle: '对方不肯先开口',
    choice: '她先推账本过去',
    turn: '对方没有接',
    stateChange: '主动权转移',
    infoRelease: '读者先知道账本在她手里',
    endingQuestion: '对方会不会接',
  }],
  patterns: ['每章以一次交换推进关系'],
  methods: [{
    id: 'scene-turn',
    tags: ['因果', '结构', '章末'],
    scope: 'long-form chapter',
    signal: '场景里的人在谈条件，但没有人的处境改变',
    diagnosis: '交换没有代价，所以读者看不到损失',
    process: '把选择写成不可撤销的动作，让其中一方当场失去一样东西。',
    output: '场景结束时至少一方付出代价。',
    positive: '她把钥匙放在桌上，推过去，没有再拿回来。',
    negative: '两人聊了很久，最后各自回家。',
    selfCheck: '这一场结束后，谁失去了什么？',
  }],
})

async function initBook(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-deconstruct-'))
  const result = await runCli(dir, ['init', '.', '--title', '拆书', '--model', 'fake', '--base-url', baseUrl, '--workflow', 'p0'])
  assert.equal(result.code, 0, result.stderr)
  await writeFile(path.join(dir, 'reference.txt'), REFERENCE)
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
    goal: '找出账本缺页的因果链',
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
  assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
  return dir
}

test('deconstruct analysis produces method cards that only affect prompts after approval', async () => {
  const model = new ScriptedModel([ANALYSIS, '第一章正文草稿。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const analyzed = await runCli(dir, [
      'deconstruct', 'reference.txt', '--analyze', '--methods', '--json',
    ])
    assert.equal(analyzed.code, 0, analyzed.stdout + analyzed.stderr)
    const payload = parseJson<{
      analysis: { summary: string; scenes: unknown[]; methods: Array<{ id: string }> }
      methodCandidates: Array<{ id: string; status: string }>
    }>(analyzed.stdout)
    assert.match(payload.analysis.summary, /交换/)
    assert.equal(payload.analysis.scenes.length, 1)
    assert.equal(payload.methodCandidates[0]?.status, 'draft')

    const candidate = JSON.parse(await readFile(
      path.join(dir, 'methods', 'candidates', 'scene-turn.json'),
      'utf8',
    )) as { status: string; method: { process: string } }
    assert.equal(candidate.status, 'draft')
    assert.match(candidate.method.process, /不可撤销/)
    assert.equal(JSON.stringify(candidate).includes('她把账本推到桌子中央'), false, 'reference prose must not be copied')

    const listed = parseJson<{ modules: Array<{ id: string }> }>((await runCli(dir, ['method', 'list', '--json'])).stdout)
    assert.equal(listed.modules.some(item => item.id === 'scene-turn'), false, 'draft cards stay out of the library')

    const approved = await runCli(dir, ['method', 'approve', 'scene-turn', '--json'])
    assert.equal(approved.code, 0, approved.stdout + approved.stderr)
    const after = parseJson<{ modules: Array<{ id: string }> }>((await runCli(dir, ['method', 'list', '--json'])).stdout)
    assert.ok(after.modules.some(item => item.id === 'scene-turn'))

    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    assert.match(JSON.stringify(model.requests[1]), /不可撤销的动作/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
