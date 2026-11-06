import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { savePlanDraft, approvePlan } from '../src/core/planning.ts'
import { runEffectReview } from '../src/core/effect-review.ts'
import { loadModelConfig, loadProject } from '../src/core/project.ts'
import type { ChapterContract } from '../src/core/types.ts'

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

async function init(dir: string, platform = true, baseUrl = 'http://127.0.0.1:1/v1'): Promise<void> {
  const result = await runCli(dir, [
    'init', '.', '--title', '退单十分钟', '--model', 'fake', '--base-url', baseUrl, '--workflow', 'p0',
    ...(platform ? ['--platform', 'fanqie'] : []),
  ])
  assert.equal(result.code, 0, result.stderr)
  if (platform) {
    await mkdir(path.join(dir, 'canon', 'platforms'), { recursive: true })
    await writeFile(path.join(dir, 'canon', 'platforms', 'fanqie.json'), await readFile(path.resolve('canon/platforms/fanqie.json'), 'utf8'))
  }
}

test('hotspot imports preserve scope and quality, compare only matching snapshots and only suggest topics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-hotspots-'))
  try {
    await init(dir, false)
    const csv = path.join(dir, 'week1.csv')
    await writeFile(csv, [
      '排名,书名,作者,题材,标签,状态,字数,在读,备注',
      '1,退单十分钟,作者甲,都市脑洞,系统+重生,连载中,20万字,2万,公开样本',
      '2,断脉者,作者乙,玄幻,升级,连载中,30万字,1万,公开样本',
    ].join('\n'))
    const imported = await runCli(dir, [
      'hotspot', 'import', csv, '--captured-at', '2026-11-01', '--ranking', '新书榜',
      '--metric', '在读', '--channel', 'all', '--filter', '连载中', '--sampling', '作者提供的前两本', '--id', 'week1', '--json',
    ])
    assert.equal(imported.code, 0, imported.stdout + imported.stderr)
    assert.equal(json<{ snapshot: { entries: unknown[]; dataQuality: { warnings: string[] } } }>(imported.stdout).snapshot.entries.length, 2)
    assert.ok(json<{ snapshot: { dataQuality: { warnings: string[] } } }>(imported.stdout).snapshot.dataQuality.warnings.some(warning => warning.includes('未知列')))

    const markdown = path.join(dir, 'week2.md')
    await writeFile(markdown, [
      '# 番茄 · 新书榜',
      '',
      '### #1 退单十分钟',
      '*作者甲 · 都市脑洞 · 连载中 · 20万字 · 3.5万在读*',
      '**标签：** 系统+重生',
      '',
      '### #2 夜班直播间',
      '*作者丙 · 都市脑洞 · 连载中 · 8万字 · 5000在读*',
      '**标签：** 系统+直播',
      '',
    ].join('\n'))
    assert.equal((await runCli(dir, [
      'hotspot', 'import', markdown, '--captured-at', '2026-11-06', '--ranking', '新书榜',
      '--metric', '在读', '--channel', 'all', '--filter', '连载中', '--id', 'week2', '--json',
    ])).code, 0)
    const comparison = json<{
      previousMedian: number
      currentMedian: number
      added: Array<{ title: string }>
      removed: Array<{ title: string }>
      changed: Array<{ title: string; delta: number }>
    }>((await runCli(dir, ['hotspot', 'compare', 'week1', 'week2', '--json'])).stdout)
    assert.equal(comparison.previousMedian, 15000)
    assert.equal(comparison.currentMedian, 20000)
    assert.equal(comparison.changed[0]?.delta, 15000)
    assert.equal(comparison.added[0]?.title, '夜班直播间')
    assert.equal(comparison.removed[0]?.title, '断脉者')

    const candidates = json<{ candidates: Array<{ value: string; sampleCount: number; status: string }> }>(
      (await runCli(dir, ['hotspot', 'candidates', 'week2', '--json'])).stdout,
    )
    assert.ok(candidates.candidates.some(candidate => candidate.value === '都市脑洞' && candidate.sampleCount === 2))
    assert.ok(candidates.candidates.some(candidate => candidate.value === '系统' && candidate.sampleCount === 2))
    assert.ok(candidates.candidates.every(candidate => candidate.status === 'suggested'))
    assert.equal(await readFile(path.join(dir, 'plans', 'story.json'), 'utf8').catch(() => null), null)

    await writeFile(path.join(dir, 'week1-other.csv'), '排名,书名,作者,题材,标签,状态,字数,在读\n1,退单十分钟,作者甲,都市脑洞,系统,连载中,20万字,2万\n')
    assert.equal((await runCli(dir, [
      'hotspot', 'import', path.join(dir, 'week1-other.csv'), '--captured-at', '2026-11-02',
      '--ranking', '阅读榜', '--metric', '在读', '--id', 'other', '--json',
    ])).code, 0)
    const mismatch = await runCli(dir, ['hotspot', 'compare', 'week1', 'other', '--json'])
    assert.equal(mismatch.code, 3)
    assert.match(mismatch.stdout, /口径/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

class FakeModel {
  baseUrl = ''
  readonly requests: Array<Record<string, unknown>> = []
  private server: Server
  constructor() {
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        this.requests.push(JSON.parse(body) as Record<string, unknown>)
        const text = JSON.stringify({ summary: '已完成审查。', findings: [] })
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

function contract(): ChapterContract {
  return {
    chapter: 1,
    title: '退单',
    pov: '许舟',
    time: '23:50',
    location: '唐姨家门口',
    openingState: '许舟送出药品',
    endingState: '罚单被撤销',
    goal: '证明按时送达',
    obstacle: '平台时间线异常',
    mustHappen: ['许舟核对退款操作'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['许舟'],
    threads: ['异常退款'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
    readerIntent: { purpose: 'release', payoff: '读者看到罚单被撤销' },
  }
}

test('Fanqie profile guides soft review and publish candidates preserve unknowns and conflicts', async () => {
  const model = new FakeModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-fanqie-publish-'))
  try {
    await init(dir, true, model.baseUrl)
    const profile = json<{ verifiedOn: string; reviewFocus: string[] }>((await runCli(dir, ['platform', 'show', 'fanqie', '--json'])).stdout)
    assert.equal(profile.verifiedOn, '2026-10-29')
    assert.ok(profile.reviewFocus.length > 0)
    await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '许舟', status: 'alive', introducedIn: 1 }] })}\n`)
    await savePlanDraft(dir, 'story', {
      audience: '偏好及时反馈的番茄读者',
      genre: '都市脑洞',
      coreFantasy: '外卖员能把每张配送单退回十分钟前',
      uniqueSellingPoint: '回退只能改变行动，不能抹掉平台记录',
      emotionalPromise: '小人物用证据让制造退单的人承担责任',
      protagonistDesire: '许舟想保住工作并查清异常退款',
    }, { provenance: 'author' })
    await approvePlan(dir, 'story')
    const report = await runEffectReview(dir, 1, contract(), '许舟撤销了罚单。', await loadModelConfig(dir), new AbortController().signal)
    assert.equal(report.passed, true)
    const prompt = JSON.stringify(model.requests[0])
    assert.ok(prompt.includes('2026-10-29'))
    assert.ok(prompt.includes('软效果维度'))
    assert.ok(prompt.includes('不是平台算法'))

    const built = await runCli(dir, ['publish', 'build', '--json'])
    assert.equal(built.code, 0, built.stdout + built.stderr)
    const first = json<{
      path: string
      document: {
        fields: { title: { value: string; status: string }; targetAudience: { status: string }; synopsis: { status: string; candidate: string } }
        pendingPlatform: string[]
      }
      validation: { fail: string[]; warn: string[] }
    }>(built.stdout)
    assert.equal(first.document.fields.title.status, 'confirmed')
    assert.equal(first.document.fields.targetAudience.status, 'pending')
    assert.equal(first.document.fields.synopsis.status, 'suggested')
    assert.ok(first.document.fields.synopsis.candidate.includes('回退只能改变行动'))
    assert.ok(first.document.pendingPlatform.length > 0)
    assert.equal(first.validation.fail.length, 0)
    assert.ok(first.validation.warn.length > 0)

    const second = json<{ path: string }>((await runCli(dir, ['publish', 'build', '--json'])).stdout)
    assert.equal(second.path, first.path)
    const original = await readFile(first.path, 'utf8')
    await savePlanDraft(dir, 'story', {
      audience: '偏好及时反馈的番茄读者',
      genre: '都市脑洞',
      coreFantasy: '外卖员能把每张配送单退回十分钟前',
      uniqueSellingPoint: '回退只能改变行动，不能抹掉平台记录',
      emotionalPromise: '小人物用证据让制造退单的人承担更公开的代价',
      protagonistDesire: '许舟想保住工作并查清异常退款',
    }, { provenance: 'author' })
    await approvePlan(dir, 'story')
    const changed = json<{ path: string }>((await runCli(dir, ['publish', 'build', '--json'])).stdout)
    assert.notEqual(changed.path, first.path)
    assert.equal(await readFile(first.path, 'utf8'), original)

    const validated = await runCli(dir, ['publish', 'validate', first.path, '--json'])
    assert.equal(validated.code, 0, validated.stdout + validated.stderr)
    assert.equal(json<{ fail: string[] }>(validated.stdout).fail.length, 0)
    assert.equal((await loadProject(dir)).platform, 'fanqie')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
