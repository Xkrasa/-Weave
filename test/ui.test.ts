import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const shellHtml = await shell.text()
    assert.match(shellHtml, /Weave/)
    assert.match(shellHtml, /id="intent-strip"/)
    assert.match(shellHtml, /id="gate-bar"/)
    assert.match(shellHtml, /id="draft-view"/)
    assert.match(shellHtml, /data-tab="evidence"/)
    assert.match(shellHtml, /id="btn-next"/)
    assert.match(shellHtml, /id="palette"/)
    assert.match(shellHtml, /data-tab="segments"/)
    const css = await request(app.base, '/styles.css')
    assert.equal(css.status, 200)
    assert.equal((await request(app.base, '/app.js')).status, 200)
    assert.equal((await request(app.base, '/cockpit.js')).status, 200)
    assert.equal((await request(app.base, '/evidence.js')).status, 200)
    assert.equal((await request(app.base, '/ideas.js')).status, 200)
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

test('P3 UI exposes gates, preferences and chapter history', async () => {
  const app = await fixture()
  try {
    const gates = await request(app.base, '/api/chapters/1/gates')
    assert.equal(gates.status, 200)
    const gatePayload = await gates.json() as {
      ready: boolean
      gates: Array<{ id: string; ok: boolean }>
    }
    assert.equal(gatePayload.ready, false)
    assert.ok(gatePayload.gates.some(item => item.id === 'contract'))
    assert.ok(gatePayload.gates.some(item => item.id === 'draft' && item.ok))

    const saved = await request(app.base, '/api/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-weave-token': app.token },
      body: JSON.stringify({ lastChapter: 1, tab: 'stages' }),
    })
    assert.equal(saved.status, 200)
    const prefs = await (await request(app.base, '/api/preferences')).json() as {
      lastChapter: number
      tab: string
    }
    assert.equal(prefs.lastChapter, 1)
    assert.equal(prefs.tab, 'stages')

    const history = await request(app.base, '/api/chapters/1/history')
    assert.equal(history.status, 200)
    assert.deepEqual((await history.json() as { commits: unknown[] }).commits, [])
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

test('UI exposes planning, outline and preference surfaces', async () => {
  const app = await fixture()
  try {
    const plans = await request(app.base, '/api/plans')
    assert.equal(plans.status, 200)
    const planPayload = await plans.json() as { plans: Array<{ kind: string; status: string }> }
    assert.ok(planPayload.plans.some(item => item.kind === 'story' && item.status === 'missing'))

    await mkdir(path.join(app.dir, 'plans'), { recursive: true })
    await writeFile(path.join(app.dir, 'plans', 'story.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'story',
      status: 'draft',
      provenance: 'generated',
      contentHash: 'pending',
      content: {
        audience: '追更读者',
        genre: '悬疑',
        coreFantasy: '账本撬开港口',
        uniqueSellingPoint: '每章一个可验证的缺页',
        emotionalPromise: '越查越近',
        protagonistDesire: '拿回房子',
      },
    }, null, 2)}\n`)
    const approved = await request(app.base, '/api/plans/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-weave-token': app.token },
      body: JSON.stringify({ kind: 'story' }),
    })
    assert.equal(approved.status, 200)
    assert.equal((await approved.json() as { status: string }).status, 'approved')

    const outlines = await request(app.base, '/api/outlines')
    assert.equal(outlines.status, 200)
    assert.deepEqual((await outlines.json() as { candidates: unknown[] }).candidates, [])

    const learning = await request(app.base, '/api/preferences/learning')
    assert.equal(learning.status, 200)
    const learningPayload = await learning.json() as { signals: unknown[]; candidates: unknown[]; approved: unknown[] }
    assert.ok(Array.isArray(learningPayload.signals))

    const reviewed = await request(app.base, '/api/preferences/review', {
      method: 'POST',
      headers: { 'x-weave-token': app.token },
    })
    assert.equal(reviewed.status, 200)
    assert.deepEqual((await reviewed.json() as { candidates: unknown[] }).candidates, [])

    const effect = await request(app.base, '/api/chapters/1/effect-review')
    assert.equal(effect.status, 200)
    assert.equal((await effect.json() as { report: unknown }).report, null)

    const shell = await (await request(app.base, '/')).text()
    assert.match(shell, /data-tab="plan"/)
    assert.match(shell, /data-tab="effect"/)
  } finally {
    await app.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('library, model settings and first-run setup work over the UI API', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-library-'))
  const libraryRoot = path.join(dir, 'books')
  await mkdir(libraryRoot, { recursive: true })
  const bookRoot = path.join(libraryRoot, 'main')
  await initProject(bookRoot, {
    title: '书库测试',
    model: 'fake-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    workflowVersion: 2,
  })
  const ui = await startUiServer(bookRoot, { libraryRoot })
  const headers = { 'x-weave-token': ui.token, 'content-type': 'application/json' }
  try {
    const library = await (await request(ui.url, '/api/library')).json() as {
      current: string
      books: Array<{ name: string; current: boolean }>
    }
    assert.equal(library.current, bookRoot)
    assert.equal(library.books.length, 1)
    assert.equal(library.books[0]?.name, 'main')
    assert.equal(library.books[0]?.current, true)

    const setup = await (await request(ui.url, '/api/setup')).json() as { needsSetup: boolean }
    assert.equal(setup.needsSetup, true, 'empty canon asks for setup')
    const applied = await request(ui.url, '/api/setup/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify({ premise: '一个杂工靠家政技能净化魔物', protagonist: '陆渊' }),
    })
    assert.equal(applied.status, 200)
    const after = await (await request(ui.url, '/api/setup')).json() as { needsSetup: boolean }
    assert.equal(after.needsSetup, false)

    const models = await (await request(ui.url, '/api/models')).json() as {
      model: string
      apiKeyEnv: string
      presets: Array<{ id: string }>
    }
    assert.equal(models.model, 'fake-model')
    assert.ok(models.presets.length > 0)
    const changed = await request(ui.url, '/api/models/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'mimo-v2.6-pro',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKeyEnv: 'Mimo_API_KEY',
      }),
    })
    assert.equal(changed.status, 200)
    const reloaded = await (await request(ui.url, '/api/models')).json() as { model: string; apiKeyEnv: string }
    assert.equal(reloaded.model, 'mimo-v2.6-pro')
    assert.equal(reloaded.apiKeyEnv, 'Mimo_API_KEY')

    const created = await request(ui.url, '/api/library/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '第二本书' }),
    })
    assert.equal(created.status, 200)
    const createdPayload = await created.json() as { current: string }
    assert.notEqual(createdPayload.current, bookRoot)
    const libraryAfter = await (await request(ui.url, '/api/library')).json() as {
      books: Array<{ current: boolean }>
    }
    assert.equal(libraryAfter.books.length, 2)
    assert.equal(libraryAfter.books.filter(item => item.current).length, 1)

    const unauthenticated = await request(ui.url, '/api/models/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    })
    assert.equal(unauthenticated.status, 401)
  } finally {
    await ui.close()
    await rm(dir, { recursive: true, force: true })
  }
})
