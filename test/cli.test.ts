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

test('P1.7 requires explicit visibleKnowledge for omniscient contracts', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await setContract(dir, 1, { narrativeMode: 'omniscient' })
    const rejected = await checkContract(dir, 1)
    assert.equal(rejected.code, 3)
    assert.ok(parseJson<{ errors: Array<{ code: string }> }>(rejected.stdout)
      .errors.some(error => error.code === 'OMNISCIENT_WITHOUT_VISIBLE_KNOWLEDGE'))
    await setContract(dir, 1, {
      narrativeMode: 'omniscient',
      visibleKnowledge: ['账本缺页'],
    })
    const accepted = await checkContract(dir, 1)
    assert.equal(accepted.code, 0, accepted.stderr)
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
      impact: { items: Array<{ targetChapter: number; level: string; dependencies: string[] }> }
      projection: { status: string; invalidFrom: number | null }
      draftEdited: boolean
    }>(finalized.stdout)
    assert.equal(payload.commit.revision, 2)
    assert.equal(payload.impact.items[0]?.targetChapter, 2)
    assert.equal(payload.impact.items[0]?.level, 'confirmed')
    assert.ok(payload.impact.items[0]?.dependencies.includes('character:林岚'))
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
    assert.equal(payload.schemaVersion, 4)
    assert.equal(payload.workflowVersion, 1)
    const migrated = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>
    assert.equal(migrated.schemaVersion, 4)
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

function coveragePayload(): string {
  return JSON.stringify({
    summary: '第二遍未发现遗漏',
    missed: [],
  })
}

function ledgerExtractionPayload(
  facts: unknown[] = [{
    factId: 'fact-lin-location',
    subject: '林岚',
    predicate: 'location',
    object: '海港',
    validFromChapter: 1,
    validToChapter: null,
    sourceRecordId: 'r1',
    origin: 'derived',
    supersedes: null,
    confidence: 0.9,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }],
  beliefs: unknown[] = [{
    beliefId: 'belief-lin-ledger',
    characterId: '林岚',
    proposition: '账本缺页与港务局有关',
    attitude: 'knows',
    sourceRecordId: 'r1',
    learnedAtChapter: 1,
    confidence: 0.6,
    validFromChapter: 1,
    validToChapter: null,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }],
): string {
  const extraction = JSON.parse(extractionPayload()) as Record<string, unknown>
  extraction.facts = facts
  extraction.beliefs = beliefs
  return JSON.stringify(extraction)
}

function loopExtractionPayload(loops: unknown[]): string {
  const extraction = JSON.parse(ledgerExtractionPayload()) as Record<string, unknown>
  extraction.loops = loops
  return JSON.stringify(extraction)
}

function chapter3Extraction(quote: string): string {
  return JSON.stringify({
    summary: '林岚发现账本缺页。',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚发现账本缺页',
      participants: ['林岚'],
      location: '海港',
      storyTime: '第三天',
      payload: {},
      evidence: [{ quote, occurrence: 1 }],
    }],
    timeline: [{
      eventId: 'e1',
      recordId: 'r1',
      summary: '林岚发现账本缺页',
      dayOffset: 0,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote, occurrence: 1 }],
    }],
    facts: [],
    beliefs: [],
    loops: [],
  })
}

function warningReviewFor(quote: string): string {
  return JSON.stringify({
    summary: '仅建议',
    findings: [{
      dimension: '叙事衔接',
      severity: 'warning',
      description: '段落可以更紧',
      quote,
      occurrence: 1,
    }],
  })
}

function reviewFor(quote: string): string {
  return JSON.stringify({
    summary: '存在阻断问题',
    findings: [{
      dimension: '叙事衔接',
      severity: 'blocking',
      description: '缺页来源没有交代',
      quote,
      occurrence: 1,
    }],
  })
}

function revisionFor(text: string): string {
  return JSON.stringify({
    paragraphs: [{ paragraphId: 'p001', text, findingIds: ['f1'] }],
  })
}

function recheckFor(quote: string): string {
  return JSON.stringify({
    summary: '复检通过',
    findings: [{ findingId: 'f1', resolved: true, quote, note: '已修复' }],
    newFindings: [],
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

test('P0.5 workflow produces an evidence-backed commit v3', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload()])
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
    assert.equal(payload.commit.schemaVersion, 3)
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
  const model = new FakeModel([P05_DRAFT, JSON.stringify(extraction), coveragePayload()])
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
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload(true)])
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
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload()])
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

