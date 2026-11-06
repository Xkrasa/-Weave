import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  private readonly texts: string[]
  private readonly server: Server
  baseUrl = ''

  constructor(texts: string[]) {
    this.texts = [...texts]
    this.server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const text = this.texts.shift() ?? '林岚把账本摊在桌上。\n\n缺页的边缘还留着折痕。'
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-index-'))
  const result = await runCli(dir, ['init', '.', '--title', '索引水位', '--model', 'fake', '--base-url', baseUrl, '--workflow', 'p0'])
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

async function writeDraft(dir: string, text: string): Promise<void> {
  await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), text)
}

test('finalize keeps the search index current without a manual rebuild', async () => {
  const model = new FakeModel(['林岚在潮汐账本里发现缺页。\n\n她把纸角按平。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    assert.equal((await runCli(dir, ['write', '1', '--json'])).code, 0)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)
    const payload = parseJson<{ searchIndexFailed: boolean }>(finalized.stdout)
    assert.equal(payload.searchIndexFailed, false)

    const status = parseJson<{ searchIndex: { status: string; current: boolean; mainlineRevision: number } }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status.searchIndex.status, 'current')
    assert.equal(status.searchIndex.mainlineRevision, 1)

    const search = await runCli(dir, ['search', '潮汐', '--json'])
    assert.equal(search.code, 0, search.stdout + search.stderr)
    const results = parseJson<{ results: Array<{ chapter: number; text: string }> }>(search.stdout)
    assert.ok(results.results.some(item => item.chapter === 1 && item.text.includes('潮汐账本')))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('amending a chapter replaces its indexed chunks instead of keeping stale text', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await writeDraft(dir, '林岚在旧仓库找到潮汐账本。\n\n缺页的边缘留着折痕。\n')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['search', '折痕', '--json'])).code, 0)

    assert.equal((await runCli(dir, ['amend', '1', '--json'])).code, 0)
    await writeDraft(dir, '林岚在码头烧掉了那本账。\n\n她把手套扔进海里。\n')
    const refinalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(refinalized.code, 0, refinalized.stdout + refinalized.stderr)

    const stale = await runCli(dir, ['search', '折痕', '--json'])
    assert.equal(stale.code, 0)
    const staleResults = parseJson<{ results: Array<{ chapter: number }> }>(stale.stdout)
    assert.equal(staleResults.results.filter(item => item.chapter === 1).length, 0)

    const fresh = await runCli(dir, ['search', '手套', '--json'])
    assert.equal(fresh.code, 0)
    const freshResults = parseJson<{ results: Array<{ chapter: number; text: string }> }>(fresh.stdout)
    assert.ok(freshResults.results.some(item => item.chapter === 1 && item.text.includes('手套')))

    const health = parseJson<{ current: boolean; status: string }>((await runCli(dir, ['index', 'status', '--json'])).stdout)
    assert.equal(health.current, true)
    assert.equal(health.status, 'current')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed index sync blocks silent search and is reported by doctor', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await writeDraft(dir, '林岚在旧仓库找到潮汐账本。\n')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    const db = new DatabaseSync(path.join(dir, '.weave', 'index.db'))
    db.prepare("UPDATE search_state SET status = 'failed', error = 'disk full' WHERE id = 1").run()
    db.close()

    const search = await runCli(dir, ['search', '账本', '--json'])
    assert.equal(search.code, 4)
    const payload = parseJson<{ error: { message: string } }>(search.stdout)
    assert.match(payload.error.message, /同步失败/)

    const doctor = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctor.code, 4)
    const doctorPayload = parseJson<{ ok: boolean; errors: string[] }>(doctor.stdout)
    assert.equal(doctorPayload.ok, false)
    assert.ok(doctorPayload.errors.some(error => error.includes('检索索引')))

    const rebuilt = await runCli(dir, ['rebuild', '--projection', 'search', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr)
    assert.equal((await runCli(dir, ['search', '账本', '--json'])).code, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
