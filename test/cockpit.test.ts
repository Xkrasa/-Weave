import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject } from '../src/core/project.ts'
import { saveContract } from '../src/core/contract.ts'
import { saveDraft } from '../src/core/runs.ts'
import { draftHash, resolveEvidence, saveStage } from '../src/core/stages.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import { buildOffsetTable, locateQuote, resolveEvidence as resolveSpan } from '../src/core/text-offsets.ts'
import type { ChapterContract } from '../src/core/types.ts'
import type { ReviewReport, ContentCheckReport } from '../src/core/stage-types.ts'

function contract(): ChapterContract {
  return {
    chapter: 1,
    title: '雾港',
    pov: '林岚',
    time: '第 1 天',
    location: '海港',
    openingState: '林岚带着账本回到海港',
    endingState: '林岚发现缺页',
    goal: '找出账本缺页的原因',
    obstacle: '港务局不肯作证',
    mustHappen: ['林岚发现账本缺页'],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['林岚'],
    threads: ['账本主线'],
    targetWords: 1000,
    previousLink: '开篇',
    nextLink: '继续追查',
  }
}

const REPEATED = '林岚在码头翻开账本。'
const EMOJI = '🙂'
const DRAFT = `${REPEATED}\n\n她发现缺页。${EMOJI}\n\n${REPEATED}\n\n${EMOJI}${REPEATED}`

function nthOccurrence(text: string, needle: string, occurrence: number): number {
  let index = text.indexOf(needle)
  for (let count = 1; count < occurrence; count += 1) {
    index = text.indexOf(needle, index + needle.length)
  }
  return index
}

test('offset table maps UTF-8 bytes to browser offsets for CJK, emoji and combining marks', () => {
  const text = `A${EMOJI}中e\u0301${REPEATED}`
  const table = buildOffsetTable(text)
  assert.equal(table.charToByte(0), 0)
  assert.equal(table.charToByte(1), 1)
  assert.equal(table.charToByte(3), 5, 'emoji takes one 4-byte code point and two UTF-16 units')
  assert.equal(table.byteToChar(5), 3)
  const combiningByte = Buffer.byteLength('A' + EMOJI + '中' + 'e', 'utf8')
  assert.equal(table.charToByte(table.byteToChar(combiningByte)), combiningByte, 'combining mark stays on code-point boundary')
  const quoteStart = text.indexOf(REPEATED)
  assert.equal(table.byteToChar(table.charToByte(quoteStart)), quoteStart)
  assert.equal(table.lineAt(quoteStart), 1)
})

test('evidence resolution uses quote + occurrence and rejects stale byte offsets', () => {
  const table = buildOffsetTable(DRAFT)
  const second = nthOccurrence(DRAFT, REPEATED, 2)
  const span = resolveEvidence(DRAFT, 1, REPEATED, 2)
  const resolved = resolveSpan(DRAFT, span, table)
  assert.equal(resolved.matched, true)
  assert.equal(resolved.charStart, second)
  assert.equal(resolved.charEnd, second + REPEATED.length)
  assert.equal(resolved.line, 5)

  const stale = { ...span, byteStart: span.byteStart + 6, byteEnd: span.byteEnd + 6 }
  const mismatch = resolveSpan(DRAFT, stale, table)
  assert.equal(mismatch.matched, false)
  assert.equal(mismatch.charStart, second, 'the quote occurrence still identifies where the text really is')

  const missing = resolveSpan(DRAFT, { ...span, quote: '这一句已经被作者删掉' }, table)
  assert.equal(missing.matched, false)
  assert.equal(locateQuote(DRAFT, '这一句已经被作者删掉', 1, table).matched, false)
})

