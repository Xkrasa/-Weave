import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initProject } from '../src/core/project.ts'
import { saveContract } from '../src/core/contract.ts'
import { saveDraft } from '../src/core/runs.ts'
import { startUiServer } from '../src/core/ui-server.ts'
import type { ChapterContract } from '../src/core/types.ts'

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

async function fixture(): Promise<{ dir: string; base: string; token: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-ui-'))
  await initProject(dir, {
    title: 'UI 测试项目',
    model: 'fake-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    workflowVersion: 2,
  })
  await saveContract(dir, contract())
  await saveDraft(dir, 1, '林岚在码头翻开账本。\n\n她发现缺页。')
  const ui = await startUiServer(dir)
  return { dir, base: ui.url, token: ui.token, close: ui.close }
}

async function request(base: string, pathname: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, options)
}

test('P3 UI bootstraps project, lists chapters and serves the workbench shell', async () => {
  const app = await fixture()
  try {
    const bootstrap = await request(app.base, '/api/bootstrap')
    assert.equal(bootstrap.status, 200)
    const bootstrapPayload = await bootstrap.json() as { token: string; status: { title: string } }
    assert.ok(bootstrapPayload.token)
    assert.equal(bootstrapPayload.status.title, 'UI 测试项目')

    const chapters = await request(app.base, '/api/chapters')
    assert.equal(chapters.status, 200)
    const chapterPayload = await chapters.json() as {
      chapters: Array<{ chapter: number; title: string; draft: boolean }>
    }
    assert.equal(chapterPayload.chapters[0]?.chapter, 1)
    assert.equal(chapterPayload.chapters[0]?.title, '雾港')
    assert.equal(chapterPayload.chapters[0]?.draft, true)

    const shell = await request(app.base, '/')
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /Weave/)
    const css = await request(app.base, '/styles.css')
    assert.equal(css.status, 200)
  } finally {
    await app.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('P3 UI draft saves are token protected and use optimistic hashes', async () => {
  const app = await fixture()
  try {
    const current = await (await request(app.base, '/api/chapters/1/draft')).json() as {
      content: string
      hash: string
    }
    assert.match(current.content, /账本/)
    assert.ok(current.hash)

    const noToken = await request(app.base, '/api/chapters/1/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    assert.equal(noToken.status, 401)

    const stale = await request(app.base, '/api/chapters/1/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-weave-token': app.token },
      body: JSON.stringify({ content: '新内容', baseHash: 'stale' }),
    })
    assert.equal(stale.status, 409)

    const saved = await request(app.base, '/api/chapters/1/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-weave-token': app.token },
      body: JSON.stringify({ content: '林岚把账本收好。', baseHash: current.hash }),
    })
    assert.equal(saved.status, 200)
    const savedPayload = await saved.json() as { hash: string }
    assert.ok(savedPayload.hash)

    const detail = await (await request(app.base, '/api/chapters/1')).json() as {
      draft: string
      stages: { review: unknown }
    }
    assert.equal(detail.draft, '林岚把账本收好。')
    assert.equal(detail.stages.review, null)
  } finally {
    await app.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('P3 UI exposes methods and style without a model call', async () => {
  const app = await fixture()
  try {
    const methods = await request(app.base, '/api/chapters/1/methods')
    assert.equal(methods.status, 200)
    const methodPayload = await methods.json() as { modules: unknown[]; estimatedTokens: number }
    assert.ok(Array.isArray(methodPayload.modules))
    assert.ok(methodPayload.estimatedTokens >= 0)

    const style = await request(app.base, '/api/chapters/1/style')
    assert.equal(style.status, 200)
    const stylePayload = await style.json() as { passed: boolean; findings: unknown[] }
    assert.equal(stylePayload.passed, true)
    assert.ok(Array.isArray(stylePayload.findings))
  } finally {
    await app.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})
