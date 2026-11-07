import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeContract } from '../src/core/contract.ts'
import { proposeSegmentPlan, segmentPlanHash, type ChapterSegment } from '../src/core/segments.ts'
import { checkSegment } from '../src/core/segment-checks.ts'
import { mergeSegmentTexts } from '../src/core/writing.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')

interface Result { code: number; stdout: string; stderr: string }

function runCli(cwd: string, args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

interface SegmentView {
  segmentId: string
  index: number
  beatIds: string[]
  goal: string
  entryState: string
  exitState: string
  targetWords: number
  mustNotHappen: string[]
  status: ChapterSegment['status']
}

interface PlanPayload {
  planHash: string
  contractHash: string
  beatContentHash: string
  targetWords: number
  segments: SegmentView[]
  approvedAt?: string
  approvedBy?: string
}

interface ShowPayload {
  status: string
  plan?: PlanPayload
}

const BEATS = [
  { goal: '许舟核对订单时间线', obstacle: '平台显示提前退款', turn: '顾客端保存了另一份时间', endingState: '罚单进入人工复核' },
  { goal: '许舟追查退款账号', obstacle: '客服推诿', turn: '发现退款来自另一个账号', endingState: '锁定可疑账号' },
  { goal: '许舟拿到顾客证词', obstacle: '顾客拒绝配合', turn: '顾客最终提供截图', endingState: '证据链补全' },
  { goal: '许舟提交申诉', obstacle: '平台初审驳回', turn: '找到时间戳矛盾', endingState: '罚单撤销' },
]

async function setupProject(dir: string, targetWords = 4000, baseUrl = 'http://127.0.0.1:1/v1'): Promise<void> {
  const init = await runCli(dir, [
    'init', '.', '--title', '分段实验', '--model', 'fake', '--base-url', baseUrl, '--workflow', 'p0',
  ])
  assert.equal(init.code, 0, init.stderr)
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '许舟', status: 'alive', introducedIn: 1 }] })}\n`)
  await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
    chapter: 1,
    title: '退单',
    pov: '许舟',
    time: '午高峰',
    location: '站点',
    openingState: '许舟收到异常罚单',
    endingState: '罚单被撤销',
    goal: '证明罚单错误',
    obstacle: '平台记录与顾客记录不一致',
    mustHappen: ['许舟核对订单'],
    mayHappen: [],
    mustNotHappen: ['平台主动道歉'],
    characters: ['许舟'],
    threads: ['异常退款'],
    targetWords,
    previousLink: '开篇',
    nextLink: '继续追查',
  }, null, 2)}\n`)
  const checked = await runCli(dir, ['contract', 'check', '1', '--json'])
  assert.equal(checked.code, 0, checked.stderr)
}

async function approveBeats(dir: string, beats = BEATS): Promise<void> {
  const file = path.join(dir, 'beats.json')
  await writeFile(file, `${JSON.stringify({ beats }, null, 2)}\n`)
  const set = await runCli(dir, ['beats', 'set', '1', '--file', file, '--json'])
  assert.equal(set.code, 0, set.stderr)
  const approve = await runCli(dir, ['beats', 'approve', '1', '--json'])
  assert.equal(approve.code, 0, approve.stderr)
}

function planPayload(result: Result): PlanPayload {
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout) as PlanPayload
}

