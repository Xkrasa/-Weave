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

function spawnCli(cwd: string, args: string[], env: Record<string, string> = {}): {
  child: ReturnType<typeof spawn>
  done: Promise<CliResult>
  output: () => string
} {
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
  const done = new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
  return { child, done, output: () => stdout }
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return spawnCli(cwd, args, env).done
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'weave-test-'))
}

async function initBook(baseUrl: string, options: string[] = [], workflow = 'p0'): Promise<string> {
  const dir = await tempDir()
  const result = await runCli(dir, [
    'init', '.', '--title', '潮汐账本', '--model', 'fake-model', '--base-url', baseUrl,
    '--workflow', workflow, ...options,
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
  private readonly mode: 'ok' | 'break' | 'slow'
  private readonly responses = new Set<ServerResponse>()
  baseUrl = ''

  constructor(texts: string[], mode: 'ok' | 'break' | 'slow' = 'ok') {
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
    for (const response of this.responses) response.destroy()
    this.responses.clear()
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
      this.responses.add(response)
      response.on('close', () => this.responses.delete(response))
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
      if (this.mode === 'slow') {
        let index = 0
        const timer = setInterval(() => {
          if (response.destroyed) {
            clearInterval(timer)
            return
          }
          const chunk = chunks[index] ?? '。'
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
          index += 1
        }, 60)
        response.on('close', () => clearInterval(timer))
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
  assert.equal(payload.chapter, chapter)
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
    const exportWithoutProjection = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exportWithoutProjection.code, 4)
    const rebuilt = await runCli(dir, ['rebuild', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    const exportedAgain = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exportedAgain.code, 0, exportedAgain.stderr)
    const after = await readFile(path.join(dir, 'exports', 'book-merged.md'))
    assert.deepEqual(after, before)

    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr)

    const leaked = await findText(dir, SECRET)
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
    const payload = parseJson<{
      commit: { revision: number; commitId: string }
      impact: { items: Array<{ targetChapter: number; level: string }> }
      projection: { status: string; invalidFrom: number | null }
      draftEdited: boolean
    }>(finalized.stdout)
    assert.equal(payload.commit.revision, 2)
    assert.equal(payload.impact.items[0]?.targetChapter, 2)
    assert.equal(payload.impact.items[0]?.level, 'confirmed')
    assert.notEqual(payload.commit.commitId, original.commitId)
    assert.equal(payload.projection.status, 'current')
    assert.equal(payload.projection.invalidFrom, 1)
    assert.equal(payload.draftEdited, true)

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

    const refusedRebuild = await runCli(dir, ['rebuild', '--json'])
    assert.equal(refusedRebuild.code, 4)
    const forcedRebuild = await runCli(dir, ['rebuild', '--force', '--json'])
    assert.equal(forcedRebuild.code, 0, forcedRebuild.stderr)
    assert.match(await readFile(path.join(dir, 'chapters', 'final', '001.md'), 'utf8'), /林岚翻开账本/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('changing canon after contract check blocks generation until re-check', async () => {
  const model = new FakeModel(['林岚翻开账本。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'canon', 'style.md'), '改过的文风约束\n')
    const blocked = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(blocked.code, 3)
    const payload = parseJson<{ error: { message: string } }>(blocked.stdout)
    assert.match(payload.error.message, /设定在合同检查后已修改/)
    assert.equal(model.requests.length, 0)
    const rechecked = await checkContract(dir, 1)
    assert.equal(rechecked.code, 0, rechecked.stderr)
    const written = await runCli(dir, ['write', '--json', '1'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiple required materials that individually fit but collectively overflow return split-required', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '2600', '--max-output', '1000'])
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      knows: [{ fact: '账本缺页', fromChapter: 1 }],
    }])
    await setContract(dir, 1)
    await writeFile(path.join(dir, 'canon', 'style.md'), '风'.repeat(800))
    await writeFile(path.join(dir, 'canon', 'world.md'), '海'.repeat(800))
    const checked = await checkContract(dir, 1)
    assert.equal(checked.code, 0, checked.stderr)
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 3, written.stderr)
    const payload = parseJson<{ error: { details: { decision: string } } }>(written.stdout)
    assert.equal(payload.error.details.decision, 'split-required')
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('generation events are ordered and cancellation emits a cancelled terminal event', async () => {
  const model = new FakeModel(['这是一段会被取消的长文字，用来验证流式事件。'], 'slow')
  await model.start()
  const dir = await initBook(model.baseUrl, ['--context-window', '8192', '--max-output', '1024'])
  try {
    await contract1(dir)
    const run = spawnCli(dir, ['write', '1', '--events', '--cancel-after-ms', '180'], { WEAVE_API_KEY: SECRET })
    await waitFor(() => run.output().includes('"type":"delta"'))
    const result = await Promise.race([
      run.done,
      new Promise<CliResult>(resolve => setTimeout(() => {
        run.child.kill('SIGKILL')
        resolve({ code: -1, stdout: run.output(), stderr: 'timeout' })
      }, 8000)),
    ])
    assert.equal(result.code, 5, result.stderr)
    const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
      type: string
      seq: number
    })
    assert.equal(events[0]?.type, 'started')
    assert.equal(events[events.length - 1]?.type, 'cancelled')
    assert.ok(events.some(event => event.type === 'delta'))
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index]!.seq, events[index - 1]!.seq + 1)
    }
    const drafts = (await readdir(path.join(dir, 'chapters', 'drafts'))).filter(name => name.endsWith('.md'))
    assert.deepEqual(drafts, [])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for condition')
}

test('migrates a v1 project with a pre-migration backup', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const projectFile = path.join(dir, '.weave', 'project.json')
    const configFile = path.join(dir, '.weave', 'config.json')
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    const config = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>
    project.schemaVersion = 1
    delete config.snapshotEvery
    await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`)
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)

    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 0, status.stderr)
    const payload = parseJson<{ schemaVersion: number; workflowVersion: number }>(status.stdout)
    assert.equal(payload.schemaVersion, 3)
    assert.equal(payload.workflowVersion, 1)
    const migrated = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    assert.equal(migrated.schemaVersion, 3)
    assert.equal(migrated.workflowVersion, 1)
    const migratedConfig = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>
    assert.equal(migratedConfig.snapshotEvery, 10)
    const backups = await readdir(path.join(dir, '.weave', 'backups'))
    assert.equal(backups.length, 1)
    const backupProject = JSON.parse(
      await readFile(path.join(dir, '.weave', 'backups', backups[0]!, 'project.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.equal(backupProject.schemaVersion, 1)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration failure keeps the original project and leaves a backup', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const projectFile = path.join(dir, '.weave', 'project.json')
    const configFile = path.join(dir, '.weave', 'config.json')
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    project.schemaVersion = 1
    await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`)
    await rm(configFile, { force: true })

    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 4)
    const untouched = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    assert.equal(untouched.schemaVersion, 1)
    const backups = await readdir(path.join(dir, '.weave', 'backups'))
    assert.equal(backups.length, 1)
    assert.match(await readFile(path.join(dir, '.weave', 'backups', backups[0]!, 'project.json'), 'utf8'), /"schemaVersion": 1/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('refuses a future schema without modifying the project', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    const projectFile = path.join(dir, '.weave', 'project.json')
    const project = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    project.schemaVersion = 99
    await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`)
    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 4)
    const payload = parseJson<{ error: { message: string } }>(status.stdout)
    assert.match(payload.error.message, /高于当前支持/)
    const untouched = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    assert.equal(untouched.schemaVersion, 99)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('golden 8-chapter project supports amend, snapshot replay, impact revision and acceptance', async () => {
  const texts = Array.from({ length: 8 }, (_, index) => `第${index + 1}章正文：林岚推进账本线索，第${index + 1}次确认缺页。`)
  const model = new FakeModel(texts)
  await model.start()
  const dir = await initBook(model.baseUrl, [
    '--context-window', '8192',
    '--max-output', '1024',
    '--snapshot-every', '2',
  ])
  try {
    await contract1(dir)
    for (let chapter = 2; chapter <= 8; chapter += 1) {
      await setContract(dir, chapter)
      const checked = await checkContract(dir, chapter)
      assert.equal(checked.code, 0, checked.stderr)
    }
    for (let chapter = 1; chapter <= 8; chapter += 1) {
      const result = await writeAndFinalize(dir, chapter)
      assert.ok(result.commitId)
    }
    const requestBodies = model.requests.map(request => JSON.stringify(request))
    assert.ok(requestBodies[0]?.includes('后续计划（不是既成事实）'))
    assert.ok(requestBodies.some(body => body.includes('已定稿章节索引（仅定位）')))
    const status = parseJson<{ chapters: unknown[]; mainlineRevision: number }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status.chapters.length, 8)
    assert.equal(status.mainlineRevision, 8)

    const amended = await runCli(dir, ['amend', '3', '--json'])
    assert.equal(amended.code, 0, amended.stderr)
    await writeFile(path.join(dir, 'chapters', 'drafts', '003.md'), '第三章修订：林岚发现缺页来自港务局。\n')
    const finalized = await runCli(dir, ['finalize', '3', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)
    const finalPayload = parseJson<{
      projection: { replayBaseChapter: number | null; invalidFrom: number | null; status: string }
      impact: { items: Array<{ targetChapter: number }> }
      draftEdited: boolean
    }>(finalized.stdout)
    assert.equal(finalPayload.draftEdited, true)
    assert.equal(finalPayload.projection.status, 'current')
    assert.equal(finalPayload.projection.invalidFrom, 3)
    assert.equal(finalPayload.projection.replayBaseChapter, 2)
    assert.deepEqual(
      finalPayload.impact.items.map(item => item.targetChapter),
      [4, 5, 6, 7, 8],
    )

    const revise = await runCli(dir, ['resolve-impact', '3', '--target', '4', '--decision', 'revise', '--json'])
    assert.equal(revise.code, 0, revise.stderr)
    const revisePayload = parseJson<{ revised: number[] }>(revise.stdout)
    assert.deepEqual(revisePayload.revised, [4])
    assert.match(await readFile(path.join(dir, 'chapters', 'drafts', '004.md'), 'utf8'), /第4章正文/)

    const accepted = await runCli(dir, ['resolve-impact', '3', '--all', '--decision', 'accept', '--json'])
    assert.equal(accepted.code, 0, accepted.stderr)
    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr)

    const exported = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const merged = await readFile(path.join(dir, 'exports', 'book-merged.md'), 'utf8')
    for (let chapter = 1; chapter <= 8; chapter += 1) {
      assert.match(merged, new RegExp(`第${chapter}章`))
    }
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

const P05_DRAFT = '林岚在码头翻开账本。\n\n她发现缺页上留着港务局的印。'

function extractionPayload(quote = '她发现缺页上留着港务局的印。', timeline = true): string {
  return JSON.stringify({
    summary: '林岚发现账本缺页。',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚发现账本缺页',
      participants: ['林岚'],
      location: '海港',
      storyTime: '第一天',
      payload: {},
      evidence: [{ quote, occurrence: 1 }],
    }],
    timeline: timeline
      ? [{
          eventId: 'e1',
          recordId: 'r1',
          summary: '林岚发现账本缺页',
          dayOffset: 0,
          durationDays: 0,
          participants: ['林岚'],
          causedBy: [],
          type: 'main',
          evidence: [{ quote: '林岚在码头翻开账本。', occurrence: 1 }],
        }]
      : [],
  })
}

function reviewPayload(blocking = false): string {
  return JSON.stringify({
    summary: blocking ? '存在阻断问题' : '整体成立',
    findings: [{
      dimension: '叙事衔接',
      severity: blocking ? 'blocking' : 'warning',
      description: blocking ? '缺页来源没有交代' : '章末可以更具体',
      quote: '她发现缺页上留着港务局的印。',
      occurrence: 1,
    }],
  })
}

async function prepareP05(model: FakeModel): Promise<string> {
  const dir = await initBook(model.baseUrl, [], 'p05')
  await contract1(dir)
  const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
  assert.equal(written.code, 0, written.stderr)
  const checked = await runCli(dir, ['check', '1', '--json'])
  assert.equal(checked.code, 0, checked.stderr)
  return dir
}

test('P0.5 workflow produces an evidence-backed commit v2', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    const extraction = parseJson<{ passed: boolean; records: Array<{ evidence: Array<{ byteStart: number }> }> }>(extracted.stdout)
    assert.equal(extraction.passed, true)
    assert.ok(extraction.records[0]!.evidence[0]!.byteStart >= 0)

    const timeline = await runCli(dir, ['timeline', '1', '--json'])
    assert.equal(timeline.code, 0, timeline.stdout + timeline.stderr)

    const audited = await runCli(dir, ['audit', '1', '--json'])
    assert.equal(audited.code, 0, audited.stdout + audited.stderr)
    const audit = parseJson<{ passed: boolean; contract: { missed: string[] }; timeline: { passed: boolean } }>(audited.stdout)
    assert.equal(audit.passed, true)
    assert.deepEqual(audit.contract.missed, [])
    assert.equal(audit.timeline.passed, true)

    const reviewed = await runCli(dir, ['review', '1', '--json'])
    assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr)

    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
    const payload = parseJson<{
      commit: { schemaVersion: number; evidenceCount: number; extractionHash: string; reviewHash: string }
    }>(finalized.stdout)
    assert.equal(payload.commit.schemaVersion, 2)
    assert.equal(payload.commit.evidenceCount, 1)
    assert.ok(payload.commit.extractionHash)
    assert.ok(payload.commit.reviewHash)

    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 rejects evidence that cannot be located in the draft', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload('正文中不存在的引文')])
  await model.start()
  const dir = await prepareP05(model)
  try {
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 3, extracted.stderr)
    const payload = parseJson<{ passed: boolean; rejected: Array<{ reason: string }> }>(extracted.stdout)
    assert.equal(payload.passed, false)
    assert.ok(payload.rejected.some(item => item.reason.includes('不在草稿中')))
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 3)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 timeline errors block the coverage audit', async () => {
  const extraction = JSON.parse(extractionPayload()) as Record<string, unknown>
  extraction.timeline = [
    {
      eventId: 'e1',
      recordId: 'r1',
      summary: '先发生',
      dayOffset: 0,
      durationDays: 5,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote: '林岚在码头翻开账本。', occurrence: 1 }],
    },
    {
      eventId: 'e2',
      recordId: 'r1',
      summary: '与上一事件重叠',
      dayOffset: 3,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    },
  ]
  const model = new FakeModel([P05_DRAFT, JSON.stringify(extraction)])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    const audited = await runCli(dir, ['audit', '1', '--json'])
    assert.equal(audited.code, 3)
    const payload = parseJson<{ passed: boolean; timeline: { errors: string[] } }>(audited.stdout)
    assert.equal(payload.passed, false)
    assert.ok(payload.timeline.errors.some(error => error.includes('重叠')))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 blocking review returns exit code 7 and prevents finalization', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), reviewPayload(true)])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const reviewed = await runCli(dir, ['review', '1', '--json'])
    assert.equal(reviewed.code, 7)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 7)
    const commits = path.join(dir, 'ledger', 'commits')
    assert.deepEqual((await readdir(commits)).filter(name => name.endsWith('.json')), [])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 stage reports are invalidated when the draft changes', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), `${P05_DRAFT}\n\n新增一段。\n`)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 4)
    const payload = parseJson<{ error: { message: string } }>(finalized.stdout)
    assert.match(payload.error.message, /草稿已变化/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 content check blocks extraction before any model call', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'TODO 待补本章正文。\n')
    const checked = await runCli(dir, ['check', '1', '--json'])
    assert.equal(checked.code, 3)
    const payload = parseJson<{ passed: boolean; findings: Array<{ code: string }> }>(checked.stdout)
    assert.equal(payload.passed, false)
    assert.ok(payload.findings.some(finding => finding.code === 'PLACEHOLDER'))
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 3)
    assert.equal(model.requests.length, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 audit fails when a contract node is not covered', async () => {
  const extraction = JSON.parse(extractionPayload()) as Record<string, unknown>
  const records = extraction.records as Array<Record<string, unknown>>
  records[0]!.summary = '无关事件'
  const model = new FakeModel([P05_DRAFT, JSON.stringify(extraction)])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    const audited = await runCli(dir, ['audit', '1', '--json'])
    assert.equal(audited.code, 3)
    const payload = parseJson<{ passed: boolean; contract: { missed: string[] } }>(audited.stdout)
    assert.equal(payload.passed, false)
    assert.deepEqual(payload.contract.missed, ['林岚发现账本缺页'])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 duplicate evidence requires an occurrence and is rejected without one', async () => {
  const duplicateDraft = '林岚看着账本。\n\n林岚看着账本。'
  const extraction = {
    summary: '重复引文',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚看着账本',
      participants: ['林岚'],
      payload: {},
      evidence: [{ quote: '林岚看着账本。' }],
    }],
    timeline: [],
  }
  const model = new FakeModel([JSON.stringify(extraction)])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), duplicateDraft)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 3)
    const payload = parseJson<{ passed: boolean; rejected: Array<{ reason: string }> }>(extracted.stdout)
    assert.equal(payload.passed, false)
    assert.ok(payload.rejected.some(item => item.reason.includes('无法唯一确定')))
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
