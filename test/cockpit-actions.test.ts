import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nextAction } from '../src/core/cockpit.ts'
import { compareChapterWithCommit } from '../src/core/compare.ts'
import { appendMainline, buildCommit, finalPath, writeCommit } from '../src/core/ledger.ts'
import { initProject, projectPaths } from '../src/core/project.ts'
import { hashText } from '../src/core/hash.ts'
import type { CockpitPayload } from '../src/core/cockpit.ts'
import type { GateView } from '../src/core/cockpit.ts'

function gates(overrides: Record<string, boolean> = {}): GateView[] {
  const ids: Array<[string, string]> = [
    ['contract', '合同存在'],
    ['contract-check', '合同检查'],
    ['draft', '草稿存在'],
    ['content-check', '内容检查'],
    ['extraction', '证据抽取'],
    ['audit', '覆盖审计'],
    ['review', '审查'],
  ]
  return ids.map(([id, label]) => ({ id, label, ok: overrides[id] ?? true, detail: 'ok' }))
}

function payload(overrides: Partial<CockpitPayload> & { gateOk?: Record<string, boolean> } = {}): Omit<CockpitPayload, 'nextAction'> {
  const { gateOk, ...rest } = overrides
  const base: Omit<CockpitPayload, 'nextAction'> = {
    chapter: 1,
    contract: { data: null, hash: null, check: null },
    draft: { text: '正文', contentHash: 'sha256:x', meta: null },
    gates: { chapter: 1, ready: true, gates: gates(gateOk) },
    findings: [],
    revisions: [],
    beats: { status: 'approved' },
    stages: { contentCheck: null, extraction: null, audit: null, review: null },
    finalized: false,
    revision: 0,
    context: {
      model: 'fake',
      charsPerToken: 1.6,
      effectiveWindow: 1_000_000,
      capacityTokens: 900_000,
      usedTokens: 0,
      remainingTokens: 900_000,
      included: [],
      omitted: [],
      withheld: [],
      degraded: [],
    },
    neighbors: { prev: null, next: null },
  }
  return { ...base, ...rest }
}

test('nextAction follows the documented priority order', () => {
  assert.equal(nextAction(payload({ gateOk: { contract: false } })).kind, 'contract-check')
  assert.equal(nextAction(payload({ gateOk: { 'contract-check': false } })).kind, 'contract-check')
  assert.equal(nextAction(payload({ beats: { status: 'missing' } })).kind, 'beats-generate')
  assert.equal(nextAction(payload({ beats: { status: 'draft' } })).kind, 'beats-approve')
  assert.equal(
    nextAction(payload({ segmentPlan: { status: 'missing' }, run: { draftingStrategy: 'segmented' } as never })).kind,
    'segments-plan',
  )
  assert.equal(
    nextAction(payload({ segmentPlan: { status: 'draft' } })).kind,
    'segments-approve',
  )
  assert.equal(nextAction(payload({ gateOk: { draft: false }, draft: { text: '', contentHash: '', meta: null } })).kind, 'write')
  assert.equal(
    nextAction(payload({
      findings: [{ findingId: 'f', source: 'review', dimension: 'x', severity: 'blocking', status: 'open', description: 'x' }],
    })).kind,
    'revise',
  )
  assert.equal(nextAction(payload({ gateOk: { audit: false } })).kind, 'stage')
  assert.equal(nextAction(payload()).kind, 'finalize')
  assert.equal(nextAction(payload({ finalized: true })).kind, 'done')
})

test('nextAction never skips a skipped segment plan and treats an approved plan as done for that step', () => {
  assert.equal(nextAction(payload({ segmentPlan: { status: 'skipped' } })).kind, 'finalize')
  assert.equal(nextAction(payload({ segmentPlan: { status: 'approved' } })).kind, 'finalize')
})

test('compareChapterWithCommit returns paragraph-level before/after and never writes the draft', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-compare-'))
  try {
    await initProject(dir, { title: '对比', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
    const baseText = '第一段。\n\n第二段。\n\n第三段。'
    const draftText = '第一段。\n\n第二段改过。\n\n第四段。'
    await writeFile(finalPath(dir, 1), baseText, 'utf8')
    const commit = buildCommit({
      chapter: 1,
      revision: 1,
      supersedes: null,
      contentHash: hashText(baseText),
      contractHash: 'sha256:c',
      contextHash: 'sha256:ctx',
      contentPath: finalPath(dir, 1),
    })
    await writeCommit(dir, commit)
    await appendMainline(dir, { '1': commit.commitId })
    await writeFile(path.join(projectPaths(dir).draftsDir, '001.md'), draftText, 'utf8')

    const result = await compareChapterWithCommit(dir, 1)
    assert.equal(result.base.commitId, commit.commitId)
    assert.equal(result.base.paragraphs.length, 3)
    assert.equal(result.draft.paragraphs.length, 3)
    assert.equal(result.rows.filter(row => row.status === 'same').length, 1)
    assert.equal(result.rows.filter(row => row.status === 'changed').length, 2)
    assert.equal(result.rows.filter(row => row.status === 'removed').length, 0)
    assert.equal(result.rows.filter(row => row.status === 'added').length, 0)
    // The draft file is untouched by the read-only compare.
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(projectPaths(dir).draftsDir, '001.md'), 'utf8'), draftText)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compareChapterWithCommit refuses to compare an unfinalized chapter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-compare-'))
  try {
    await initProject(dir, { title: '对比', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
    await assert.rejects(compareChapterWithCommit(dir, 1), /还没有定稿提交/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