test('cockpit returns contract, draft, gates, findings and revisions in one request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-cockpit-'))
  const draft = DRAFT
  await initProject(dir, {
    title: '驾驶舱测试',
    model: 'fake-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    workflowVersion: 2,
  })
  await saveContract(dir, contract())
  await saveDraft(dir, 1, draft)
  const hash = draftHash(draft)

  const evidence = resolveEvidence(draft, 1, REPEATED, 2)
  const review: ReviewReport = {
    schemaVersion: 1,
    chapter: 1,
    draftHash: hash,
    createdAt: new Date().toISOString(),
    extractionHash: 'sha256:test',
    auditHash: 'sha256:test',
    summary: '测试审查',
    findings: [
      {
        findingId: 'f-occurrence',
        dimension: '重复',
        severity: 'blocking',
        description: '同一句重复出现',
        quote: REPEATED,
        evidence,
        status: 'open',
      },
      {
        findingId: 'f-stale',
        dimension: '定位',
        severity: 'warning',
        description: '引文已被修改',
        quote: '这一句已经被作者删掉',
        evidence: { ...evidence, quote: '这一句已经被作者删掉' },
        status: 'open',
      },
    ],
    blockingCount: 1,
    model: 'fake-model',
    passed: false,
  }
  const content: ContentCheckReport = {
    schemaVersion: 1,
    chapter: 1,
    draftHash: hash,
    createdAt: new Date().toISOString(),
    findings: [{ severity: 'warning', code: 'density', message: '重复句过多', quote: REPEATED }],
    stats: { characters: [...draft.replace(/\s/g, '')].length, targetWords: 1000, deviation: 0, duplicateHits: 1 },
    passed: true,
  }
  await saveStage(dir, 'review', 1, review)
  await saveStage(dir, 'content-check', 1, content)

  await mkdir(path.join(dir, '.weave', 'revisions', '001'), { recursive: true })
  await writeFile(path.join(dir, '.weave', 'revisions', '001', 'rev-selection.json'), `${JSON.stringify({
    schemaVersion: 1,
    revisionId: 'rev-selection',
    chapter: 1,
    baseDraftHash: hash,
    createdAt: '2026-11-07T00:00:00.000Z',
    model: 'fake-model',
    findings: ['selection-polish'],
    instructions: [],
    baseParagraphs: [],
    paragraphs: [{ paragraphId: 'p-01', text: '改写后的段落' }],
    rejected: [],
    selection: {
      selectedText: REPEATED,
      replacement: '改写后的段落',
      occurrence: 3,
      operation: 'polish',
      targetParagraphIds: ['p-01'],
    },
  }, null, 2)}\n`)

  const ui = await startUiServer(dir)
  try {
    const response = await fetch(`${ui.url}/api/chapters/1/cockpit`)
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      contract: { data: ChapterContract | null; hash: string | null; check: unknown }
      draft: { text: string; contentHash: string; meta: unknown }
      gates: { ready: boolean; gates: Array<{ id: string; ok: boolean }> }
      findings: Array<{
        findingId: string
        source: string
        quote?: string
        occurrence?: number
        charStart?: number
        charEnd?: number
        line?: number
        matched?: boolean
      }>
      revisions: Array<{ revisionId: string; status: string; charStart?: number; matched?: boolean }>
      stages: {
        contentCheck: { passed: boolean; draftHash: string } | null
        extraction: { passed: boolean; draftHash: string } | null
        audit: { passed: boolean; draftHash: string } | null
        review: { passed: boolean; draftHash: string } | null
      }
      beats: { status: string }
      finalized: boolean
      revision: number
      context: { effectiveWindow: number; capacityTokens: number; usedTokens: number }
      neighbors: { prev: number | null; next: number | null }
      truncated?: boolean
    }
    assert.equal(payload.contract.data?.title, '雾港')
    assert.equal(payload.draft.text, draft)
    assert.equal(payload.draft.contentHash, hash)
    assert.ok(payload.gates.gates.some(gate => gate.id === 'contract'))
    assert.ok(payload.gates.gates.some(gate => gate.id === 'draft' && gate.ok))
    assert.equal(payload.stages.contentCheck?.passed, true)
    assert.equal(payload.stages.review?.draftHash, hash)
    assert.equal(payload.stages.extraction, null)
    assert.equal(payload.beats.status, 'missing')
    assert.equal(payload.finalized, false)
    assert.equal(payload.revision, 0)

    const repeated = payload.findings.find(finding => finding.findingId === 'f-occurrence')
    const second = nthOccurrence(draft, REPEATED, 2)
    assert.equal(repeated?.occurrence, 2)
    assert.equal(repeated?.charStart, second)
    assert.equal(repeated?.charEnd, second + REPEATED.length)
    assert.equal(repeated?.line, 5)
    assert.equal(repeated?.matched, true)
    const stale = payload.findings.find(finding => finding.findingId === 'f-stale')
    assert.equal(stale?.matched, false)
    assert.equal(stale?.quote, '这一句已经被作者删掉')

    assert.equal(payload.revisions[0]?.revisionId, 'rev-selection')
    assert.equal(payload.revisions[0]?.status, 'candidate')
    assert.equal(payload.revisions[0]?.matched, true)
    assert.equal(payload.revisions[0]?.charStart, nthOccurrence(draft, REPEATED, 3))

    assert.equal(payload.context.effectiveWindow > 0, true)
    assert.equal(payload.context.capacityTokens > 0, true)
    assert.ok(payload.context.usedTokens >= 0)
    assert.deepEqual(payload.neighbors, { prev: null, next: null })

    // Old routes stay available for CLI clients and the untouched UI paths.
    assert.equal((await fetch(`${ui.url}/api/chapters/1`)).status, 200)
    assert.equal((await fetch(`${ui.url}/api/chapters/1/gates`)).status, 200)
    assert.equal((await fetch(`${ui.url}/api/chapters/1/findings`)).status, 200)
    assert.equal((await fetch(`${ui.url}/api/chapters/1/revisions`)).status, 200)
  } finally {
    await ui.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cockpit context budget lists included materials with tokens, purpose and required flags', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-context-budget-'))
  await initProject(dir, {
    title: '预算测试',
    model: 'fake-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    workflowVersion: 2,
  })
  await saveContract(dir, contract())
  await mkdir(path.join(dir, 'canon'), { recursive: true })
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({
    characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }],
  })}\n`)
  const server = await startUiServer(dir)
  try {
    const budget = await (await fetch(`${server.url}/api/chapters/1/context/budget`)).json() as {
      chapter: number
      capacityTokens: number
      usedTokens: number
      remainingTokens: number
      charsPerToken: number
      included: Array<{ sourceId: string; purpose: string; tokens: number; required: boolean }>
      error?: string
    }
    assert.equal(budget.chapter, 1)
    assert.equal(budget.error, undefined)
    assert.ok(budget.capacityTokens > 0)
    assert.ok(budget.charsPerToken > 0)
    assert.equal(budget.remainingTokens, Math.max(0, budget.capacityTokens - budget.usedTokens))
    assert.ok(budget.included.length > 0, '至少包含一个人物材料')
    for (const item of budget.included) {
      assert.equal(typeof item.sourceId, 'string')
      assert.equal(typeof item.purpose, 'string')
      assert.equal(typeof item.tokens, 'number')
      assert.equal(typeof item.required, 'boolean')
    }

    const cockpit = await (await fetch(`${server.url}/api/chapters/1/cockpit`)).json() as {
      context: {
        remainingTokens: number
        included: Array<{ sourceId: string; tokens: number }>
      }
    }
    assert.equal(cockpit.context.remainingTokens, budget.remainingTokens)
    assert.equal(cockpit.context.included.length, budget.included.length)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cockpit truncates very large finding lists and flags it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-cockpit-truncate-'))
  const draft = DRAFT
  try {
    await initProject(dir, {
      title: '截断测试',
      model: 'fake-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      workflowVersion: 2,
    })
    await saveContract(dir, contract())
    await saveDraft(dir, 1, draft)
    const review: ReviewReport = {
      schemaVersion: 1,
      chapter: 1,
      draftHash: draftHash(draft),
      createdAt: new Date().toISOString(),
      extractionHash: 'sha256:test',
      auditHash: 'sha256:test',
      summary: '大量意见',
      findings: Array.from({ length: 230 }, (_, index) => ({
        findingId: `f-${index + 1}`,
        dimension: '重复',
        severity: index % 3 === 0 ? 'blocking' as const : 'info' as const,
        description: `第 ${index + 1} 条`,
        quote: REPEATED,
        status: 'open' as const,
      })),
      blockingCount: 77,
      model: 'fake-model',
      passed: false,
    }
    await saveStage(dir, 'review', 1, review)
    const ui = await startUiServer(dir)
    try {
      const payload = await fetch(`${ui.url}/api/chapters/1/cockpit`).then(result => result.json()) as {
        findings: unknown[]
        truncated?: boolean
      }
      assert.equal(payload.findings.length, 200)
      assert.equal(payload.truncated, true)
    } finally {
      await ui.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
