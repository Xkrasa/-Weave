import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyPromotion, captureIdea, promoteIdea } from '../src/core/ideas.ts'
import { collectIdeaReviewFindings } from '../src/core/idea-review.ts'
import { initProject } from '../src/core/project.ts'
import type { ChapterContract } from '../src/core/types.ts'

function contract(overrides: Partial<ChapterContract> = {}): ChapterContract {
  return {
    chapter: 1,
    title: '第七码',
    pov: '沈停',
    time: '第一日',
    location: '旧城档案馆',
    openingState: '沈停把烧焦的卷宗摊在修复台上',
    endingState: '沈停确认卷宗里出现了自己的名字',
    goal: '修复火灾卷宗并确认失踪者名单',
    obstacle: '陆伯不肯交出原档人的签字',
    mustHappen: ['沈停比对两页残卷的纸张纹路'],
    mayHappen: [],
    mustNotHappen: ['当场找到纵火者'],
    characters: ['沈停', '陆伯'],
    threads: ['火灾卷宗'],
    targetWords: 3000,
    previousLink: '开篇',
    nextLink: '调阅记录',
    ...overrides,
  }
}

async function project(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-idea-review-'))
  await initProject(dir, { title: '想法审阅', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function promotedIdea(dir: string, body: string): Promise<string> {
  const idea = await captureIdea(dir, { body, scope: 'chapter:1' })
  const proposal = await promoteIdea(dir, idea.id, 'plan')
  await applyPromotion(dir, idea.id, proposal)
  return idea.id
}

test('an unused promoted idea becomes a non-blocking info finding', async () => {
  const { dir, cleanup } = await project()
  try {
    await promotedIdea(dir, '档案馆的第七码卷宗里夹着一张旧钥匙')
    const findings = await collectIdeaReviewFindings(dir, contract(), '沈停把修复台擦干净，天已经黑了。')
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.severity, 'info')
    assert.match(findings[0]!.description, /未出现/)
    assert.equal(findings.some(finding => finding.severity === 'blocking'), false)
  } finally {
    await cleanup()
  }
})

test('a draft that mentions the idea title produces no unused finding', async () => {
  const { dir, cleanup } = await project()
  try {
    await promotedIdea(dir, '档案馆的第七码卷宗里夹着一张旧钥匙')
    const findings = await collectIdeaReviewFindings(
      dir,
      contract(),
      '沈停翻开第七码卷宗，里面夹着一张旧钥匙。',
    )
    assert.deepEqual(findings, [])
  } finally {
    await cleanup()
  }
})

test('an idea that mentions a contract prohibition is a warning, never blocking', async () => {
  const { dir, cleanup } = await project()
  try {
    await promotedIdea(dir, '让沈停当场找到纵火者，并让陆伯认罪')
    const findings = await collectIdeaReviewFindings(dir, contract(), '沈停翻着卷宗，没有说话。')
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.severity, 'warning')
    assert.match(findings[0]!.description, /合同禁区/)
    assert.equal(findings.some(finding => finding.severity === 'blocking'), false)
  } finally {
    await cleanup()
  }
})

test('inbox ideas and other scopes never enter the review check', async () => {
  const { dir, cleanup } = await project()
  try {
    await captureIdea(dir, { body: '一条还没晋升的收件箱想法', scope: 'chapter:1' })
    const idea = await captureIdea(dir, { body: '另一卷的晋升想法', scope: 'chapter:2' })
    const proposal = await promoteIdea(dir, idea.id, 'plan')
    await applyPromotion(dir, idea.id, proposal)
    const findings = await collectIdeaReviewFindings(dir, contract(), '沈停把修复台擦干净。')
    assert.deepEqual(findings, [])
  } finally {
    await cleanup()
  }
})
