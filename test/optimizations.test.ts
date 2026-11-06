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

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
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
        const text = this.texts.shift() ?? '林岚把账本按在桌角。'
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

test('long chapter continuation preserves prose mode when tail excerpt has non-zero byte offset', async () => {
  const p1 = '林岚站在货架前，逐页翻检那些被海水浸透的货运单，手指在粗糙的纸页上留下深色印痕。'.repeat(18)
  const p2 = '她把最后三张盖有港务局红印的底单折成方块，塞进大衣内侧暗袋，转身推开铁门。'.repeat(8)
  const tail1 = '林岚在走廊尽头停下脚步，听见铁梯下方传来钥匙碰撞的脆响，紧接着是皮靴踩过积水铁板的脚步声，一步一步逼近二楼拐角，连走廊顶上的旧灯泡都跟着微微晃动，手电筒的白光扫过铁栏杆。'.repeat(2)
  const tail2 = '她握紧暗袋里的底单，闪身退进三号货柜背后的窄缝里，屏住呼吸贴紧冰凉的铁壁，用指尖抵住衣领下那枚铜扣，等待铁门被人从外面推开的那一瞬间，目光死死锁住门槛下的水影。'.repeat(2)
  const longChapter1 = [p1, p2, tail1, tail2].join('\n\n')
  assert.ok([...longChapter1].length > 1200, 'chapter 1 must exceed the 800-char tailExcerpt window')

  const extraction = JSON.stringify({
    summary: '林岚藏起底单并躲避来人',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚藏起底单并躲进货柜窄缝',
      participants: ['林岚'],
      location: '海港码头',
      storyTime: '第一夜',
      payload: {},
      evidence: [
        { quote: tail1, occurrence: 1 },
        { quote: tail2, occurrence: 1 },
      ],
    }],
    timeline: [{
      eventId: 'e1',
      recordId: 'r1',
      summary: '林岚躲进货柜窄缝',
      dayOffset: 0,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote: tail2, occurrence: 1 }],
    }],
    facts: [{
      factId: 'f-loc',
      subject: '林岚',
      predicate: 'location',
      object: '三号货柜窄缝',
      validFromChapter: 1,
      validToChapter: null,
      sourceRecordId: 'r1',
      origin: 'derived',
      supersedes: null,
      confidence: 0.95,
      evidence: [{ quote: tail2, occurrence: 1 }],
    }],
    beliefs: [],
    loops: [{
      loopId: 'loop-key',
      kind: 'plant',
      summary: '铁梯下持钥匙来人的身份',
      targetFromChapter: 2,
      targetToChapter: 3,
      relatedEntities: ['林岚'],
      evidence: [{ quote: tail1, occurrence: 1 }],
    }],
  })
  const audit = JSON.stringify({
    summary: '无遗漏',
    missed: [],
  })
  const review = JSON.stringify({
    summary: '通过',
    findings: [],
  })

  const model = new FakeModel([longChapter1, extraction, audit, review, '第二章正文。'])
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-opt-cont-'))
  try {
    assert.equal(
      (await runCli(dir, ['init', '.', '--title', '长章测试', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p05'])).code,
      0,
    )
    await writeFile(
      path.join(dir, 'canon', 'characters.json'),
      `${JSON.stringify({
        characters: [{
          name: '林岚',
          status: 'alive',
          introducedIn: 1,
          role: '前港务局核账员',
          traits: ['警觉', '记性极佳'],
          voice: '短句利落，极少感叹',
          desire: '查清父亲沉船旧案',
        }],
      }, null, 2)}\n`,
    )
    await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
      chapter: 1,
      title: '暗袋',
      pov: '林岚',
      time: '第一夜',
      location: '海港码头',
      openingState: '林岚在仓库查账',
      endingState: '她躲进三号货柜窄缝',
      goal: '带走底单',
      obstacle: '有人下楼',
      mustHappen: ['林岚藏起底单'],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['林岚'],
      threads: ['底单'],
      targetWords: 800,
      previousLink: '开篇',
      nextLink: '查清来人',
    }, null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['write', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await writeFile(path.join(dir, 'outlines', 'chapters', '002.json'), `${JSON.stringify({
      chapter: 2,
      title: '窄缝',
      pov: '林岚',
      time: '第二夜',
      location: '海港三号仓',
      openingState: '林岚躲在货柜后',
      endingState: '她看清来人',
      goal: '确认来人身份',
      obstacle: '视线受阻',
      mustHappen: ['林岚看清来人'],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['林岚'],
      threads: ['底单'],
      targetWords: 800,
      previousLink: '承接铁梯脚步声',
      nextLink: '继续',
    }, null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '2', '--json'])).code, 0)

    const written = await runCli(dir, ['write', '2', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const payload = parseJson<{ included: string[] }>(written.stdout)
    assert.ok(
      payload.included.includes('finalized-history:continuation:1'),
      `expected prose continuation, got: ${JSON.stringify(payload.included)}`,
    )

    const body = JSON.stringify(model.requests[4])
    assert.ok(body.includes(tail2), 'tail excerpt prose must be included')
    assert.ok(body.includes('未解线索（原文）'), 'observed open-loop evidence must reach limited POV memory')
    assert.equal(body.includes('铁梯下持钥匙来人的身份'), false, 'model-authored loop summary must not enter limited POV')
    assert.ok(body.includes('短句利落，极少感叹'), 'character voice field must reach prompt')
    assert.equal(body.includes('sourceContentHash'), false, 'raw evidence hashes should be stripped from POV knowledge prompt')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('searchBook suppresses single-character stopword noise and ranks multi-char hits first', async () => {
  const model = new FakeModel(['占位'])
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-opt-search-'))
  try {
    assert.equal(
      (await runCli(dir, ['init', '.', '--title', '检索测试', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code,
      0,
    )
    await writeFile(
      path.join(dir, 'canon', 'characters.json'),
      `${JSON.stringify({ characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }] }, null, 2)}\n`,
    )
    const chapters = [
      '她把铁盒放在桌下，里头只有半截火柴和一张旧船票。',
      '老陈在门房登记了看门人换班的时间表，每晚子时交接钥匙。',
    ]
    for (const [idx, text] of chapters.entries()) {
      const ch = idx + 1
      const stem = String(ch).padStart(3, '0')
      await writeFile(path.join(dir, 'outlines', 'chapters', `${stem}.json`), `${JSON.stringify({
        chapter: ch,
        title: `第${ch}章`,
        pov: '林岚',
        time: `第${ch}日`,
        location: '码头',
        openingState: '开始',
        endingState: '结束',
        goal: '调查',
        obstacle: '门锁生锈',
        mustHappen: ['调查'],
        mayHappen: [],
        mustNotHappen: [],
        characters: ['林岚'],
        threads: ['主线'],
        targetWords: 800,
        previousLink: '承上',
        nextLink: '启下',
      }, null, 2)}\n`)
      assert.equal((await runCli(dir, ['contract', 'check', String(ch), '--json'])).code, 0)
      await writeFile(path.join(dir, 'chapters', 'drafts', `${stem}.md`), `${text}\n`)
      assert.equal((await runCli(dir, ['finalize', String(ch), '--json'])).code, 0)
    }

    const search = await runCli(dir, ['search', '确认看门人什么时候换班', '--json'])
    assert.equal(search.code, 0, search.stderr)
    const parsed = parseJson<{ results: Array<{ chapter: number; text: string }> }>(search.stdout)
    assert.equal(parsed.results.length, 1, `irrelevant chapter with only stopword matches must be excluded: ${JSON.stringify(parsed.results)}`)
    assert.equal(parsed.results[0]?.chapter, 2)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('effect-review detects mid-chapter environment blocks and integrates with revise and ignore', async () => {
  const envParagraph = '海风裹着浓重的雾气从海面涌上来，天色在云层下渐渐暗成铁灰，路灯在细雨与水汽里投下摇晃的阴影。'
  const draft = [
    '林岚推开档案室的木门，把湿透的账本按在桌角。',
    envParagraph,
    '她抽出一张空白登记表，对准印章缺口比对编号。',
  ].join('\n\n')

  const effectJson = JSON.stringify({
    summary: '中段有纯环境铺陈拖慢节奏。',
    findings: [{
      dimension: '人物声音',
      severity: 'warning',
      description: '第三段动作稍显平淡',
      quote: '她抽出一张空白登记表，对准印章缺口比对编号。',
      occurrence: 1,
    }],
  })
  const revisionJson = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '窗外海风撞响铁皮水落管，林岚顾不上擦干袖口，直接翻到账本第三页。',
      findingIds: ['e-lint-1'],
    }],
  })

  const model = new FakeModel([effectJson, revisionJson])
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-opt-effect-'))
  try {
    assert.equal(
      (await runCli(dir, ['init', '.', '--title', '效果修稿测试', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])).code,
      0,
    )
    await writeFile(
      path.join(dir, 'canon', 'characters.json'),
      `${JSON.stringify({ characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }] }, null, 2)}\n`,
    )
    await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
      chapter: 1,
      title: '比对',
      pov: '林岚',
      time: '第一夜',
      location: '档案室',
      openingState: '林岚进入档案室',
      endingState: '她比对出编号',
      goal: '核对印章缺口',
      obstacle: '印章模糊',
      mustHappen: ['林岚比对编号'],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['林岚'],
      threads: ['账本'],
      targetWords: 800,
      previousLink: '开篇',
      nextLink: '继续',
    }, null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), `${draft}\n`)

    const reviewed = await runCli(dir, ['effect-review', '1', '--json'])
    assert.equal(reviewed.code, 0, reviewed.stderr)
    const report = parseJson<{
      findings: Array<{ findingId: string; dimension: string; source: string; quote?: string }>
    }>(reviewed.stdout)
    const envFinding = report.findings.find(item => item.source === 'lint' && item.dimension === '环境与描写')
    assert.ok(envFinding, `expected mid-chapter environment lint finding, got: ${JSON.stringify(report.findings)}`)
    assert.equal(envFinding.quote, envParagraph)

    const revised = await runCli(dir, ['revise', '1', '--findings', envFinding.findingId, '--json'])
    assert.equal(revised.code, 0, revised.stderr)
    const revPayload = parseJson<{ candidate: { revisionId: string; paragraphs: Array<{ paragraphId: string }> } }>(revised.stdout)
    assert.equal(revPayload.candidate.paragraphs[0]?.paragraphId, 'p002')

    const ignored = await runCli(dir, ['ignore', '1', '--finding', 'e1', '--reason', '保留此处克制叙述', '--json'])
    assert.equal(ignored.code, 0, ignored.stderr)
    const savedEffect = JSON.parse(await readFile(path.join(dir, '.weave', 'stages', 'effect-review', '001.json'), 'utf8')) as {
      findings: Array<{ findingId: string; status: string; ignoreReason?: string }>
    }
    assert.equal(savedEffect.findings.find(item => item.findingId === envFinding.findingId)?.status, 'applied')
    assert.equal(savedEffect.findings.find(item => item.findingId === 'e1')?.status, 'ignored')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