test('P0.5 second-pass coverage audit blocks when it finds a missed event', async () => {
  const missed = JSON.stringify({
    summary: '第二遍发现遗漏',
    missed: [{
      summary: '林岚其实已经把信交给了港务局',
      quote: '她发现缺页上留着港务局的印。',
      occurrence: 1,
    }],
  })
  const model = new FakeModel([P05_DRAFT, extractionPayload(), missed])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    const audited = await runCli(dir, ['audit', '1', '--json'])
    assert.equal(audited.code, 3)
    const payload = parseJson<{ passed: boolean; secondPass: { missed: string[] } }>(audited.stdout)
    assert.equal(payload.passed, false)
    assert.deepEqual(payload.secondPass.missed, ['林岚其实已经把信交给了港务局'])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0.5 audit fails when a contract node is not covered', async () => {
  const extraction = JSON.parse(extractionPayload()) as Record<string, unknown>
  const records = extraction.records as Array<Record<string, unknown>>
  records[0]!.summary = '无关事件'
  const model = new FakeModel([P05_DRAFT, JSON.stringify(extraction), coveragePayload()])
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

test('P1.1 writes a v3 ledger and exposes event/fact/entity/belief queries', async () => {
  const model = new FakeModel([P05_DRAFT, ledgerExtractionPayload(), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
    const payload = parseJson<{
      commit: {
        schemaVersion: number
        ledgerHash: string
        eventCount: number
        factCount: number
        beliefCount: number
        ledger: { contract: { chapter: number; planned: string[] } }
      }
    }>(finalized.stdout)
    assert.equal(payload.commit.schemaVersion, 3)
    assert.ok(payload.commit.ledgerHash)
    assert.equal(payload.commit.eventCount, 1)
    assert.equal(payload.commit.factCount, 1)
    assert.equal(payload.commit.beliefCount, 1)
    assert.equal(payload.commit.ledger.contract.chapter, 1)
    assert.deepEqual(payload.commit.ledger.contract.planned, ['林岚发现账本缺页'])

    const event = await runCli(dir, ['ledger', 'event', 'event-1-r1', '--json'])
    assert.equal(event.code, 0, event.stderr)
    const eventPayload = parseJson<{ record: { eventId: string } }>(event.stdout)
    assert.equal(eventPayload.record.eventId, 'event-1-r1')

    const fact = await runCli(dir, ['ledger', 'fact', 'fact-lin-location', '--json'])
    assert.equal(fact.code, 0, fact.stderr)
    const factPayload = parseJson<{ record: { factId: string } }>(fact.stdout)
    assert.equal(factPayload.record.factId, 'fact-lin-location')

    const entity = await runCli(dir, ['ledger', 'entity', '林岚', '--chapter', '1', '--json'])
    assert.equal(entity.code, 0, entity.stderr)
    const entityPayload = parseJson<{ facts: Array<{ factId: string }> }>(entity.stdout)
    assert.deepEqual(entityPayload.facts.map(item => item.factId), ['fact-lin-location'])

    const beliefs = await runCli(dir, ['ledger', 'beliefs', '林岚', '--chapter', '1', '--json'])
    assert.equal(beliefs.code, 0, beliefs.stderr)
    const beliefPayload = parseJson<{ beliefs: Array<{ beliefId: string; attitude: string }> }>(beliefs.stdout)
    assert.equal(beliefPayload.beliefs[0]?.beliefId, 'belief-lin-ledger')
    assert.equal(beliefPayload.beliefs[0]?.attitude, 'knows')

    const doctorResult = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctorResult.code, 0, doctorResult.stdout + doctorResult.stderr)

    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 0, status.stderr)
    const statusPayload = parseJson<{
      ledgerProjection: { status: string; appliedThrough: number }
      ledgerProjections: Array<{ name: string; status: string }>
    }>(status.stdout)
    assert.equal(statusPayload.ledgerProjection.status, 'current')
    assert.equal(statusPayload.ledgerProjection.appliedThrough, 1)
    assert.deepEqual(
      statusPayload.ledgerProjections.map(item => item.name).sort(),
      ['belief', 'entity-state', 'ledger-index', 'open-loop', 'series-timeline'],
    )
    assert.ok(statusPayload.ledgerProjections.every(item => item.status === 'current'))
    const rebuilt = await runCli(dir, ['rebuild', '--projection', 'ledger', '--from', '1', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    assert.equal(parseJson<{ ledgerProjection: { status: string } }>(rebuilt.stdout).ledgerProjection.status, 'current')
    const aliasRebuild = await runCli(dir, ['rebuild', '--projection', 'entity-state', '--from', '1', '--json'])
    assert.equal(aliasRebuild.code, 0, aliasRebuild.stderr)
    assert.equal(
      parseJson<{ ledgerProjection: { name: string } }>(aliasRebuild.stdout).ledgerProjection.name,
      'entity-state',
    )
    const beliefRebuild = await runCli(dir, ['rebuild', '--projection', 'belief', '--json'])
    assert.equal(beliefRebuild.code, 0, beliefRebuild.stderr)
    assert.equal(parseJson<{ ledgerProjection: { name: string } }>(beliefRebuild.stdout).ledgerProjection.name, 'belief')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.1 supersedes old facts for current entity queries', async () => {
  const oldFact = {
    factId: 'fact-old-location',
    subject: '林岚',
    predicate: 'location',
    object: '海港',
    validFromChapter: 1,
    validToChapter: null,
    sourceRecordId: 'r1',
    origin: 'derived',
    supersedes: null,
    confidence: 0.9,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }
  const newFact = {
    ...oldFact,
    factId: 'fact-new-location',
    object: '码头',
    supersedes: 'fact-old-location',
  }
  const model = new FakeModel([
    P05_DRAFT,
    ledgerExtractionPayload([oldFact, newFact], []),
    coveragePayload(),
    reviewPayload(),
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    const entity = await runCli(dir, ['ledger', 'entity', '林岚', '--chapter', '1', '--json'])
    const payload = parseJson<{ facts: Array<{ factId: string }> }>(entity.stdout)
    assert.deepEqual(payload.facts.map(item => item.factId), ['fact-new-location'])
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.1 candidate facts are stored but cannot be queried', async () => {
  const candidate = {
    factId: 'fact-candidate',
    subject: '林岚',
    predicate: 'location',
    object: '未知港口',
    validFromChapter: 1,
    validToChapter: null,
    sourceRecordId: 'r1',
    origin: 'candidate',
    supersedes: null,
    confidence: 0.3,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }
  const model = new FakeModel([P05_DRAFT, ledgerExtractionPayload([candidate], []), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    const entity = await runCli(dir, ['ledger', 'entity', '林岚', '--chapter', '1', '--json'])
    assert.equal(parseJson<{ facts: unknown[] }>(entity.stdout).facts.length, 0)
    const fact = await runCli(dir, ['ledger', 'fact', 'fact-candidate', '--json'])
    assert.equal(fact.code, 3)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.1 rejects invalid fact references and ranges at finalize', async () => {
  const cases = [
    {
      label: 'unknown subject',
      facts: [{
        factId: 'fact-bad-subject',
        subject: '不存在的人',
        predicate: 'location',
        object: '海港',
        validFromChapter: 1,
        validToChapter: null,
        origin: 'derived',
        confidence: 1,
        evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
      }],
    },
    {
      label: 'invalid range',
      facts: [{
        factId: 'fact-bad-range',
        subject: '林岚',
        predicate: 'location',
        object: '海港',
        validFromChapter: 2,
        validToChapter: 1,
        origin: 'derived',
        confidence: 1,
        evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
      }],
    },
  ]
  for (const item of cases) {
    const model = new FakeModel([
      P05_DRAFT,
      ledgerExtractionPayload(item.facts, []),
      coveragePayload(),
      reviewPayload(),
    ])
    await model.start()
    const dir = await prepareP05(model)
    try {
      assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0, item.label)
      assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0, item.label)
      assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0, item.label)
      const finalized = await runCli(dir, ['finalize', '1', '--json'])
      assert.equal(finalized.code, 3, item.label)
    } finally {
      await model.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('P1.1 rejects duplicate fact IDs and supersede cycles', async () => {
  const baseFact = {
    subject: '林岚',
    predicate: 'location',
    object: '海港',
    validFromChapter: 1,
    validToChapter: null,
    origin: 'derived',
    confidence: 0.9,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }
  const duplicateModel = new FakeModel([
    P05_DRAFT,
    ledgerExtractionPayload([
      { ...baseFact, factId: 'fact-duplicate' },
      { ...baseFact, factId: 'fact-duplicate' },
    ], []),
  ])
  await duplicateModel.start()
  const duplicateDir = await prepareP05(duplicateModel)
  try {
    const extracted = await runCli(duplicateDir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 3)
    const payload = parseJson<{ rejected: Array<{ reason: string }> }>(extracted.stdout)
    assert.ok(payload.rejected.some(item => item.reason.includes('事实 ID 重复')))
  } finally {
    await duplicateModel.close()
    await rm(duplicateDir, { recursive: true, force: true })
  }

  const cycleModel = new FakeModel([
    P05_DRAFT,
    ledgerExtractionPayload([
      { ...baseFact, factId: 'fact-a', supersedes: 'fact-b' },
      { ...baseFact, factId: 'fact-b', supersedes: 'fact-a' },
    ], []),
    coveragePayload(),
    reviewPayload(),
  ])
  await cycleModel.start()
  const cycleDir = await prepareP05(cycleModel)
  try {
    assert.equal((await runCli(cycleDir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(cycleDir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(cycleDir, ['review', '1', '--json'])).code, 0)
    const finalized = await runCli(cycleDir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 3)
    const payload = parseJson<{ error: { details: string[] } }>(finalized.stdout)
    assert.ok(payload.error.details.some(error => error.includes('循环')))
  } finally {
    await cycleModel.close()
    await rm(cycleDir, { recursive: true, force: true })
  }
})

test('P1.1 keeps v2 commits readable while ledger queries ignore them', async () => {
  const model = new FakeModel([])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '旧版正文。\n')
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
    const commitDir = path.join(dir, 'ledger', 'commits')
    const name = (await readdir(commitDir)).find(item => item.endsWith('.json'))!
    const commitFile = path.join(commitDir, name)
    const commit = JSON.parse(await readFile(commitFile, 'utf8')) as Record<string, unknown>
    commit.schemaVersion = 2
    delete commit.ledger
    delete commit.ledgerHash
    delete commit.eventCount
    delete commit.factCount
    delete commit.beliefCount
    await writeFile(commitFile, `${JSON.stringify(commit, null, 2)}\n`)

    const status = await runCli(dir, ['status', '--json'])
    assert.equal(status.code, 0, status.stdout + status.stderr)
    const exported = await runCli(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const ledger = await runCli(dir, ['ledger', 'event', 'event-1-r1', '--json'])
    assert.equal(ledger.code, 3)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.2 exposes state/knowledge and keeps non-POV beliefs out of the prompt', async () => {
  const beliefs = [{
    beliefId: 'belief-lin-ledger',
    characterId: '林岚',
    proposition: '账本缺页与港务局有关',
    attitude: 'knows',
    sourceRecordId: 'r1',
    learnedAtChapter: 1,
    confidence: 0.6,
    validFromChapter: 1,
    validToChapter: null,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }, {
    beliefId: 'belief-zhou-secret',
    characterId: '周',
    proposition: '林岚偷走了账本',
    attitude: 'believes',
    sourceRecordId: 'r1',
    learnedAtChapter: 1,
    confidence: 0.5,
    validFromChapter: 1,
    validToChapter: null,
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }]
  const model = new FakeModel([
    P05_DRAFT,
    ledgerExtractionPayload([
      {
        factId: 'fact-lin-location',
        subject: '林岚',
        predicate: 'location',
        object: '海港',
        validFromChapter: 1,
        validToChapter: null,
        sourceRecordId: 'r1',
        origin: 'derived',
        confidence: 0.9,
        evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
      },
    ], beliefs),
    coveragePayload(),
    reviewPayload(),
    '第二章正文：林岚继续查账。\n',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await setCharacters(dir, [
      { name: '林岚', status: 'alive', introducedIn: 1, knows: [{ fact: '账本缺页', fromChapter: 1 }] },
      { name: '周', status: 'alive', introducedIn: 1 },
    ])
    await setContract(dir, 1, { characters: ['林岚', '周'] })
    assert.equal((await checkContract(dir, 1)).code, 0)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    const state = await runCli(dir, ['state', '林岚', '--chapter', '1', '--json'])
    assert.equal(state.code, 0, state.stderr)
    const statePayload = parseJson<{ facts: Array<{ factId: string }>; attributes: Record<string, string> }>(state.stdout)
    assert.equal(statePayload.facts[0]?.factId, 'fact-lin-location')
    assert.equal(statePayload.attributes.location, '海港')
    const knowledge = await runCli(dir, ['knowledge', '周', '--chapter', '1', '--json'])
    assert.equal(knowledge.code, 0, knowledge.stderr)
    assert.ok(parseJson<{ beliefs: Array<{ beliefId: string }> }>(knowledge.stdout).beliefs.some(item => item.beliefId === 'belief-zhou-secret'))

    await setContract(dir, 2, {
      characters: ['林岚', '周'],
      pov: '林岚',
      knowledge: [{ character: '林岚', fact: '不存在的秘密' }],
    })
    assert.equal((await checkContract(dir, 2)).code, 3)
    assert.equal((await runCli(dir, ['knowledge', 'check', '2', '--json'])).code, 3)
    const requestsBeforeBlock = model.requests.length
    assert.equal((await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })).code, 3)
    assert.equal(model.requests.length, requestsBeforeBlock)

    await setContract(dir, 2, {
      characters: ['林岚', '周'],
      pov: '林岚',
      knowledge: [{ character: '林岚', fact: '账本缺页与港务局有关' }],
    })
    assert.equal((await checkContract(dir, 2)).code, 0)
    assert.equal((await runCli(dir, ['knowledge', 'check', '2', '--json'])).code, 0)
    const written = await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
    const body = JSON.stringify(model.requests[4])
    assert.equal(body.includes('林岚偷走了账本'), false)
    assert.ok(body.includes('账本缺页与港务局有关'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.3 tracks loop lifecycle and series timeline', async () => {
  const loops = [{
    loopId: 'loop-ledger',
    kind: 'plant',
    summary: '账本缺页的来源',
    targetFromChapter: 2,
    targetToChapter: 5,
    relatedEntities: ['林岚'],
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }, {
    loopId: 'loop-ledger',
    kind: 'advance',
    summary: '港务局印被确认',
    relatedEntities: ['林岚'],
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }, {
    loopId: 'loop-ledger',
    kind: 'payoff',
    summary: '账本来源揭晓',
    relatedEntities: ['林岚'],
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }]
  const model = new FakeModel([P05_DRAFT, loopExtractionPayload(loops), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    const list = await runCli(dir, ['loops', 'list', '--json'])
    assert.equal(list.code, 0, list.stderr)
    const payload = parseJson<{ loops: Array<{ loopId: string; status: string; paidOffChapter: number }> }>(list.stdout)
    assert.equal(payload.loops[0]?.loopId, 'loop-ledger')
    assert.equal(payload.loops[0]?.status, 'paid_off')
    assert.equal(payload.loops[0]?.paidOffChapter, 1)

    const timeline = await runCli(dir, ['timeline', 'series', '--json'])
    assert.equal(timeline.code, 0, timeline.stderr)
    assert.equal(parseJson<{ passed: boolean; events: unknown[] }>(timeline.stdout).passed, true)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.3 rejects a payoff before planting', async () => {
  const loops = [{
    loopId: 'loop-unplanted',
    kind: 'payoff',
    summary: '从未埋设的伏笔',
    relatedEntities: ['林岚'],
    evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
  }]
  const model = new FakeModel([P05_DRAFT, loopExtractionPayload(loops), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 3)
    const payload = parseJson<{ error: { details: string[] } }>(finalized.stdout)
    assert.ok(payload.error.details.some(error => error.includes('尚未埋设')))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.5 project-scoped waiver suppresses a blocking finding', async () => {
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    reviewPayload(true),
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const firstReview = await runCli(dir, ['review', '1', '--json'])
    assert.equal(firstReview.code, 7)
    const waived = await runCli(dir, [
      'waive', '1', '--finding', 'f1', '--reason', '这是作者有意保留的模糊点', '--scope', 'project', '--json',
    ])
    assert.equal(waived.code, 0, waived.stderr)
    const listed = await runCli(dir, ['waivers', 'list', '--json'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.equal(parseJson<{ waivers: unknown[] }>(listed.stdout).waivers.length, 1)
    const waiverAudit = await readFile(path.join(dir, '.weave', 'waivers.log.jsonl'), 'utf8')
    assert.match(waiverAudit, /"event":"create"/)

    const secondReview = await runCli(dir, ['review', '1', '--json'])
    assert.equal(secondReview.code, 0, secondReview.stdout + secondReview.stderr)
    const reviewPayloadResult = parseJson<{ passed: boolean; findings: Array<{ status: string }> }>(secondReview.stdout)
    assert.equal(reviewPayloadResult.passed, true)
    assert.equal(reviewPayloadResult.findings[0]?.status, 'waived')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 revises only selected findings, merges, rechecks and finalizes', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const recheck = JSON.stringify({
    summary: '复检通过',
    findings: [{
      findingId: 'f1',
      resolved: true,
      note: '已补充追查动机',
      quote: '她发现缺页上留着港务局的印，决定追查下去。',
    }],
    newFindings: [],
  })
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    revision,
    extractionPayload('她发现缺页上留着港务局的印'),
    coveragePayload(),
    recheck,
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const before = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    assert.equal(revised.code, 0, revised.stderr)
    const revisionPayload = parseJson<{
      exitCode: number
      revisionId: string
      plan: { findings: Array<{ status: string }> }
    }>(revised.stdout)
    assert.equal(revisionPayload.exitCode, 0)
    assert.equal(revisionPayload.plan.findings[0]?.status, 'applied')
    assert.equal(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), before)

    const merged = await runCli(dir, ['merge', '1', '--revision', revisionPayload.revisionId, '--json'])
    assert.equal(merged.code, 0, merged.stderr)
    assert.equal(parseJson<{ exitCode: number }>(merged.stdout).exitCode, 0)
    const mergedText = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.match(mergedText, /决定追查下去/)
    assert.match(mergedText, /林岚在码头翻开账本/)

    const staleExtract = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(staleExtract.code, 4)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const rechecked = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(rechecked.code, 0, rechecked.stdout + rechecked.stderr)
    const report = parseJson<{ passed: boolean; exitCode: number; findings: Array<{ status: string }> }>(rechecked.stdout)
    assert.equal(report.passed, true)
    assert.equal(report.exitCode, 0)
    assert.equal(report.findings[0]?.status, 'verified')
    const recheckBody = JSON.stringify(model.requests[7])
    assert.ok(recheckBody.includes('她发现缺页上留着港务局的印，决定追查下去。'))
    assert.equal(recheckBody.includes('林岚在码头翻开账本。'), false)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 reports manual/revision conflicts and resolves by choice', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    revision,
    extractionPayload('她发现缺页上留着港务局的印，但她决定先不声张'),
    coveragePayload(),
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const noSelection = await runCli(dir, ['revise', '1', '--json'])
    assert.equal(noSelection.code, 2)
    assert.equal(model.requests.length, 4)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    const revisionId = parseJson<{ revisionId: string }>(revised.stdout).revisionId
    assert.equal(model.requests.length, 5, `unexpected model calls: ${model.requests.length}`)
    const noMerge = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(noMerge.code, 4)
    assert.equal(model.requests.length, 5)
    await writeFile(
      path.join(dir, 'chapters', 'drafts', '001.md'),
      '林岚在码头翻开账本。\n\n她发现缺页上留着港务局的印，但她决定先不声张。\n',
    )
    const conflict = await runCli(dir, ['merge', '1', '--revision', revisionId, '--json'])
    assert.equal(conflict.code, 3)
    const conflictPayload = parseJson<{
      exitCode: number
      report: { status: string; hunks: Array<{ status: string; paragraphId: string }> }
    }>(conflict.stdout)
    assert.equal(conflictPayload.exitCode, 3)
    assert.equal(conflictPayload.report.status, 'conflict')
    assert.ok(conflictPayload.report.hunks.some(hunk => hunk.status === 'conflict' && hunk.paragraphId === 'p002'))
    assert.match(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), /先不声张/)

    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const conflictExtract = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(conflictExtract.code, 0, conflictExtract.stdout + conflictExtract.stderr)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const conflictRecheck = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(conflictRecheck.code, 4)
    assert.equal(model.requests.length, 7)

    const resolved = await runCli(dir, [
      'merge', '1', '--revision', revisionId, '--choices', 'p002=manual', '--json',
    ])
    assert.equal(resolved.code, 0, resolved.stderr)
    const resolvedText = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.match(resolvedText, /先不声张/)
    assert.equal(resolvedText.includes('决定追查'), false)

    const ignored = await runCli(dir, ['ignore', '1', '--finding', 'f1', '--reason', '保留原意'])
    assert.equal(ignored.code, 3)
    assert.equal(model.requests.length, 7)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 recheck keeps unresolved blocking findings and appends new ones', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const recheck = JSON.stringify({
    summary: '仍未解决',
    findings: [{ findingId: 'f1', resolved: false, note: '仍缺少来源' }],
    newFindings: [{
      dimension: '叙事衔接',
      severity: 'warning',
      description: '复检新增建议',
      quote: '林岚在码头翻开账本。',
      occurrence: 1,
    }],
  })
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    revision,
    extractionPayload('她发现缺页上留着港务局的印'),
    coveragePayload(),
    recheck,
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const review = await runCli(dir, ['review', '1', '--json'])
    assert.equal(review.code, 7)
    const revisionPayload = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    assert.equal(revisionPayload.code, 0, revisionPayload.stderr)
    const revisionId = parseJson<{ revisionId: string }>(revisionPayload.stdout).revisionId
    assert.equal((await runCli(dir, ['merge', '1', '--revision', revisionId, '--json'])).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const rechecked = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(rechecked.code, 7)
    const report = parseJson<{
      passed: boolean
      exitCode: number
      blockingCount: number
      findings: Array<{ findingId: string; status: string }>
    }>(rechecked.stdout)
    assert.equal(report.passed, false)
    assert.equal(report.exitCode, 7)
    assert.equal(report.blockingCount, 1)
    assert.equal(report.findings[0]?.status, 'open')
    assert.equal(report.findings[1]?.findingId, 'f2')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 7)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 keeps manual-only and revision-only paragraphs independently', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    revision,
    extractionPayload('她发现缺页上留着港务局的印，但她决定先不声张'),
    coveragePayload(),
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    const revisionId = parseJson<{ revisionId: string }>(revised.stdout).revisionId
    await writeFile(
      path.join(dir, 'chapters', 'drafts', '001.md'),
      '林岚在清晨的码头翻开账本。\n\n她发现缺页上留着港务局的印。\n',
    )
    const merged = await runCli(dir, ['merge', '1', '--revision', revisionId, '--json'])
    assert.equal(merged.code, 0, merged.stderr)
    const mergedReport = parseJson<{ report: { hunks: Array<{ paragraphId: string; status: string }> } }>(merged.stdout)
    assert.equal(mergedReport.report.hunks.find(hunk => hunk.paragraphId === 'p001')?.status, 'manual-only')
    assert.equal(mergedReport.report.hunks.find(hunk => hunk.paragraphId === 'p002')?.status, 'revision-only')
    const text = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.match(text, /清晨的码头/)
    assert.match(text, /决定追查下去/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 runs two revision rounds on an 8-chapter project without losing history', async () => {
  const texts = Array.from(
    { length: 8 },
    (_, index) => `第${index + 1}章正文：林岚推进账本线索，第${index + 1}次确认缺页。`,
  )
  const original = texts[2]!
  const revised1 = '第3章修订：林岚查清账本缺页来自港务局。'
  const revised2 = '第3章再修：林岚拿到港务局缺页记录。'
  const model = new FakeModel([
    ...texts,
    chapter3Extraction(original),
    coveragePayload(),
    reviewFor(original),
    revisionFor(revised1),
    chapter3Extraction(revised1),
    coveragePayload(),
    recheckFor(revised1),
    chapter3Extraction(revised1),
    coveragePayload(),
    reviewFor(revised1),
    revisionFor(revised2),
    chapter3Extraction(revised2),
    coveragePayload(),
    recheckFor(revised2),
  ])
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
      assert.equal((await checkContract(dir, chapter)).code, 0)
    }
    for (let chapter = 1; chapter <= 8; chapter += 1) {
      await writeAndFinalize(dir, chapter)
    }
    const statusBefore = parseJson<{ chapters: unknown[]; mainlineRevision: number }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(statusBefore.chapters.length, 8)
    assert.equal(statusBefore.mainlineRevision, 8)

    assert.equal((await runCli(dir, ['amend', '3', '--json'])).code, 0)
    for (const round of [1, 2]) {
      assert.equal((await runCli(dir, ['check', '3', '--json'])).code, 0)
      const extracted3 = await runCli(dir, ['extract', '3', '--json'])
      assert.equal(extracted3.code, 0, extracted3.stdout + extracted3.stderr)
      assert.equal((await runCli(dir, ['audit', '3', '--json'])).code, 0)
      const review = await runCli(dir, ['review', '3', '--json'])
      assert.equal(review.code, 7, `round ${round}`)
      const revised = await runCli(dir, ['revise', '3', '--findings', 'f1', '--json'])
      assert.equal(revised.code, 0, revised.stderr)
      const revisionId = parseJson<{ revisionId: string }>(revised.stdout).revisionId
      assert.equal((await runCli(dir, ['merge', '3', '--revision', revisionId, '--json'])).code, 0)
      assert.equal((await runCli(dir, ['check', '3', '--json'])).code, 0)
      assert.equal((await runCli(dir, ['extract', '3', '--json'])).code, 0)
      assert.equal((await runCli(dir, ['audit', '3', '--json'])).code, 0)
      const rechecked = await runCli(dir, ['recheck', '3', '--json'])
      assert.equal(rechecked.code, 0, `round ${round}: ${rechecked.stdout}${rechecked.stderr}`)
    }
    const finalized = await runCli(dir, ['finalize', '3', '--json'])
    assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
    const statusAfter = parseJson<{ chapters: unknown[]; mainlineRevision: number }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(statusAfter.chapters.length, 8)
    assert.equal(statusAfter.mainlineRevision, 9)
    const commitFiles = (await readdir(path.join(dir, 'ledger', 'commits'))).filter(name => name.endsWith('.json'))
    assert.equal(commitFiles.length, 9)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.6 excludes waived findings from the revision plan', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload(true)])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    assert.equal((await runCli(dir, [
      'waive', '1', '--finding', 'f1', '--reason', '作者确认保留', '--scope', 'project', '--json',
    ])).code, 0)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    assert.equal(revised.code, 3)
    assert.equal(model.requests.length, 4)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.7 timeline rejects age conflicts', async () => {
  const extraction = JSON.parse(extractionPayload()) as Record<string, unknown>
  const timeline = extraction.timeline as Array<Record<string, unknown>>
  timeline[0]!.storyDate = '2026-01-01'
  timeline[0]!.ages = { 林岚: 99 }
  const model = new FakeModel([P05_DRAFT, JSON.stringify(extraction)])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      birthDate: '2000-01-01',
    }])
    await setContract(dir, 1)
    assert.equal((await checkContract(dir, 1)).code, 0)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    const timelineReport = await runCli(dir, ['timeline', '1', '--json'])
    assert.equal(timelineReport.code, 3)
    assert.ok(
      parseJson<{ errors: string[] }>(timelineReport.stdout).errors.some(error => error.includes('按生日推算')),
      timelineReport.stdout,
    )
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.7 accepts a no-event chapter with an explicit reason', async () => {
  const extraction = JSON.stringify({
    summary: '过渡章',
    noEventsReason: '本章只做场景过渡',
    records: [],
    timeline: [],
    facts: [],
    beliefs: [],
    loops: [],
  })
  const model = new FakeModel([P05_DRAFT, extraction])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    assert.equal(parseJson<{ noEventsReason: string }>(extracted.stdout).noEventsReason, '本章只做场景过渡')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.7 impact with no dependency stays deferred', async () => {
  const model = new FakeModel(['第一章：林岚在码头查账。', '第二章：周独自离开钟楼。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [
      { name: '林岚', status: 'alive', introducedIn: 1 },
      { name: '周', status: 'alive', introducedIn: 2 },
    ])
    await setContract(dir, 1, { characters: ['林岚'] })
    assert.equal((await checkContract(dir, 1)).code, 0)
    await writeAndFinalize(dir, 1)
    await setContract(dir, 2, {
      characters: ['周'],
      pov: '周',
      location: '钟楼',
      threads: ['周线'],
    })
    assert.equal((await checkContract(dir, 2)).code, 0)
    assert.equal((await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['finalize', '2', '--json'])).code, 0)
    const impact = await runCli(dir, ['impact', '1', '--json'])
    assert.equal(impact.code, 0, impact.stderr)
    const payload = parseJson<{
      report: { items: Array<{ targetChapter: number; level: string; status: string }> }
    }>(impact.stdout)
    assert.equal(payload.report.items[0]?.targetChapter, 2)
    assert.equal(payload.report.items[0]?.level, 'unknown')
    assert.equal(payload.report.items[0]?.status, 'deferred')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.7 waiver expires by chapter and is audited', async () => {
  const secondDraft = '第二章：林岚继续查账。'
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    reviewPayload(true),
    reviewPayload(true),
    secondDraft,
    chapter3Extraction(secondDraft),
    coveragePayload(),
    reviewFor(secondDraft),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    assert.equal((await runCli(dir, [
      'waive', '1', '--finding', 'f1', '--reason', '只在本章生效', '--scope', 'chapter', '--until', '1', '--json',
    ])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2)
    assert.equal((await checkContract(dir, 2)).code, 0)
    assert.equal((await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '2', '--json'])).code, 0)
    const review2 = await runCli(dir, ['review', '2', '--json'])
    assert.equal(review2.code, 7)
    const listed = await runCli(dir, ['waivers', 'list', '--json'])
    const waivers = parseJson<{ waivers: Array<{ status: string; expiresAtChapter: number }> }>(listed.stdout).waivers
    assert.equal(waivers[0]?.status, 'expired')
    assert.equal(waivers[0]?.expiresAtChapter, 1)
    const audit = await readFile(path.join(dir, '.weave', 'waivers.log.jsonl'), 'utf8')
    assert.match(audit, /"event":"expire"/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1.7 limited POV does not inject previous raw prose secrets', async () => {
  const first = '林岚在码头翻开账本。\n\n周把账本藏进了钟楼。'
  const model = new FakeModel([
    first,
    chapter3Extraction('林岚在码头翻开账本。'),
    coveragePayload(),
    warningReviewFor('林岚在码头翻开账本。'),
    '第二章：林岚回到码头，继续查账。\n',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    const written = await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
    const body = JSON.stringify(model.requests[4])
    assert.equal(body.includes('钟楼'), false)
    assert.equal(body.includes('周把账本'), false)
    assert.ok(body.includes('上一章视角安全摘要'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.1 routes methods, checks style and rewrites only the target paragraph', async () => {
  const model = new FakeModel([
    '林岚在码头翻开账本，发现缺页，决定沿着港务局的印继续追查，同时留意潮水变化和来往船只的动向，她必须在天黑前确认每一页的去向，否则港务局的人会先一步销毁证据。\n\n她把账本重新包好。',
    JSON.stringify({ text: '林岚在码头翻开账本。她把缺页按回去，记住了港务局的印。' }),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await setContract(dir, 1, { goal: '找出账本缺页的因果链', obstacle: '人物动机不明' })
    assert.equal((await checkContract(dir, 1)).code, 0)
    const listed = await runCli(dir, ['method', 'list', '--json'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.ok(parseJson<{ modules: Array<{ id: string }> }>(listed.stdout).modules.some(item => item.id === 'structure-causality'))

    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    const routed = await runCli(dir, ['method', 'route', '1', '--json'])
    assert.equal(routed.code, 0, routed.stderr)
    const selection = parseJson<{ modules: Array<{ id: string }>; estimatedTokens: number }>(routed.stdout)
    assert.ok(selection.modules.length <= 3)
    assert.ok(selection.modules.length > 0)
    assert.ok(selection.estimatedTokens > 0)

    const style = await runCli(dir, ['style', 'check', '1', '--json'])
    assert.equal(style.code, 0, style.stderr)
    assert.ok(
      parseJson<{ findings: Array<{ code: string }> }>(style.stdout).findings.some(item => item.code === 'LONG_SENTENCE'),
      style.stdout,
    )

    const before = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    const rewrite = await runCli(dir, [
      'rewrite', '1', '--paragraph', 'p001', '--goal', '压缩长句，保留线索', '--json',
    ])
    assert.equal(rewrite.code, 0, rewrite.stderr)
    const candidate = parseJson<{ revisionId: string; candidate: { paragraphs: Array<{ paragraphId: string }> } }>(rewrite.stdout)
    assert.equal(candidate.candidate.paragraphs[0]?.paragraphId, 'p001')
    assert.equal(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), before)
    const merged = await runCli(dir, ['merge', '1', '--revision', candidate.revisionId, '--json'])
    assert.equal(merged.code, 0, merged.stderr)
    const text = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.match(text, /记住了港务局的印/)
    assert.match(text, /她把账本重新包好/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.2 indexes Chinese chunks, searches short terms, deconstructs and exports platform counts', async () => {
  const model = new FakeModel([
    '林岚在码头翻开账本。\n\n缺页上留着港务局的印。',
    '林岚回到海港，把账本锁进柜子。\n\n她决定第二天再去码头。',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await setContract(dir, 2)
    assert.equal((await checkContract(dir, 2)).code, 0)
    await writeAndFinalize(dir, 1)
    await writeAndFinalize(dir, 2)

    const indexed = await runCli(dir, ['index', 'rebuild', '--json'])
    assert.equal(indexed.code, 0, indexed.stderr)
    assert.ok(parseJson<{ chunks: number }>(indexed.stdout).chunks >= 4)

    const search = await runCli(dir, ['search', '账本', '--json'])
    assert.equal(search.code, 0, search.stderr)
    const results = parseJson<{ results: Array<{ chapter: number; paragraph: number; evidence: { quote: string } }> }>(search.stdout)
    assert.ok(results.results.length > 0)
    assert.ok(results.results.some(item => item.chapter === 1))
    assert.ok(results.results[0]?.evidence.quote.includes('账本'))

    const short = await runCli(dir, ['search', '账', '--json'])
    assert.equal(short.code, 0, short.stderr)
    assert.equal(parseJson<{ fallback: boolean }>(short.stdout).fallback, true)
    assert.ok(parseJson<{ results: unknown[] }>(short.stdout).results.length > 0)

    const filtered = await runCli(dir, ['search', '海港', '--chapter', '2', '--json'])
    assert.equal(filtered.code, 0, filtered.stderr)
    assert.ok(parseJson<{ results: Array<{ chapter: number }> }>(filtered.stdout).results.every(item => item.chapter === 2))

    const sample = path.join(dir, 'sample.txt')
    await writeFile(sample, '第一章 起点\n林岚来到码头。\n\n第二章 账本\n她翻开账本。\n')
    const deconstructed = await runCli(dir, ['deconstruct', 'sample.txt', '--json'])
    assert.equal(deconstructed.code, 0, deconstructed.stderr)
    const report = parseJson<{ totals: { chapters: number }; chapters: Array<{ openingExcerpt: string }> }>(deconstructed.stdout)
    assert.equal(report.totals.chapters, 2)
    assert.ok(report.chapters.every(item => [...item.openingExcerpt].length <= 80))

    const exported = await runCli(dir, ['export', '--format', 'merged', '--platform', 'qidian', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const exportPayload = parseJson<{ platform: string; characters: number }>(exported.stdout)
    assert.equal(exportPayload.platform, 'qidian')
    assert.ok(exportPayload.characters > 0)
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
