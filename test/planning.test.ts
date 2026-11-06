import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

class FakeModel {
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

async function initBook(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-plan-'))
  const result = await runCli(dir, ['init', '.', '--title', '规划测试', '--model', 'fake', '--base-url', baseUrl, '--workflow', 'p0'])
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

function storyEnvelope(sellingPoint: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'story',
    status: 'draft',
    provenance: 'generated',
    contentHash: 'pending',
    content: {
      audience: '追更读者',
      genre: '悬疑',
      coreFantasy: '用账本撬开整座港口',
      uniqueSellingPoint: sellingPoint,
      emotionalPromise: '每次翻页都更接近真相',
      protagonistDesire: '拿回母亲的房子',
    },
  }, null, 2)}\n`
}

test('planning artifacts are non-authoritative until approved, then reach the prompt', async () => {
  const model = new FakeModel(['草稿一', '草稿二', '草稿三', '草稿四', '草稿五'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const missing = parseJson<{ plans: Array<{ kind: string; status: string }> }>(
      (await runCli(dir, ['plan', 'status', '--json'])).stdout,
    )
    assert.ok(missing.plans.some(item => item.kind === 'story' && item.status === 'missing'))

    const plansDir = path.join(dir, 'plans')
    await mkdir(plansDir, { recursive: true })
    await writeFile(path.join(plansDir, 'story.json'), storyEnvelope('港口账本的第一版卖点'))
    const draft = parseJson<{ plans: Array<{ kind: string; status: string }> }>(
      (await runCli(dir, ['plan', 'status', '--json'])).stdout,
    )
    assert.equal(draft.plans.find(item => item.kind === 'story')?.status, 'draft')

    const first = await runCli(dir, ['write', '1', '--json'])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(JSON.stringify(model.requests[0]).includes('港口账本的第一版卖点'), false)
    assert.equal(parseJson<{ included: string[] }>(first.stdout).included.includes('plan:story-promise'), false)

    const approved = await runCli(dir, ['plan', 'approve', 'story', '--json'])
    assert.equal(approved.code, 0, approved.stderr)
    assert.equal(parseJson<{ status: string }>(approved.stdout).status, 'approved')

    const second = await runCli(dir, ['write', '1', '--json'])
    assert.equal(second.code, 0, second.stderr)
    assert.ok(JSON.stringify(model.requests[1]).includes('港口账本的第一版卖点'))
    assert.ok(parseJson<{ included: string[] }>(second.stdout).included.includes('plan:story-promise'))

    const approvedFile = JSON.parse(await readFile(path.join(plansDir, 'story.json'), 'utf8')) as {
      content: Record<string, unknown>
    }
    approvedFile.content.uniqueSellingPoint = '未经批准的第二版卖点'
    await writeFile(path.join(plansDir, 'story.json'), `${JSON.stringify(approvedFile, null, 2)}
`)
    const modified = parseJson<{ plans: Array<{ kind: string; status: string }> }>(
      (await runCli(dir, ['plan', 'status', '--json'])).stdout,
    )
    assert.equal(modified.plans.find(item => item.kind === 'story')?.status, 'modified')

    const third = await runCli(dir, ['write', '1', '--json'])
    assert.equal(third.code, 0, third.stderr)
    assert.equal(JSON.stringify(model.requests[2]).includes('未经批准的第二版卖点'), false)
    assert.equal(JSON.stringify(model.requests[2]).includes('港口账本的第一版卖点'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('approved volume, rolling plan and character arcs join the context', async () => {
  const model = new FakeModel(['草稿一', '草稿二'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await mkdir(path.join(dir, 'plans', 'volumes'), { recursive: true })
    await writeFile(path.join(dir, 'plans', 'volumes', '001.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'volume',
      status: 'draft',
      provenance: 'generated',
      contentHash: 'pending',
      content: {
        volume: 1,
        title: '雾港',
        mainConflict: '林岚与港务局争夺账本',
        antagonistEscalation: '港务局开始销毁旧档',
        protagonistChoice: '她选择公开一半账本',
        climax: '冷库对峙',
        irreversibleChange: '周砚暴露立场',
        threads: ['账本'],
        readerPromises: ['账本缺页的来源'],
      },
    }, null, 2)}\n`)
    await writeFile(path.join(dir, 'plans', 'rolling.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'rolling',
      status: 'draft',
      provenance: 'generated',
      contentHash: 'pending',
      content: { fromChapter: 1, chapters: [{ chapter: 2, title: '潮位', goal: '查货单', beats: ['对上编号'] }] },
    }, null, 2)}\n`)
    await writeFile(path.join(dir, 'plans', 'character-arcs.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'character-arcs',
      status: 'draft',
      provenance: 'generated',
      contentHash: 'pending',
      content: { characters: [{ name: '林岚', desire: '拿回房子', fear: '重蹈父亲的路', misbelief: '只要账本完整就能翻案', voice: '短句，不解释', relationshipDirection: '缓慢信任周砚', growthCost: '每次靠近真相就失去一个熟人' }] },
    }, null, 2)}\n`)

    for (const args of [
      ['plan', 'approve', 'volume', '--volume', '1', '--json'],
      ['plan', 'approve', 'rolling', '--json'],
      ['plan', 'approve', 'character-arcs', '--json'],
    ]) {
      const result = await runCli(dir, args)
      assert.equal(result.code, 0, result.stdout + result.stderr)
    }

    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const included = parseJson<{ included: string[] }>(written.stdout).included
    assert.ok(included.includes('plan:volume'))
    assert.ok(included.includes('plan:rolling'))
    assert.ok(included.includes('plan:character-arcs'))

    const body = JSON.stringify(model.requests[0])
    assert.ok(body.includes('她选择公开一半账本'))
    assert.ok(body.includes('缓慢信任周砚'))
    assert.ok(body.includes('对上编号'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