test('segments plan requires approved beats and produces a deterministic two-segment proposal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-segments-'))
  try {
    await setupProject(dir)
    const withoutBeats = await runCli(dir, ['segments', 'plan', '1'])
    assert.equal(withoutBeats.code, 4)
    assert.match(withoutBeats.stderr, /尚未批准/)
    assert.equal(await readFile(path.join(dir, '.weave', 'segments', 'chapter-001', 'plan.json'), 'utf8').catch(() => null), null)

    await approveBeats(dir)
    const first = planPayload(await runCli(dir, ['segments', 'plan', '1', '--json']))
    assert.equal(first.segments.length, 2)
    assert.deepEqual(first.segments.map(segment => segment.segmentId), ['seg-01', 'seg-02'])
    assert.deepEqual(first.segments.map(segment => segment.beatIds), [['beat-01', 'beat-02'], ['beat-03', 'beat-04']])
    assert.equal(first.segments[0]!.entryState, '许舟收到异常罚单')
    assert.equal(first.segments[1]!.exitState, '罚单被撤销')
    assert.equal(first.segments[0]!.exitState, '锁定可疑账号')
    assert.equal(first.segments[1]!.entryState, '锁定可疑账号')
    assert.equal(first.segments.reduce((sum, segment) => sum + segment.targetWords, 0), 4000)
    assert.deepEqual(first.segments[0]!.mustNotHappen, ['平台主动道歉'])
    assert.ok(first.segments.every(segment => segment.status === 'planned'))

    const second = planPayload(await runCli(dir, ['segments', 'plan', '1', '--json']))
    assert.equal(second.planHash, first.planHash)
    const stored = JSON.parse(await readFile(path.join(dir, '.weave', 'segments', 'chapter-001', 'plan.json'), 'utf8')) as PlanPayload
    assert.equal(stored.planHash, segmentPlanHash({ chapter: 1, targetWords: stored.targetWords, segments: stored.segments }))
    assert.equal(stored.approvedAt, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('approval binds contract and beats, and later changes invalidate it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-segments-approval-'))
  try {
    await setupProject(dir)
    await approveBeats(dir)
    planPayload(await runCli(dir, ['segments', 'plan', '1', '--json']))

    const approved = await runCli(dir, ['segments', 'approve', '1', '--json'])
    assert.equal(approved.code, 0, approved.stderr)
    const approvedPlan = JSON.parse(approved.stdout) as PlanPayload
    assert.equal(approvedPlan.approvedBy, 'author')
    const shown = JSON.parse((await runCli(dir, ['segments', 'show', '1', '--json'])).stdout) as ShowPayload
    assert.equal(shown.status, 'approved')

    const contractFile = path.join(dir, 'outlines', 'chapters', '001.json')
    const contract = JSON.parse(await readFile(contractFile, 'utf8')) as Record<string, unknown>
    contract.goal = '证明罚单错误并追回退款'
    await writeFile(contractFile, `${JSON.stringify(contract, null, 2)}\n`)
    const modified = JSON.parse((await runCli(dir, ['segments', 'show', '1', '--json'])).stdout) as ShowPayload
    assert.equal(modified.status, 'modified')

    const reapproved = await runCli(dir, ['segments', 'approve', '1', '--json'])
    assert.equal(reapproved.code, 0, reapproved.stderr)
    assert.equal(JSON.parse(reapproved.stdout).contractHash !== approvedPlan.contractHash, true)

    await approveBeats(dir, BEATS.map(beat => ({ ...beat })))
    const beatsFile = path.join(dir, 'plans', 'beats', '001.json')
    const candidate = JSON.parse(await readFile(beatsFile, 'utf8')) as { beats: Array<Record<string, unknown>> }
    candidate.beats[0]!.goal = '许舟重新核对订单时间线'
    await writeFile(beatsFile, `${JSON.stringify(candidate, null, 2)}\n`)
    assert.equal((await runCli(dir, ['beats', 'approve', '1', '--json'])).code, 0)
    const beatsChanged = JSON.parse((await runCli(dir, ['segments', 'show', '1', '--json'])).stdout) as ShowPayload
    assert.equal(beatsChanged.status, 'modified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('segments set rejects unknown beats and accepts an author-edited plan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-segments-set-'))
  try {
    await setupProject(dir)
    await approveBeats(dir)

    const invalid = path.join(dir, 'invalid-plan.json')
    await writeFile(invalid, `${JSON.stringify({
      targetWords: 4000,
      segments: [
        { beatIds: ['beat-01'], goal: '开头', entryState: '许舟收到异常罚单', exitState: '锁定可疑账号', targetWords: 4000, mustNotHappen: [] },
        { beatIds: ['beat-99'], goal: '结尾', entryState: '锁定可疑账号', exitState: '罚单被撤销', targetWords: 0, mustNotHappen: [] },
      ],
    }, null, 2)}\n`)
    const rejected = await runCli(dir, ['segments', 'set', '1', '--file', invalid])
    assert.notEqual(rejected.code, 0)
    assert.match(rejected.stderr, /beat-99|targetWords/)

    const edited = path.join(dir, 'edited-plan.json')
    await writeFile(edited, `${JSON.stringify({
      targetWords: 4000,
      segments: [
        { beatIds: ['beat-01', 'beat-02', 'beat-03'], goal: '核对与追查', entryState: '许舟收到异常罚单', exitState: '证据链补全', targetWords: 2900, mustNotHappen: [] },
        { beatIds: ['beat-04'], goal: '提交申诉', entryState: '证据链补全', exitState: '罚单被撤销', targetWords: 1100, mustNotHappen: ['平台主动道歉'] },
      ],
    }, null, 2)}\n`)
    const saved = planPayload(await runCli(dir, ['segments', 'set', '1', '--file', edited, '--json']))
    assert.equal(saved.segments.length, 2)
    assert.deepEqual(saved.segments.map(segment => segment.beatIds), [['beat-01', 'beat-02', 'beat-03'], ['beat-04']])
    assert.equal(saved.segments[0]!.targetWords, 2900)
    const view = JSON.parse((await runCli(dir, ['segments', 'show', '1', '--json'])).stdout) as ShowPayload
    assert.equal(view.status, 'draft')
    assert.equal((await runCli(dir, ['segments', 'approve', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['segments', 'skip', '1', '--json'])).code, 0)
    const skipped = JSON.parse((await runCli(dir, ['segments', 'show', '1', '--json'])).stdout) as ShowPayload
    assert.equal(skipped.status, 'skipped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('author segment hints group beats and target weights still sum to the contract target', () => {
  const contract = normalizeContract({
    chapter: 1,
    title: '退单',
    pov: '许舟',
    time: '午高峰',
    location: '站点',
    openingState: '许舟收到异常罚单',
    endingState: '罚单被撤销',
    goal: '证明罚单错误',
    mustHappen: [],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['许舟'],
    threads: [],
    targetWords: 4000,
    previousLink: '开篇',
    nextLink: '继续追查',
  })
  const beats = [
    { goal: '核对', obstacle: '阻力', turn: '反转', endingState: '复核', segmentId: 'seg-01', targetWords: 1000 },
    { goal: '追查', obstacle: '阻力', turn: '转折', endingState: '锁定', segmentId: 'seg-01', targetWords: 800 },
    { goal: '申诉', obstacle: '阻力', turn: '摊牌', endingState: '撤销', segmentId: 'seg-02', targetWords: 1200 },
  ]
  const proposal = proposeSegmentPlan(contract, beats)
  assert.equal(proposal.segments.length, 2)
  assert.equal(proposal.segments.reduce((sum, segment) => sum + segment.targetWords, 0), 4000)
  assert.equal(proposal.segments[0]!.entryState, contract.openingState)
  assert.equal(proposal.segments[1]!.exitState, contract.endingState)
  assert.equal(proposal.segments[1]!.entryState, proposal.segments[0]!.exitState)
})

test('segment merge drops a 40+ character boundary overlap and keeps one separator', () => {
  const overlap = '许舟把订单截图推到唐姨面前，唐姨盯着那行时间看了很久，手指在桌面上敲了两下，又把手机翻扣在桌面上。'
  assert.equal([...overlap].length >= 40, true)
  const first = `开头。${overlap}`
  const second = `${overlap}然后她说：这不是我的账号。`
  const merged = mergeSegmentTexts([first, second])
  assert.equal(merged, `开头。${overlap}\n\n然后她说：这不是我的账号。`)
})

function repeatTo(text: string, minChars: number): string {
  let out = ''
  while ([...out].length < minChars) out += text
  return out
}

test('segment checks retry hard failures and trim boundary overlap without blocking', () => {
  const base = {
    targetWords: 2_000,
    previousTail: '',
    mustNotHappen: ['平台主动道歉'],
    pov: '许舟',
    goal: '核对订单',
    exitState: '罚单被撤销',
  }
  const short = checkSegment({ ...base, text: '许舟看了一眼。' })
  assert.equal(short.passed, false)
  assert.ok(short.retryReasons.some(reason => reason.includes('过短')))

  const banned = checkSegment({
    ...base,
    text: repeatTo('许舟核对订单时间线，平台客服推诿，他把两份记录摆在桌上。', 1_900) + '平台主动道歉。',
  })
  assert.equal(banned.passed, false)
  assert.ok(banned.retryReasons.some(reason => reason.includes('禁止项')))

  const overlap = '许舟把订单截图推到唐姨面前，唐姨盯着那行时间看了很久，手指在桌面上敲了两下，又把手机翻扣在桌面上。'
  const withOverlap = `${overlap}${repeatTo('她终于承认退款不是自己操作的。', 1_900)}`
  const trimmed = checkSegment({ ...base, previousTail: `前文结尾。${overlap}`, text: withOverlap })
  assert.ok(trimmed.trimmedChars >= 40)
  assert.equal(trimmed.text.startsWith('她终于承认'), true)
  assert.equal(trimmed.warnings.some(warning => warning.includes('重复')), true)
  assert.equal(trimmed.passed, true)
})

class FakeResumableModel {
  readonly requests: Array<Record<string, unknown>> = []
  readonly calls: Array<{ index: number; text: string }> = []
  baseUrl = ''
  private resumableCounter = 0
  private readonly server: Server

  constructor() {
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        this.requests.push(parsed)
        this.resumableCounter += 1
        const index = this.resumableCounter
        const text = index === 1
          ? repeatTo('许舟把订单截图推到唐姨面前，唐姨盯着那行时间看了很久。', 1_900)
          : index <= 4
            ? '许舟看了一眼，没有说话。'
            : repeatTo('唐姨终于承认那笔退款不是她操作的，许舟把两段记录按时间排好。', 1_900)
        this.calls.push({ index, text })
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

test('a failed segment stops the chapter and resume starts from the first unfinished segment', async () => {
  const model = new FakeResumableModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-segments-resume-'))
  try {
    await setupProject(dir, 4000, model.baseUrl)
    await approveBeats(dir)
    planPayload(await runCli(dir, ['segments', 'plan', '1', '--json']))
    assert.equal((await runCli(dir, ['segments', 'approve', '1', '--json'])).code, 0)

    const failed = await runCli(dir, ['write', '1', '--strategy', 'segmented', '--json'])
    assert.notEqual(failed.code, 0)
    const failedPayload = JSON.parse(failed.stdout) as { error: { message: string } }
    assert.match(failedPayload.error.message, /未通过校验/)
    assert.equal(model.calls.length, 4)
    assert.equal(model.calls.filter(call => [...call.text].length < 400).length, 3)

    const runsDir = path.join(dir, '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).filter(name => name.endsWith('.json')).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as {
        runId: string
        status: string
        draftingStrategy?: string
        partialPath?: string
        segments?: Array<{ segmentId: string; status: string; contentHash?: string; attempts?: number }>
      }))
    const failedRun = runs.find(run => run.status === 'failed' && run.draftingStrategy === 'segmented')
    assert.ok(failedRun)
    assert.deepEqual(failedRun!.segments?.map(segment => segment.segmentId), ['seg-01', 'seg-02'])
    assert.equal(failedRun!.segments![1]!.status, 'failed')
    assert.equal(failedRun!.segments![1]!.attempts, 3)
    const firstHash = failedRun!.segments![0]!.contentHash

    const plan = JSON.parse(await readFile(path.join(dir, '.weave', 'segments', 'chapter-001', 'plan.json'), 'utf8')) as {
      segments: Array<{ segmentId: string; status: string; contentHash?: string }>
    }
    assert.equal(plan.segments[0]!.status, 'draft')
    assert.equal(plan.segments[1]!.status, 'failed')

    const resumed = await runCli(dir, ['write', '1', '--strategy', 'segmented', '--resume', failedRun!.runId, '--json'])
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr)
    const resumedPayload = JSON.parse(resumed.stdout) as {
      runId: string
      segments: Array<{ segmentId: string; contentHash?: string }>
    }
    assert.deepEqual(resumedPayload.segments.map(segment => segment.segmentId), ['seg-01', 'seg-02'])
    assert.equal(resumedPayload.segments[0]!.contentHash, firstHash, 'completed segments are not regenerated')
    assert.equal(model.calls.length, 5)
    assert.equal(model.calls[4]!.index, 5)

    const storedNewRun = JSON.parse(await readFile(path.join(runsDir, `${resumedPayload.runId}.json`), 'utf8')) as {
      recovery?: { strategy: string; fromRunId: string; completedSegments?: string[] }
    }
    assert.equal(storedNewRun.recovery?.strategy, 'resume-segments')
    assert.equal(storedNewRun.recovery?.fromRunId, failedRun!.runId)
    assert.deepEqual(storedNewRun.recovery?.completedSegments, ['seg-01'])

    const oldRun = JSON.parse(await readFile(path.join(runsDir, `${failedRun!.runId}.json`), 'utf8')) as { status: string }
    assert.equal(oldRun.status, 'failed', 'resume must not rewrite the old run terminal state')

    const draft = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.ok(draft.includes('许舟把订单截图推到唐姨面前'))
    assert.ok(draft.includes('唐姨终于承认那笔退款不是她操作的'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

class FakeWritingModel {
  readonly requests: Array<Record<string, unknown>> = []
  baseUrl = ''
  private server: Server
  private counter = 0

  constructor() {
    this.server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        this.requests.push(parsed)
        this.counter += 1
        const text = this.counter === 1
          ? repeatTo('许舟把订单截图推到唐姨面前，唐姨盯着那行时间看了很久，手指在桌面上敲了两下。她说平台记录不会错，可截图上的秒数明明比她说的早。许舟没有争辩，只把另一张退款记录铺在旁边，让她先看清账号尾号。', 1_900)
          : repeatTo('唐姨终于承认那笔退款不是她操作的。许舟把两段记录按时间排好，发现中间少了整整七分钟。他把缺口圈出来，平台客服沉默了几秒，才说需要人工复核。唐姨把手机收进包里，起身时又回头看了一眼那张截图。', 1_900)
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

test('segmented writing streams each planned segment, merges one draft, and records segment usage', async () => {
  const model = new FakeWritingModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-segments-write-'))
  try {
    await setupProject(dir, 4000, model.baseUrl)
    await approveBeats(dir)
    planPayload(await runCli(dir, ['segments', 'plan', '1', '--json']))

    const blocked = await runCli(dir, ['write', '1', '--strategy', 'segmented', '--json'])
    assert.equal(blocked.code, 4)
    assert.equal(model.requests.length, 0, 'an unapproved segment plan must not reach the writer')

    assert.equal((await runCli(dir, ['segments', 'approve', '1', '--json'])).code, 0)
    const written = await runCli(dir, ['write', '1', '--strategy', 'segmented', '--json'])
    assert.equal(written.code, 0, written.stdout + written.stderr)
    const payload = JSON.parse(written.stdout) as {
      draftingStrategy: string
      segments: Array<{ segmentId: string; status: string; contentHash?: string }>
      included: string[]
    }
    assert.equal(payload.draftingStrategy, 'segmented')
    assert.deepEqual(payload.segments.map(segment => segment.segmentId), ['seg-01', 'seg-02'])
    assert.ok(payload.segments.every(segment => segment.status === 'draft' && segment.contentHash))
    assert.equal(model.requests.length, 2)
    assert.match(JSON.stringify(model.requests[0]!.messages), /本段任务（第 1\/2 段/)

    const draft = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.ok(draft.includes('许舟把订单截图推到唐姨面前'))
    assert.ok(draft.includes('唐姨终于承认那笔退款不是她操作的'))
    assert.equal(draft.includes('\n\n\n'), false)

    const stored = JSON.parse(await readFile(path.join(dir, '.weave', 'segments', 'chapter-001', 'plan.json'), 'utf8')) as {
      segments: Array<{ segmentId: string; status: string; textPath?: string; contentHash?: string }>
      planHash: string
    }
    assert.equal(stored.planHash, segmentPlanHash({ chapter: 1, targetWords: 4000, segments: stored.segments as ChapterSegment[] }))
    assert.ok(stored.segments.every(segment => segment.status === 'draft' && segment.textPath === `${segment.segmentId}.md`))
    for (const segment of stored.segments) {
      assert.ok((await readFile(path.join(dir, '.weave', 'segments', 'chapter-001', segment.textPath!), 'utf8')).length > 0)
    }

    const runsDir = path.join(dir, '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).filter(name => name.endsWith('.json')).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as {
        status: string
        draftingStrategy?: string
        segments?: Array<{ segmentId: string; contentHash?: string }>
        usage?: { totalTokens?: number }
      }))
    const writingRuns = runs.filter(run => run.draftingStrategy === 'segmented')
    assert.equal(writingRuns.length, 1)
    assert.equal(writingRuns[0]!.status, 'completed')
    assert.equal(writingRuns[0]!.segments?.length, 2)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
