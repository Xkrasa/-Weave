import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject, loadModelConfig } from '../src/core/project.ts'
import { runEffectReview } from '../src/core/effect-review.ts'
import {
  loadExpressionLintConfig,
  runExpressionLint,
  type ExpressionLintConfig,
} from '../src/core/expression-lint.ts'
import type { ChapterContract } from '../src/core/types.ts'

function contract(overrides: Record<string, unknown> = {}): ChapterContract {
  return {
    chapter: 1,
    title: '比对',
    pov: '林岚',
    time: '第一夜',
    location: '档案室',
    openingState: '林岚进入档案室',
    endingState: '她比对出编号',
    goal: '核对编号',
    obstacle: '印章模糊',
    mustHappen: ['林岚比对编号'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: ['账本'],
    targetWords: 800,
    previousLink: '开篇',
    nextLink: '继续',
    readerIntent: { purpose: 'release', payoff: '读者看清编号如何被比对出来' },
    sceneTypes: ['archive'],
    ...overrides,
  } as ChapterContract
}

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
        const text = JSON.stringify({ summary: '已完成语义审查。', findings: [] })
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

test('expression lint supports specific, density and repeated-opening rules with context limits', () => {
  const config: ExpressionLintConfig = {
    schemaVersion: 1,
    maxFindings: 3,
    rules: [
      { id: 'not-is', version: 1, enabled: true, kind: 'not-is-comparison', severity: 'info', message: '否定翻转套式' },
      {
        id: 'cliche', version: 2, enabled: true, kind: 'density', severity: 'warning', message: '套话密度过高',
        phrases: ['仿佛', '微微'], minHits: 2, perKilo: 1,
        scope: { purposes: ['release'], sceneTypes: ['archive'] },
      },
      { id: 'opening', version: 1, enabled: true, kind: 'paragraph-start', severity: 'info', message: '段首重复', prefixLength: 1, minParagraphs: 2 },
      { id: 'disabled', version: 1, enabled: false, kind: 'literal', severity: 'warning', message: '不应出现', phrases: ['仿佛'] },
    ],
  }
  const draft = [
    '不是账本缺了一页，而是有人换掉了它。',
    '“不是我不去，而是路太远。”她解释。',
    '仿佛有人来过，林岚微微停顿。',
    '他放下杯子。',
    '他拿起账本。',
  ].join('\n\n')

  const findings = runExpressionLint(contract(), draft, config)
  assert.equal(findings.length, 3)
  assert.ok(findings.every(finding => finding.severity === 'warning' || finding.severity === 'info'))
  assert.equal(findings.find(finding => finding.ruleId === 'not-is')?.quote, '不是账本缺了一页，而是有人换掉了它。')
  assert.equal(findings.find(finding => finding.ruleId === 'cliche')?.ruleVersion, 2)
  assert.ok(findings.find(finding => finding.ruleId === 'opening')?.quote.includes('他放下杯子'))
  assert.equal(findings.some(finding => finding.ruleId === 'disabled'), false)
  assert.equal(findings.some(finding => finding.quote.includes('不是我不去')), false)

  const wrongPurpose = runExpressionLint(contract({ readerIntent: { purpose: 'reveal', payoff: '读者发现编号' } }), draft, config)
  assert.equal(wrongPurpose.some(finding => finding.ruleId === 'cliche'), false)
  assert.equal(runExpressionLint(contract(), draft, { ...config, maxFindings: 2 }).length, 2)
})

test('effect review carries lint rule identity and soft evidence into the report', async () => {
  const model = new FakeModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-expression-effect-'))
  try {
    await initProject(dir, { title: '表达审查', model: 'fake', baseUrl: model.baseUrl, workflowVersion: 2 })
    const draft = '不是印章模糊，而是编号被人换过。'
    const report = await runEffectReview(dir, 1, contract(), draft, await loadModelConfig(dir), new AbortController().signal)
    const finding = report.findings.find(item => item.ruleId === 'not-is-comparison')
    assert.ok(finding)
    assert.equal(finding.severity, 'info')
    assert.equal(finding.source, 'lint')
    assert.equal(finding.ruleVersion, 1)
    assert.equal(finding.quote, draft)
    assert.equal(finding.evidence?.sourceId, 'draft:1')
    assert.equal(finding.evidence?.occurrence, 1)
    assert.equal(report.passed, true)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown lint configuration fails explicitly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-expression-config-'))
  try {
    await initProject(dir, { title: '错误规则', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1', workflowVersion: 2 })
    await writeFile(path.join(dir, 'canon', 'expression-lint.json'), `${JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'bad', version: 1, enabled: true, kind: 'literal', severity: 'warning', message: '测试', phrases: ['仿佛'], unexpected: true }],
    })}\n`)
    await assert.rejects(loadExpressionLintConfig(dir), /unexpected/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
