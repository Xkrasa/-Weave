import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts')
const SECRET = 'sk-test-secret-should-never-appear'

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

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

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'weave-test-'))
}

async function initBook(baseUrl: string, options: string[] = []): Promise<string> {
  const dir = await tempDir()
  const result = await runCli(dir, [
    'init', '.', '--title', '潮汐账本', '--model', 'fake-model', '--base-url', baseUrl, ...options,
  ])
  assert.equal(result.code, 0, result.stderr)
  return dir
}

async function setCharacters(dir: string, characters: unknown[]): Promise<void> {
  await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters }, null, 2)}\n`)
}

async function setContract(dir: string, chapter: number, overrides: Record<string, unknown> = {}): Promise<void> {
  const contract = {
    chapter,
    title: chapter === 1 ? '雾港' : `第${chapter}章`,
    pov: '林岚',
    time: `第 ${chapter} 天`,
    location: '海港',
    openingState: '林岚带着缺页账本回到海港',
    endingState: '林岚确认账本被人动过',
    goal: '找出账本缺页的原因',
    obstacle: '港务局的人不肯作证',
    mustHappen: ['林岚发现账本缺页'],
    mayHappen: ['林岚与旧友争执'],
    mustNotHappen: ['林岚使用尚未获知的情报'],
    characters: ['林岚'],
    threads: ['账本主线'],
    targetWords: 800,
    previousLink: chapter === 1 ? '无' : '承接上一章结尾',
    nextLink: '账本线索继续推进',
    ...overrides,
  }
  await writeFile(
    path.join(dir, 'outlines', 'chapters', `${String(chapter).padStart(3, '0')}.json`),
    `${JSON.stringify(contract, null, 2)}\n`,
  )
}

async function checkContract(dir: string, chapter: number): Promise<CliResult> {
  return runCli(dir, ['contract', 'check', String(chapter), '--json'])
}

function parseJson<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, `no JSON in output: ${stdout}`)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

class FakeModel {
  readonly requests: Array<Record<string, unknown>> = []
  private readonly texts: string[]
  private readonly server: Server
  private readonly mode: 'ok' | 'break'
  baseUrl = ''

  constructor(texts: string[], mode: 'ok' | 'break' = 'ok') {
    this.texts = [...texts]
    this.mode = mode
    this.server = createServer((request, response) => this.handle(request, response))
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

  private handle(request: IncomingMessage, response: ServerResponse): void {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try {
        this.requests.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        this.requests.push({ raw: body })
      }
      const text = this.texts.shift() ?? '林岚把账本摊在桌上，缺页的边缘还留着新鲜折痕。'
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const chunks = [...text].reduce<string[]>((all, char, index) => {
        const target = Math.floor(index / 12)
        all[target] = (all[target] ?? '') + char
        return all
      }, [])
      if (this.mode === 'break') {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[0] ?? '半' } }] })}\n\n`)
        setTimeout(() => response.destroy(), 10)
        return
      }
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  }
}

async function contract1(dir: string): Promise<void> {
  await setCharacters(dir, [{
    name: '林岚',
    status: 'alive',
    introducedIn: 1,
    knows: [{ fact: '账本缺页', fromChapter: 1 }],
  }])
  await setContract(dir, 1)
  const checked = await checkContract(dir, 1)
  assert.equal(checked.code, 0, checked.stderr)
}

async function writeAndFinalize(dir: string, chapter: number): Promise<{ commitId: string; text: string }> {
  await setContract(dir, chapter)
  const checked = await checkContract(dir, chapter)
  assert.equal(checked.code, 0, checked.stderr)
  const written = await runCli(dir, ['write', String(chapter), '--json'], { WEAVE_API_KEY: SECRET })
  assert.equal(written.code, 0, written.stderr)
  const final = await runCli(dir, ['finalize', String(chapter), '--json'])
  assert.equal(final.code, 0, final.stderr)
  const payload = parseJson<{ commit: { commitId: string }; chapter: number }>(final.stdout)
  const text = await readFile(path.join(dir, 'chapters', 'final', `${String(chapter).padStart(3, '0')}.md`), 'utf8')
  return { commitId: payload.commit.commitId, text }
}

test('init creates a readable project and status reports it', async () => {
  const dir = await initBook('http://127.0.0.1:1/v1')
  try {
    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 0, status.stderr)
    const payload = parseJson<{ title: string; mainlineRevision: number; chapters: unknown[] }>(status.stdout)
    assert.equal(payload.title, '潮汐账本')
    assert.equal(payload.mainlineRevision, 0)
    assert.deepEqual(payload.chapters, [])
    assert.match(await readFile(path.join(dir, 'canon', 'premise.md'), 'utf8'), /^$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('contract validation rejects missing fields and future knowledge without calling a model', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      knows: [{ fact: '真相', fromChapter: 3 }],
    }])
    await setContract(dir, 1, {
      title: '',
      mustHappen: [],
      knowledge: [{ character: '林岚', fact: '真相' }],
    })
    const checked = await checkContract(dir, 1)
    assert.equal(checked.code, 3)
    const payload = parseJson<{ ok: boolean; errors: Array<{ code: string }> }>(checked.stdout)
    assert.equal(payload.ok, false)
    assert.ok(payload.errors.some(error => error.code === 'MISSING_FIELD'))
    assert.ok(payload.errors.some(error => error.code === 'FUTURE_KNOWLEDGE'))

    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 3)
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('contract validation rejects dead characters and reports structured JSON errors', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'dead',
      introducedIn: 1,
      deathChapter: 1,
    }])
    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    const checked = await runCli(dir, ['contract', 'check', '2', '--json'])
    assert.equal(checked.code, 3)
    const payload = parseJson<{ ok: boolean; errors: Array<{ code: string }> }>(checked.stdout)
    assert.equal(payload.ok, false)
    assert.ok(payload.errors.some(error => error.code === 'DEAD_CHARACTER'))
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('required material that cannot fit returns capacity-conflict before any model request', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '1200', '--max-output', '800'])
  try {
    await contract1(dir)
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 3, written.stderr)
    const payload = parseJson<{ error: { code: string; details: { decision: string } } }>(written.stdout)
    assert.equal(payload.error.code, 'VALIDATION')
    assert.equal(payload.error.details.decision, 'capacity-conflict')
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown-provenance reference is omitted and never reaches the model', async () => {
  const model = new FakeModel(['林岚翻开账本。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'references', 'note.md'), 'SECRET-UNVERIFIED-CLAIM')
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
    const payload = parseJson<{ omitted: Array<{ sourceId: string; reason: string }> }>(written.stdout)
    assert.ok(payload.omitted.some(item => item.sourceId === 'reference:note.md' && item.reason === 'unknown-provenance'))
    assert.equal(model.requests.length, 1)
    const body = JSON.stringify(model.requests[0])
    assert.equal(body.includes('SECRET-UNVERIFIED-CLAIM'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stream failure keeps a recovery candidate and does not create a draft', async () => {
  const model = new FakeModel([], 'break')
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 5, written.stderr)
    const payload = parseJson<{ error: { code: string } }>(written.stdout)
    assert.equal(payload.error.code, 'MODEL')
    const draftFiles = (await readdir(path.join(dir, 'chapters', 'drafts'))).filter(name => name.endsWith('.md'))
    assert.deepEqual(draftFiles, [])
    const runsDir = path.join(dir, '.weave', 'runs')
    const runNames = (await readdir(runsDir)).filter(name => name.endsWith('.json'))
    assert.equal(runNames.length, 1)
    const run = JSON.parse(await readFile(path.join(runsDir, runNames[0]!), 'utf8')) as { status: string; partialPath?: string }
    assert.equal(run.status, 'failed')
    assert.ok(run.partialPath)
    assert.ok((await readFile(path.join(dir, run.partialPath!), 'utf8')).length > 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('finalize creates an immutable commit, rebuild is deterministic, and secrets stay out of project files', async () => {
  const model = new FakeModel(['林岚翻开账本，缺页的边缘还留着新鲜折痕。', '港务局的人不肯作证，林岚把账本收回怀里。'])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '8192', '--max-output', '1024'])
  try {
    await contract1(dir)
    const first = await writeAndFinalize(dir, 1)
    const second = await writeAndFinalize(dir, 2)
    assert.notEqual(first.commitId, second.commitId)

    const final1 = await readFile(path.join(dir, 'chapters', 'final', '001.md'), 'utf8')
    const version1 = await readFile(path.join(dir, 'chapters', 'versions', '001', 'rev-001.md'), 'utf8')
    assert.equal(final1, first.text)
    assert.equal(version1, first.text)

    const commitsDir = path.join(dir, 'ledger', 'commits')
    const commitFiles = (await readdir(commitsDir)).filter(name => name.endsWith('.json'))
    assert.equal(commitFiles.length, 2)
    const mainlineLines = (await readFile(path.join(dir, 'ledger', 'mainline.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(mainlineLines.length, 2)

    const exported = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const before = await readFile(path.join(dir, 'exports', 'book-merged.md'))
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(path.join(dir, '.weave', `index.db${suffix}`), { force: true })
    }
    const doctorWithoutProjection = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorWithoutProjection.code, 4)
    assert.ok(parseJson<{ errors: string[] }>(doctorWithoutProjection.stdout).errors.some(error => error.includes('投影缺失')))
    const rebuilt = await runCli(dir, ['rebuild', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    const exportedAgain = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exportedAgain.code, 0, exportedAgain.stderr)
    const after = await readFile(path.join(dir, 'exports', 'book-merged.md'))
    assert.deepEqual(after, before)

    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr)

    const leaked = await findText(path.join(dir, '.weave'), SECRET)
    assert.equal(leaked, null)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('amend keeps history, creates a new revision, records impact, and blocks new finalization until resolved', async () => {
  const model = new FakeModel([
    '第一章：林岚在码头发现账本缺页。',
    '第二章：林岚去港务局问账本的来历。',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '8192', '--max-output', '1024'])
  try {
    await contract1(dir)
    const original = await writeAndFinalize(dir, 1)
    await writeAndFinalize(dir, 2)
    const oldCommitFiles = await readdir(path.join(dir, 'ledger', 'commits'))
    const oldCommitText = await readFile(
      path.join(dir, 'ledger', 'commits', oldCommitFiles.find(name => name.endsWith('.json'))!),
      'utf8',
    )

    const amended = await runCli(dir, ['amend', '1', '--json'])
    assert.equal(amended.code, 0, amended.stderr)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '第一章修订：林岚发现缺页是被人撕走的。\n')
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)
    const payload = parseJson<{ commit: { revision: number; commitId: string }; impact: { items: Array<{ targetChapter: number; level: string }> } }>(finalized.stdout)
    assert.equal(payload.commit.revision, 2)
    assert.equal(payload.impact.items[0]?.targetChapter, 2)
    assert.equal(payload.impact.items[0]?.level, 'confirmed')
    assert.notEqual(payload.commit.commitId, original.commitId)

    const commitFiles = await readdir(path.join(dir, 'ledger', 'commits'))
    assert.equal(commitFiles.length, 3)
    assert.equal(
      await readFile(path.join(dir, 'ledger', 'commits', oldCommitFiles.find(name => name.endsWith('.json'))!), 'utf8'),
      oldCommitText,
    )
    const mainline = (await readFile(path.join(dir, 'ledger', 'mainline.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(mainline.length, 3)
    const head = JSON.parse(mainline[mainline.length - 1]!) as { selectedCommitByChapter: Record<string, string> }
    assert.equal(head.selectedCommitByChapter['1'], payload.commit.commitId)

    await setContract(dir, 3)
    const checked = await checkContract(dir, 3)
    assert.equal(checked.code, 0, checked.stderr)
    const blocked = await runCli(dir, ['finalize', '3', '--json'])
    assert.equal(blocked.code, 4)
    const statusBefore = parseJson<{ pendingImpacts: number }>((await runCli(dir, ['status', '--json'])).stdout)
    assert.equal(statusBefore.pendingImpacts, 1)

    const resolved = await runCli(dir, ['resolve-impact', '1', '--all', '--decision', 'accept', '--json'])
    assert.equal(resolved.code, 0, resolved.stderr)
    const statusAfter = parseJson<{ pendingImpacts: number }>((await runCli(dir, ['status', '--json'])).stdout)
    assert.equal(statusAfter.pendingImpacts, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('external drift in formal prose is reported and blocks the next generation', async () => {
  const model = new FakeModel(['林岚翻开账本。', '林岚走进港务局。'])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '8192', '--max-output', '1024'])
  try {
    await contract1(dir)
    await writeAndFinalize(dir, 1)
    await writeAndFinalize(dir, 2)
    await writeFile(path.join(dir, 'chapters', 'final', '001.md'), '被人从外部改掉的正文。\n')

    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 4)
    const doctorPayload = parseJson<{ ok: boolean; errors: string[] }>(doctorResult.stdout)
    assert.equal(doctorPayload.ok, false)
    assert.ok(doctorPayload.errors.some(error => error.includes('正式正文与主线提交不一致')))

    await setContract(dir, 3)
    const checked = await checkContract(dir, 3)
    assert.equal(checked.code, 0, checked.stderr)
    const requestsBefore = model.requests.length
    const blocked = await runCli(dir, ['write', '3', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(blocked.code, 4)
    assert.equal(model.requests.length, requestsBefore)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('split export preserves Chinese filenames and deterministic content', async () => {
  const model = new FakeModel(['林岚把缺页夹进账本。'])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '8192', '--max-output', '1024'])
  try {
    await contract1(dir)
    await writeAndFinalize(dir, 1)
    const exported = await runCli(dir, ['export', '--format', 'split', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const payload = parseJson<{ files: string[] }>(exported.stdout)
    assert.equal(payload.files.length, 1)
    assert.match(path.basename(payload.files[0]!), /^001-雾港\.md$/)
    assert.match(await readFile(payload.files[0]!, 'utf8'), /缺页/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function findText(dir: string, needle: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findText(target, needle)
      if (found) return found
      continue
    }
    if (/\.(db|db-wal|db-shm)$/.test(entry.name)) continue
    const text = await readFile(target, 'utf8').catch(() => '')
    if (text.includes(needle)) return target
  }
  return null
}
