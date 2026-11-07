import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

test('extraction rejects fabricated quotes instead of passing silently', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload('这句话不在正文里，是模型编造的。'), coveragePayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    const extracted = await runCli(dir, ['extract', '1', '--json'])
    assert.equal(extracted.code, 3, extracted.stdout + extracted.stderr)
    const extraction = parseJson<{
      passed: boolean
      records: unknown[]
      rejected: Array<{ reason: string }>
    }>(extracted.stdout)
    assert.equal(extraction.passed, false)
    assert.equal(extraction.records.length, 0)
    assert.ok(extraction.rejected.some(entry => entry.reason.includes('证据引文不在草稿中')))
    assert.ok(extraction.rejected.some(entry => entry.reason.includes('整条记录被拒绝')))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('canon reveal withholding keeps unrevealed materials out of the prompt', async () => {
  const model = new FakeModel(['第一章正文：林岚在码头核对账本，记下缺页数目。', '第二章正文：林岚顺着缺页查到旧仓。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      knows: [{ fact: '账本缺页', fromChapter: 1 }],
    }, {
      name: '陈九',
      status: 'alive',
      introducedIn: 1,
      voice: '说话带盐城口音',
    }])
    await setContract(dir, 1, { characters: ['林岚', '陈九'] })
    await writeFile(path.join(dir, 'canon', 'world.md'), '世界设定：雾港深处藏着第七盏灯的坐标。\n')
    await writeFile(
      path.join(dir, 'canon', 'reveals.json'),
      `${JSON.stringify({ 'canon:world.md': 2, 'canon:characters:陈九': 3 }, null, 2)}\n`,
    )
    const checked = await checkContract(dir, 1)
    assert.equal(checked.code, 0, checked.stderr)

    const first = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(first.code, 0, first.stderr)
    const firstPayload = parseJson<{ withheld: Array<{ sourceId: string; reason: string }> }>(first.stdout)
    assert.deepEqual(firstPayload.withheld, [
      { sourceId: 'canon:world.md', reason: 'not-yet-revealed' },
      { sourceId: 'canon:characters:陈九', reason: 'not-yet-revealed' },
    ])
    const firstBody = JSON.stringify(model.requests[0])
    assert.ok(!firstBody.includes('第七盏灯'), 'unrevealed world.md must stay out of the prompt')
    assert.ok(!firstBody.includes('盐城口音'), 'unrevealed character profile must stay out of the prompt')

    const status = parseJson<{ disclosure?: { chapter: number; withheld: Array<{ sourceId: string; revealChapter: number }> } }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status.disclosure?.chapter, 1)
    assert.deepEqual(
      status.disclosure?.withheld.map(item => item.sourceId),
      ['canon:world.md', 'canon:characters:陈九'],
    )

    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)
    await setContract(dir, 2, { characters: ['林岚', '陈九'] })
    const checked2 = await checkContract(dir, 2)
    assert.equal(checked2.code, 0, checked2.stderr)
    const second = await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(second.code, 0, second.stderr)
    const secondPayload = parseJson<{ withheld: Array<{ sourceId: string }> }>(second.stdout)
    assert.deepEqual(secondPayload.withheld.map(item => item.sourceId), ['canon:characters:陈九'])
    const secondBody = JSON.stringify(model.requests[model.requests.length - 1])
    assert.ok(secondBody.includes('第七盏灯'), 'world.md must enter the prompt once revealed')
    assert.ok(!secondBody.includes('盐城口音'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

const Q1_DRAFT = '林岚清点袋中银元，数出一百五十枚。'
const Q2_DRAFT = '林岚交给船老大二十枚银元，袋里还剩一百三十枚。'
const Q3_DRAFT = '林岚又付给码头苦力十五枚银元，她说袋里还剩一百二十枚。'

function quantityExtraction(chapter: number, summary: string, quote: string, delta: number, balance: number | null): string {
  return JSON.stringify({
    summary: `${summary}。`,
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary,
      participants: ['林岚'],
      location: '海港',
      storyTime: `第 ${chapter} 天`,
      payload: {},
      evidence: [{ quote, occurrence: 1 }],
    }],
    timeline: [{
      eventId: 'e1',
      recordId: 'r1',
      summary,
      dayOffset: 0,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote, occurrence: 1 }],
    }],
    facts: [{
      factId: `fact-yinyuan-${chapter}`,
      subject: '林岚',
      predicate: 'possession',
      object: '银元袋',
      quantity: { delta, balance, unit: '银元' },
      validFromChapter: chapter,
      validToChapter: null,
      sourceRecordId: 'r1',
      origin: 'derived',
      supersedes: null,
      confidence: 0.9,
      evidence: [{ quote, occurrence: 1 }],
    }],
    beliefs: [],
    loops: [],
  })
}

test('quantity ledger breaks surface in audit without blocking finalize', async () => {
  const model = new FakeModel([
    Q1_DRAFT, quantityExtraction(1, '林岚清点银元', '数出一百五十枚', 0, 150), coveragePayload(), warningReviewFor('数出一百五十枚'),
    Q2_DRAFT, quantityExtraction(2, '林岚交出银元', '交给船老大二十枚银元', -20, 130), coveragePayload(), warningReviewFor('交给船老大二十枚银元'),
    Q3_DRAFT, quantityExtraction(3, '林岚再付银元', '付给码头苦力十五枚银元', -15, 120), coveragePayload(), warningReviewFor('付给码头苦力十五枚银元'),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  await setCharacters(dir, [{
    name: '林岚',
    status: 'alive',
    introducedIn: 1,
    knows: [{ fact: '账本缺页', fromChapter: 1 }],
  }])
  const mustHappen = ['林岚清点银元', '林岚交出银元', '林岚再付银元']
  const audits: Array<{ quantityBreaks: Array<{ subject: string; unit: string; chapter: number; previousBalance: number | null; delta: number; statedBalance: number; expectedBalance: number }>; passed: boolean }> = []
  try {
    for (const chapter of [1, 2, 3]) {
      await setContract(dir, chapter, { mustHappen: [mustHappen[chapter - 1]!] })
      const checked = await checkContract(dir, chapter)
      assert.equal(checked.code, 0, checked.stderr)
      const written = await runCli(dir, ['write', String(chapter), '--json'], { WEAVE_API_KEY: SECRET })
      assert.equal(written.code, 0, written.stderr)
      const rechecked = await runCli(dir, ['check', String(chapter), '--json'])
      assert.equal(rechecked.code, 0, rechecked.stdout + rechecked.stderr)
      const extracted = await runCli(dir, ['extract', String(chapter), '--json'])
      assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
      const timeline = await runCli(dir, ['timeline', String(chapter), '--json'])
      assert.equal(timeline.code, 0, timeline.stdout + timeline.stderr)
      const audited = await runCli(dir, ['audit', String(chapter), '--json'])
      assert.equal(audited.code, 0, audited.stdout + audited.stderr)
      audits.push(parseJson<typeof audits[number]>(audited.stdout))
      const reviewed = await runCli(dir, ['review', String(chapter), '--json'])
      assert.equal(reviewed.code, 0, reviewed.stdout + reviewed.stderr)
      const finalized = await runCli(dir, ['finalize', String(chapter), '--json'])
      assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
    }

    assert.deepEqual(audits[0]!.quantityBreaks, [])
    assert.deepEqual(audits[1]!.quantityBreaks, [])
    assert.equal(audits[2]!.quantityBreaks.length, 1)
    const brk = audits[2]!.quantityBreaks[0]!
    assert.equal(brk.subject, '林岚')
    assert.equal(brk.unit, '银元')
    assert.equal(brk.chapter, 3)
    assert.equal(brk.previousBalance, 130)
    assert.equal(brk.delta, -15)
    assert.equal(brk.statedBalance, 120)
    assert.equal(brk.expectedBalance, 115)
    assert.equal(audits[2]!.passed, true, 'quantity breaks must not block the audit')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

const P1_DRAFT = '林岚值完夜班回到宿舍，人还好好地活着。'
const P2_DRAFT = '夜里火场坍塌，林岚被救出来时已经没有呼吸。'

function statusExtraction(chapter: number, alive: boolean, quote: string): string {
  return JSON.stringify({
    summary: chapter === 1 ? '林岚平安值完夜班。' : '林岚火场被困。',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: chapter === 1 ? '林岚平安值完夜班' : '林岚火场被困',
      participants: ['林岚'],
      location: '宿舍',
      storyTime: `第 ${chapter} 天`,
      payload: {},
      evidence: [{ quote, occurrence: 1 }],
    }],
    timeline: [{
      eventId: 'e1',
      recordId: 'r1',
      summary: chapter === 1 ? '林岚平安值完夜班' : '林岚火场被困',
      dayOffset: 0,
      durationDays: 0,
      participants: ['林岚'],
      causedBy: [],
      type: 'main',
      evidence: [{ quote, occurrence: 1 }],
    }],
    facts: [{
      factId: `fact-status-${chapter}`,
      subject: '林岚',
      predicate: 'status',
      object: alive ? 'alive' : 'dead',
      validFromChapter: chapter,
      validToChapter: null,
      sourceRecordId: 'r1',
      origin: 'derived',
      supersedes: null,
      confidence: 0.9,
      evidence: [{ quote, occurrence: 1 }],
    }],
    beliefs: [],
    loops: [],
  })
}

test('ledger conflicts park as pending for adjudication instead of vanishing', async () => {
  const model = new FakeModel([
    P1_DRAFT, statusExtraction(1, true, '人还好好地活着'), coveragePayload(), warningReviewFor('人还好好地活着'),
    P2_DRAFT, statusExtraction(2, false, '已经没有呼吸'), coveragePayload(), coveragePayload(), warningReviewFor('已经没有呼吸'),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      knows: [{ fact: '账本缺页', fromChapter: 1 }],
    }])
    await setContract(dir, 1, { mustHappen: ['林岚平安值完夜班'] })
    assert.equal((await checkContract(dir, 1)).code, 0)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['timeline', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2, { mustHappen: ['林岚火场被困'] })
    assert.equal((await checkContract(dir, 2)).code, 0)
    assert.equal((await runCli(dir, ['write', '2', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '2', '--json'])).code, 0)
    const extracted = await runCli(dir, ['extract', '2', '--json'])
    assert.equal(extracted.code, 0, extracted.stdout + extracted.stderr)
    const payload = parseJson<{
      passed: boolean
      rejected: unknown[]
      pending: Array<{ pendingId: string; subject: string; object: string; priorObject: string; conflictWith: string }>
      facts: Array<{ predicate: string; object: string }>
    }>(extracted.stdout)
    assert.equal(payload.passed, true, 'pending must not fail extraction')
    assert.deepEqual(payload.rejected, [])
    assert.equal(payload.pending.length, 1)
    const pending = payload.pending[0]!
    assert.equal(pending.subject, '林岚')
    assert.equal(pending.object, 'dead')
    assert.equal(pending.priorObject, 'alive')
    assert.equal(pending.conflictWith, 'fact-status-1')
    assert.ok(!payload.facts.some(fact => fact.predicate === 'status'), 'conflicting fact must stay out of the ledger')

    const status = parseJson<{ pendingConflicts?: Array<{ chapter: number; pendingId: string; subject: string }> }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.ok(status.pendingConflicts?.some(item => item.chapter === 2 && item.subject === '林岚'))

    const conflictedPreview = parseJson<{ conflictWarnings: string[] }>(
      (await runCli(dir, ['context', '2', '--json'])).stdout,
    )
    assert.equal(conflictedPreview.conflictWarnings.length, 1, 'assembly report must warn on unresolved conflicts')
    assert.match(conflictedPreview.conflictWarnings[0]!, /林岚.*status/)

    const audited = await runCli(dir, ['audit', '2', '--json'])
    assert.equal(audited.code, 0, audited.stdout + audited.stderr)
    const auditPayload = parseJson<{ warnings: string[]; passed: boolean }>(audited.stdout)
    assert.ok(auditPayload.warnings[0]?.includes('待裁决冲突'), 'audit must surface pending at the top')
    assert.equal(auditPayload.passed, true, 'pending must not block the audit')

    const listed = parseJson<{ unresolved: Array<{ pendingId: string }>; resolved: unknown[] }>(
      (await runCli(dir, ['pending', '2', '--json'])).stdout,
    )
    assert.equal(listed.unresolved.length, 1)
    assert.equal(listed.unresolved[0]!.pendingId, pending.pendingId)

    const decided = await runCli(dir, [
      'pending', 'decide', '2', pending.pendingId, '--as', 'text', '--reason', '正文为准：火场殉职', '--json',
    ])
    assert.equal(decided.code, 0, decided.stdout + decided.stderr)
    const clearedPreview = parseJson<{ conflictWarnings: string[] }>(
      (await runCli(dir, ['context', '2', '--json'])).stdout,
    )
    assert.deepEqual(clearedPreview.conflictWarnings, [], 'warnings must clear after adjudication')
    const relisted = parseJson<{ unresolved: unknown[]; resolved: Array<{ pendingId: string }> }>(
      (await runCli(dir, ['pending', '2', '--json'])).stdout,
    )
    assert.equal(relisted.unresolved.length, 0)
    assert.equal(relisted.resolved[0]!.pendingId, pending.pendingId)

    const reaudited = await runCli(dir, ['audit', '2', '--json'])
    assert.equal(reaudited.code, 0, reaudited.stdout + reaudited.stderr)
    const reauditPayload = parseJson<{ warnings: string[]; quantityBreaks: unknown[] }>(reaudited.stdout)
    assert.ok(!reauditPayload.warnings.some(line => line.includes('待裁决冲突')))

    assert.equal((await runCli(dir, ['review', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '2', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['rebuild', '--projection', 'ledger', '--json'])).code, 0, 'decided fact replays cleanly')

    const afterStatus = parseJson<{ pendingConflicts?: unknown[] }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(afterStatus.pendingConflicts, undefined, 'warning clears after adjudication')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('style derivation proposes ranges that only take effect after adopt', async () => {
  const model = new FakeModel([
    '林岚在码头数了三遍账目——每一遍都少十两。'
    + '她把最后一页翻过去，又翻回来，指腹在纸面上压出褶皱。'
    + '她说：“今天必须对上，差一两都过不去。”'
    + '夜风从泊位那边灌进来，吹得账页哗哗作响，她按住纸角继续核对，直到灯芯烧到尽头。',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)

    const first = parseJson<{ candidate: { suggested: { sentenceLength: unknown; dialogueRatio: unknown; dashRatio: { max: number } }; derivedFrom: string[] } }>(
      (await runCli(dir, ['style', 'derive', '--json'])).stdout,
    )
    assert.deepEqual(first.candidate.derivedFrom, ['chapter:1'])
    assert.ok(first.candidate.suggested.dashRatio.max > 0, 'draft with a dash must yield a positive dash ceiling')

    const second = parseJson<{ candidate: { suggested: unknown } }>(
      (await runCli(dir, ['style', 'derive', '--json'])).stdout,
    )
    assert.deepEqual(second.candidate.suggested, first.candidate.suggested, 'repeated derivation is stable')

    const canonStyle = path.join(dir, 'canon', 'style.json')
    const beforeAdopt = await readFile(canonStyle, 'utf8').catch(() => null)
    assert.ok(!beforeAdopt || !JSON.parse(beforeAdopt).dashRatio, 'derive must not touch canon')

    const adopted = await runCli(dir, ['style', 'adopt', '--json'])
    assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr)
    const canon = JSON.parse(await readFile(canonStyle, 'utf8')) as {
      sentenceLength: unknown
      dialogueRatio: unknown
      dashRatio: unknown
    }
    assert.deepEqual(canon.sentenceLength, first.candidate.suggested.sentenceLength)
    assert.deepEqual(canon.dialogueRatio, first.candidate.suggested.dialogueRatio)
    assert.deepEqual(canon.dashRatio, first.candidate.suggested.dashRatio)

    await writeFile(path.join(dir, 'chapters', 'drafts', '002.md'), '他走了——很远——不再回头——就这样。\n')
    const checked = await runCli(dir, ['style', 'check', '2', '--json'])
    assert.equal(checked.code, 0, checked.stdout + checked.stderr)
    const report = parseJson<{ findings: Array<{ code: string }> }>(checked.stdout)
    assert.ok(report.findings.some(finding => finding.code === 'EXCESS_DASH'), 'adopted dash ceiling must drive the lint')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('context preview matches the hash actually sent', async () => {
  const model = new FakeModel(['第一章正文：林岚在码头核对账本，记下缺页数目。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    const written = parseJson<{ contextHash: string; included: string[]; withheld: unknown[] }>(
      (await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).stdout,
    )
    const preview = parseJson<{ contextHash: string; included: string[]; estimatedTokens: number }>(
      (await runCli(dir, ['context', '1', '--json'])).stdout,
    )
    assert.equal(preview.contextHash, written.contextHash, 'preview must hash exactly what write sends')
    assert.deepEqual(preview.included, written.included)
    assert.ok(preview.estimatedTokens > 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('ledger survives chapter deletion loudly rejects renumbering', async () => {
  const model = new FakeModel([
    Q1_DRAFT, quantityExtraction(1, '林岚清点银元', '数出一百五十枚', 0, 150), coveragePayload(), warningReviewFor('数出一百五十枚'),
    Q2_DRAFT, quantityExtraction(2, '林岚交出银元', '交给船老大二十枚银元', -20, 130), coveragePayload(), warningReviewFor('交给船老大二十枚银元'),
    Q3_DRAFT, quantityExtraction(3, '林岚再付银元', '付给码头苦力十五枚银元', -15, 120), coveragePayload(), warningReviewFor('付给码头苦力十五枚银元'),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  const mustHappen = ['林岚清点银元', '林岚交出银元', '林岚再付银元']
  try {
    await setCharacters(dir, [{
      name: '林岚',
      status: 'alive',
      introducedIn: 1,
      knows: [{ fact: '账本缺页', fromChapter: 1 }],
    }])
    for (const chapter of [1, 2, 3]) {
      await setContract(dir, chapter, { mustHappen: [mustHappen[chapter - 1]!] })
      assert.equal((await checkContract(dir, chapter)).code, 0)
      assert.equal((await runCli(dir, ['write', String(chapter), '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
      assert.equal((await runCli(dir, ['check', String(chapter), '--json'])).code, 0)
      assert.equal((await runCli(dir, ['extract', String(chapter), '--json'])).code, 0)
      assert.equal((await runCli(dir, ['timeline', String(chapter), '--json'])).code, 0)
      assert.equal((await runCli(dir, ['audit', String(chapter), '--json'])).code, 0)
      assert.equal((await runCli(dir, ['review', String(chapter), '--json'])).code, 0)
      assert.equal((await runCli(dir, ['finalize', String(chapter), '--json'])).code, 0)
    }

    const mainlinePath = path.join(dir, 'ledger', 'mainline.jsonl')
    const head = async () => {
      const lines = (await readFile(mainlinePath, 'utf8')).trim().split('\n')
      return JSON.parse(lines[lines.length - 1]!) as {
        mainlineRevision: number
        selectedCommitByChapter: Record<string, string>
      }
    }
    const appendHead = async (chapters: Record<string, string>): Promise<void> => {
      const current = await head()
      await appendFile(mainlinePath, `${JSON.stringify({
        mainlineRevision: current.mainlineRevision + 1,
        selectedCommitByChapter: chapters,
        previousHead: null,
        updatedAt: new Date().toISOString(),
      })}\n`, 'utf8')
    }
    const original = (await head()).selectedCommitByChapter

    // 删一章：第 2 章退出主线后，重放必须干净收敛，留下的章节引用不悬空。
    const afterDelete = { ...original }
    delete afterDelete['2']
    await appendHead(afterDelete)
    const rebuilt = await runCli(dir, ['rebuild', '--projection', 'ledger', '--json'])
    assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr)
    assert.equal((await runCli(dir, ['ledger', 'fact', 'fact-yinyuan-1', '--json'])).code, 0)
    assert.notEqual((await runCli(dir, ['ledger', 'fact', 'fact-yinyuan-2', '--json'])).code, 0, 'deleted chapter facts must leave the mainline view')
    assert.equal((await runCli(dir, ['ledger', 'fact', 'fact-yinyuan-3', '--json'])).code, 0)

    // 移章（重编号）：把第 2 章的提交挪到第 4 章名下，必须显式失败而不是静默错位。
    await appendHead({ '1': original['1']!, '3': original['3']!, '4': original['2']! })
    const mislabeled = await runCli(dir, ['rebuild', '--projection', 'ledger', '--json'])
    assert.notEqual(mislabeled.code, 0, 'renumbered commit must fail loudly')
    assert.match(mislabeled.stdout + mislabeled.stderr, /第 4 章/, 'failure must name the mismatched chapter')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

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
    assert.ok(JSON.stringify(model.requests[0]).includes('structure-causality'))
    const runFile = (await readdir(path.join(dir, '.weave', 'runs'))).find(name => name.endsWith('.json'))!
    const runRecord = JSON.parse(await readFile(path.join(dir, '.weave', 'runs', runFile), 'utf8')) as {
      methodSelection: { modules: Array<{ id: string }>; reasons: string[]; estimatedTokens: number }
    }
    assert.ok(runRecord.methodSelection.modules.some(item => item.id === 'structure-causality'))
    assert.ok(runRecord.methodSelection.reasons.length > 0)
    assert.ok(runRecord.methodSelection.estimatedTokens > 0)
    const history = await runCli(dir, ['method', 'history', '1', '--json'])
    assert.equal(history.code, 0, history.stderr)
    assert.ok(parseJson<{ records: unknown[] }>(history.stdout).records.length > 0)
    const routed = await runCli(dir, ['method', 'route', '1', '--json'])
    assert.equal(routed.code, 0, routed.stderr)
    const selection = parseJson<{ modules: Array<{ id: string }>; estimatedTokens: number }>(routed.stdout)
    assert.ok(selection.modules.length <= 3)
    assert.ok(selection.modules.length > 0)
    assert.ok(selection.estimatedTokens > 0)
    const tight = await runCli(dir, ['method', 'route', '1', '--max-tokens', '1', '--json'])
    assert.equal(tight.code, 0, tight.stderr)
    assert.equal(parseJson<{ modules: unknown[] }>(tight.stdout).modules.length, 0)
    const shortForm = await runCli(dir, ['method', 'route', '1', '--platform', 'short-form', '--json'])
    assert.equal(shortForm.code, 0, shortForm.stderr)
    assert.equal(parseJson<{ modules: unknown[] }>(shortForm.stdout).modules.length, 0)
    const qidian = await runCli(dir, ['method', 'route', '1', '--platform', 'qidian', '--json'])
    assert.equal(qidian.code, 0, qidian.stderr)
    assert.ok(parseJson<{ modules: unknown[] }>(qidian.stdout).modules.length > 0)
    await mkdir(path.join(dir, 'methods'), { recursive: true })
    await writeFile(path.join(dir, 'methods', 'fixture.md'), [
      'version: 2',
      'tags: 因果',
      '',
      '## Signal',
      '因果链断裂。',
      '## Diagnosis',
      '找出断裂点。',
      '## Process',
      '重写因果链。',
      '## Output Contract',
      '场景状态改变。',
      '## Positive Example',
      '她交出账本，因此失去证据。',
      '## Negative Example',
      '她去了码头。',
      '## Self Check',
      '能否回答为什么。',
      '## Scope',
      'long-form',
      '## Not For',
      'short-form',
    ].join('\n'))
    const custom = await runCli(dir, ['method', 'show', 'fixture', '--json'])
    assert.equal(custom.code, 0, custom.stderr)
    const customPayload = parseJson<{ version: number; scope: string; notFor: string }>(custom.stdout)
    assert.equal(customPayload.version, 2)
    assert.equal(customPayload.scope, 'long-form')
    assert.equal(customPayload.notFor, 'short-form')
    await writeFile(path.join(dir, 'methods', 'disabled.json'), '["structure-causality"]\n')
    const afterDisable = await runCli(dir, ['method', 'list', '--json'])
    assert.equal(afterDisable.code, 0, afterDisable.stderr)
    assert.equal(
      parseJson<{ modules: Array<{ id: string }> }>(afterDisable.stdout).modules.some(item => item.id === 'structure-causality'),
      false,
    )

    await mkdir(path.join(dir, 'canon', 'samples'), { recursive: true })
    await writeFile(
      path.join(dir, 'canon', 'samples', 'voice.md'),
      '---\ntags: 对话,克制\n---\n林岚把账本按在桌上。\n',
    )
    await writeFile(path.join(dir, 'canon', 'style.json'), `${JSON.stringify({
      sentenceLength: { min: 5, max: 10 },
      dialogueRatio: { min: 0, max: 1 },
      forbiddenPatterns: ['五味杂陈'],
    }, null, 2)}\n`)
    const samples = await runCli(dir, ['style', 'samples', '--json'])
    assert.equal(samples.code, 0, samples.stderr)
    const samplePayload = parseJson<{ samples: Array<{ tags: string[] }> }>(samples.stdout)
    assert.equal(samplePayload.samples.length, 1)
    assert.deepEqual(samplePayload.samples[0]?.tags, ['对话', '克制'])

    const style = await runCli(dir, ['style', 'check', '1', '--json'])
    assert.equal(style.code, 0, style.stderr)
    assert.ok(
      parseJson<{ findings: Array<{ code: string }> }>(style.stdout).findings.some(item => item.code === 'LONG_SENTENCE'),
      style.stdout,
    )
    assert.equal(parseJson<{ style: { sentenceLength: { max: number } } }>(style.stdout).style.sentenceLength.max, 10)

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
    const firstIndex = parseJson<{ chunks: number; terms: number }>(indexed.stdout)
    assert.ok(firstIndex.chunks >= 4)
    const rebuiltAgain = await runCli(dir, ['index', 'rebuild', '--json'])
    assert.equal(rebuiltAgain.code, 0, rebuiltAgain.stderr)
    assert.deepEqual(parseJson<{ chunks: number; terms: number }>(rebuiltAgain.stdout), firstIndex)
    const indexStatus = await runCli(dir, ['index', 'status', '--json'])
    assert.equal(indexStatus.code, 0, indexStatus.stderr)
    const indexStatusPayload = parseJson<{ current: boolean; chunks: number }>(indexStatus.stdout)
    assert.equal(indexStatusPayload.current, true)
    assert.equal(indexStatusPayload.chunks, firstIndex.chunks)

    const search = await runCli(dir, ['search', '账本', '--json'])
    assert.equal(search.code, 0, search.stderr)
    const results = parseJson<{
      fallback: boolean
      results: Array<{ chapter: number; paragraph: number; evidence: { quote: string } }>
    }>(search.stdout)
    assert.equal(results.fallback, false)
    assert.ok(results.results.length > 0)
    assert.ok(results.results.some(item => item.chapter === 1))
    assert.ok(results.results[0]?.evidence.quote.includes('账本'))
    const chunkId = (results.results[0] as { chunkId?: string }).chunkId
    assert.ok(chunkId)
    const chunk = await runCli(dir, ['chunk', chunkId!, '--json'])
    assert.equal(chunk.code, 0, chunk.stderr)
    assert.match(parseJson<{ parentText: string }>(chunk.stdout).parentText, /账本/)

    const vectorFile = path.join(dir, 'vectors.json')
    await writeFile(vectorFile, `${JSON.stringify({
      query: [1, 0],
      chunks: {
        'ch-1-001': [0, 1],
        'ch-2-001': [1, 0],
      },
    })}\n`)
    const reranked = await runCli(dir, ['search', '账本', '--rerank', '--json'])
    assert.equal(reranked.code, 0, reranked.stderr)
    assert.ok(parseJson<{ results: unknown[] }>(reranked.stdout).results.length > 0)

    const hybrid = await runCli(dir, ['search', '账本', '--vectors', 'vectors.json', '--json'])
    assert.equal(hybrid.code, 0, hybrid.stderr)
    const hybridPayload = parseJson<{ fusion: string; results: Array<{ chunkId: string }> }>(hybrid.stdout)
    assert.equal(hybridPayload.fusion, 'rrf')
    assert.ok(hybridPayload.results.some(item => item.chunkId === 'ch-2-001'))

    const short = await runCli(dir, ['search', '账', '--json'])
    assert.equal(short.code, 0, short.stderr)
    assert.equal(parseJson<{ fallback: boolean }>(short.stdout).fallback, true)
    assert.ok(parseJson<{ results: unknown[] }>(short.stdout).results.length > 0)

    const filtered = await runCli(dir, ['search', '海港', '--chapter', '2', '--json'])
    assert.equal(filtered.code, 0, filtered.stderr)
    assert.ok(parseJson<{ results: Array<{ chapter: number }> }>(filtered.stdout).results.every(item => item.chapter === 2))

    const storyline = await runCli(dir, ['search', '账本', '--storyline', '账本主线', '--json'])
    assert.equal(storyline.code, 0, storyline.stderr)
    assert.ok(parseJson<{ results: unknown[] }>(storyline.stdout).results.length > 0)

    const time = await runCli(dir, ['search', '账本', '--time', '第 1 天', '--json'])
    assert.equal(time.code, 0, time.stderr)
    assert.ok(parseJson<{ results: Array<{ chapter: number }> }>(time.stdout).results.every(item => item.chapter === 1))

    const location = await runCli(dir, ['search', '账本', '--location', '海港', '--json'])
    assert.equal(location.code, 0, location.stderr)
    assert.ok(parseJson<{ results: unknown[] }>(location.stdout).results.length > 0)

    const sample = path.join(dir, 'sample.txt')
    await writeFile(sample, '第一章 起点\n林岚来到码头。\n\n第二章 账本\n她翻开账本。\n')
    const deconstructed = await runCli(dir, ['deconstruct', 'sample.txt', '--save', '--json'])
    assert.equal(deconstructed.code, 0, deconstructed.stderr)
    const report = parseJson<{
      provenance: string
      savedPath?: string
      totals: { chapters: number }
      chapters: Array<{ openingExcerpt: string; sceneFunctions: string[]; repeatedPatterns: string[] }>
    }>(deconstructed.stdout)
    assert.equal(report.totals.chapters, 2)
    assert.equal(report.provenance, 'reference')
    assert.ok(report.savedPath)
    assert.ok(report.chapters.every(item => [...item.openingExcerpt].length <= 80))
    assert.ok(report.chapters.every(item => Array.isArray(item.sceneFunctions)))
    assert.ok(report.chapters.every(item => Array.isArray(item.repeatedPatterns)))

    const epub = path.join(dir, 'sample.epub')
    const zip = zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
      'OEBPS/content.opf': strToU8(
        '<?xml version="1.0"?><package><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      ),
      'OEBPS/chapter1.xhtml': strToU8(
        '<html><head><title>第一章</title></head><body><p>林岚在码头翻开账本。</p></body></html>',
      ),
    })
    await writeFile(epub, zip)
    const deconstructedEpub = await runCli(dir, ['deconstruct', 'sample.epub', '--json'])
    assert.equal(deconstructedEpub.code, 0, deconstructedEpub.stderr)
    const epubReport = parseJson<{ format: string; totals: { chapters: number } }>(deconstructedEpub.stdout)
    assert.equal(epubReport.format, 'epub')
    assert.equal(epubReport.totals.chapters, 1)

    const exported = await runCli(dir, ['export', '--format', 'merged', '--platform', 'qidian', '--json'])
    assert.equal(exported.code, 0, exported.stderr)
    const exportPayload = parseJson<{ platform: string; characters: number }>(exported.stdout)
    assert.equal(exportPayload.platform, 'qidian')
    assert.ok(exportPayload.characters > 0)

    const custom = await runCli(dir, [
      'export', '--format', 'merged', '--platform', 'custom', '--count-mode', 'cjk', '--json',
    ])
    assert.equal(custom.code, 0, custom.stderr)
    const customPayload = parseJson<{ platform: string; characters: number }>(custom.stdout)
    assert.equal(customPayload.platform, 'custom')
    assert.ok(customPayload.characters > 0)
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

test('P0-safe continuation exposes covered previous prose for the same POV only', async () => {
  const first = '林岚在码头翻开账本。\n\n她把缺页按回书脊，记住了港务局的印。'
  const second = '林岚回到码头，缺页的折痕还在。\n'
  const extraction = JSON.stringify({
    summary: '林岚发现账本缺页',
    noEventsReason: null,
    records: [{
      recordId: 'r1',
      kind: 'event',
      summary: '林岚发现账本缺页',
      participants: ['林岚'],
      location: '海港',
      storyTime: '第一天',
      payload: {},
      evidence: [
        { quote: '林岚在码头翻开账本。', occurrence: 1 },
        { quote: '她把缺页按回书脊，记住了港务局的印。', occurrence: 1 },
      ],
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
      evidence: [{ quote: '林岚在码头翻开账本。', occurrence: 1 }],
    }],
    facts: [],
    beliefs: [],
    loops: [],
  })
  const model = new FakeModel([first, extraction, coveragePayload(), warningReviewFor('林岚在码头翻开账本。'), second])
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
    const payload = parseJson<{ included: string[] }>(written.stdout)
    assert.ok(payload.included.includes('finalized-history:continuation:1'))

    const body = JSON.stringify(model.requests[4])
    assert.ok(body.includes('上一章定稿结尾（POV 已验证）'), body.slice(0, 200))
    assert.ok(body.includes('她把缺页按回书脊'))
    assert.ok(body.includes('prose'))
    assert.ok(body.includes('林岚发现账本缺页'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('retrieval feeds finalized evidence into the prompt and filters other POVs', async () => {
  const model = new FakeModel(['林岚把铜扣翻过来，看清了背面的编号。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [
      { name: '林岚', status: 'alive', introducedIn: 1 },
      { name: '周砚', status: 'alive', introducedIn: 1 },
    ])
    await setContract(dir, 1, { pov: '周砚', characters: ['周砚'] })
    assert.equal((await checkContract(dir, 1)).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '周砚把铜扣翻过来，背面刻着一串潮汐编号。\n')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2, { pov: '林岚', characters: ['林岚'] })
    assert.equal((await checkContract(dir, 2)).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '002.md'), '林岚在旧仓库翻到一枚铜扣，背面被磨平了。\n')
    assert.equal((await runCli(dir, ['finalize', '2', '--json'])).code, 0)

    await setContract(dir, 3, { pov: '林岚', characters: ['林岚'] })
    assert.equal((await checkContract(dir, 3)).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '003.md'), '她把铜扣收进口袋，决定第二天再回仓库。\n')
    assert.equal((await runCli(dir, ['finalize', '3', '--json'])).code, 0)

    await setContract(dir, 4, {
      pov: '林岚',
      characters: ['林岚'],
      threads: ['铜扣'],
      previousLink: '承接铜扣这条线索',
    })
    assert.equal((await checkContract(dir, 4)).code, 0)
    const written = await runCli(dir, ['write', '4', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stdout + written.stderr)
    const payload = parseJson<{ included: string[] }>(written.stdout)
    assert.ok(payload.included.some(id => id.startsWith('finalized-history:ch-002-')), JSON.stringify(payload.included))

    const body = JSON.stringify(model.requests[0])
    assert.ok(body.includes('林岚在旧仓库翻到一枚铜扣'), 'same-POV evidence should reach the prompt')
    assert.equal(body.includes('背面刻着一串潮汐编号'), false, 'another POV chapter must not leak')

    const db = new DatabaseSync(path.join(dir, '.weave', 'index.db'))
    db.prepare("UPDATE search_state SET status = 'stale' WHERE id = 1").run()
    db.close()
    const stale = await runCli(dir, ['write', '4', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(stale.code, 4)
    const stalePayload = parseJson<{ error: { message: string } }>(stale.stdout)
    assert.match(stalePayload.error.message, /检索索引/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('revision prompt carries contract, neighbours, style and constraints', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload(true), revision])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    await setContract(dir, 1, { goal: '找出账本缺页的因果链' })
    assert.equal((await checkContract(dir, 1)).code, 0)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    assert.equal(revised.code, 0, revised.stderr)
    const payload = parseJson<{ candidate: { contextMode: string } }>(revised.stdout)
    assert.equal(payload.candidate.contextMode, 'enriched')

    const body = JSON.stringify(model.requests[4])
    assert.ok(body.includes('本章合同'))
    assert.ok(body.includes('前后文'))
    assert.ok(body.includes('不可改变'))
    assert.ok(body.includes('林岚在码头翻开账本'), 'neighbour paragraph must be included')
    assert.ok(body.includes('structure-causality'), 'routed method should reach the revision prompt')
    assert.ok(body.includes('风格宪法'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy revision mode keeps the prompt minimal for A/B comparison', async () => {
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload(true), revision])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'], { WEAVE_REVISION_CONTEXT: 'legacy' })
    assert.equal(revised.code, 0, revised.stderr)
    const payload = parseJson<{ candidate: { contextMode: string } }>(revised.stdout)
    assert.equal(payload.candidate.contextMode, 'legacy')
    const body = JSON.stringify(model.requests[4])
    assert.equal(body.includes('本章合同'), false)
    assert.equal(body.includes('前后文'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('effect review stays advisory and downgrades blocking severity', async () => {
  const effect = JSON.stringify({
    summary: '结尾把问题解释完了，读者没有下一步可追。',
    findings: [{
      dimension: '章末追读',
      severity: 'blocking',
      description: '结局解释过满',
      quote: '她发现缺页上留着港务局的印。',
      occurrence: 1,
    }],
  })
  const model = new FakeModel([effect])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await writeFile(
      path.join(dir, 'chapters', 'drafts', '001.md'),
      '林岚在码头翻开账本。\n\n她发现缺页上留着港务局的印。\n\n总之，她终于明白了一切。\n',
    )
    const reviewed = await runCli(dir, ['effect-review', '1', '--json'])
    assert.equal(reviewed.code, 0, reviewed.stderr)
    const payload = parseJson<{
      passed: boolean
      findings: Array<{ severity: string; source: string; dimension: string; quote?: string }>
    }>(reviewed.stdout)
    assert.equal(payload.passed, true)
    assert.ok(payload.findings.every(item => item.severity === 'warning' || item.severity === 'info'))
    assert.ok(payload.findings.some(item => item.source === 'lint' && item.dimension === '章末追读'))
    const modelFinding = payload.findings.find(item => item.source === 'model')
    assert.equal(modelFinding?.severity, 'warning')
    assert.equal(modelFinding?.quote, '她发现缺页上留着港务局的印。')

    const saved = JSON.parse(await readFile(path.join(dir, '.weave', 'stages', 'effect-review', '001.json'), 'utf8'))
    assert.equal(saved.passed, true)

    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stderr)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('effect review CLI enables external deslop only with an explicit component root', async () => {
  const effect = JSON.stringify({ summary: '外部结果只作为软建议。', findings: [] })
  const model = new FakeModel([effect])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '不是账本缺页，而是有人换掉了它。\n')
    const reviewed = await runCli(dir, [
      'effect-review', '1', '--external-deslop-root', path.join(REPO_ROOT, 'test', 'fixtures', 'oh-story'), '--json',
    ])
    assert.equal(reviewed.code, 0, reviewed.stderr)
    const payload = parseJson<{ findings: Array<{ source: string; severity: string; upstreamSeverity?: string }> }>(reviewed.stdout)
    const external = payload.findings.find(item => item.source === 'external')
    assert.ok(external)
    assert.equal(external.severity, 'warning')
    assert.equal(external.upstreamSeverity, 'blocking')

    const missingRoot = await runCli(dir, ['effect-review', '1', '--external-deslop-root', '--json'])
    assert.equal(missingRoot.code, 2)
    assert.match(missingRoot.stdout, /缺少 --external-deslop-root/)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('effect review lints overdue loops from the real ledger', async () => {
  const effect = JSON.stringify({ summary: '本章没有明显效果问题。', findings: [] })
  const model = new FakeModel([
    P05_DRAFT,
    loopExtractionPayload([{
      loopId: 'loop-1',
      kind: 'plant',
      summary: '账本缺页的来源',
      targetFromChapter: 1,
      targetToChapter: 1,
      relatedEntities: ['林岚'],
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    }]),
    coveragePayload(),
    warningReviewFor('她发现缺页上留着港务局的印。'),
    effect,
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '002.md'), '林岚回到码头，缺页还在桌上。\n')

    const reviewed = await runCli(dir, ['effect-review', '2', '--json'])
    assert.equal(reviewed.code, 0, reviewed.stderr)
    const payload = parseJson<{ findings: Array<{ description: string; source: string }> }>(reviewed.stdout)
    assert.ok(payload.findings.some(item =>
      item.source === 'lint' && item.description.includes('账本缺页的来源') && item.description.includes('仍为 planted'),
    ), JSON.stringify(payload.findings))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('long-form memory stays bounded, POV-scoped and refreshes after an amend', async () => {
  const model = new FakeModel(['第四章草稿', '第四章草稿二'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await setCharacters(dir, [{ name: '林岚', status: 'alive', introducedIn: 1 }])
    for (const chapter of [1, 2, 3]) {
      await setContract(dir, chapter, { title: chapter === 1 ? '缺页' : `第${chapter}章` })
      assert.equal((await checkContract(dir, chapter)).code, 0)
      await writeFile(
        path.join(dir, 'chapters', 'drafts', `${String(chapter).padStart(3, '0')}.md`),
        `第${chapter}章正文。\n\n林岚把第${chapter}份记录收进铁盒。\n`,
      )
      assert.equal((await runCli(dir, ['finalize', String(chapter), '--json'])).code, 0)
    }

    const status = parseJson<{ memory: { current: boolean; throughChapter: number } }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status.memory.current, true)
    assert.equal(status.memory.throughChapter, 3)

    const memory = JSON.parse(await readFile(path.join(dir, '.weave', 'memory.json'), 'utf8')) as {
      storySoFar: string
      pov: Record<string, string>
    }
    assert.match(memory.storySoFar, /缺页/)
    assert.match(memory.pov['林岚'] ?? '', /第1章/)

    await setContract(dir, 4, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 4)).code, 0)
    const written = await runCli(dir, ['write', '4', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const included = parseJson<{ included: string[] }>(written.stdout).included
    assert.ok(included.includes('memory:pov:林岚'))
    assert.equal(included.includes('memory:story-so-far'), false, 'limited POV must not receive the author summary')
    assert.ok(JSON.stringify(model.requests[0]).includes('第1章'))

    await setContract(dir, 1, { title: '缺页（改）' })
    assert.equal((await checkContract(dir, 1)).code, 0)
    assert.equal((await runCli(dir, ['amend', '1', '--json'])).code, 0)
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '改过的第一章。\n\n林岚重新数了一遍缺页。\n')
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    const refreshed = JSON.parse(await readFile(path.join(dir, '.weave', 'memory.json'), 'utf8')) as {
      mainlineRevision: number
      storySoFar: string
    }
    assert.equal(refreshed.mainlineRevision, 4)
    assert.match(refreshed.storySoFar, /缺页（改）/)

    const second = await runCli(dir, ['write', '4', '--json'])
    assert.equal(second.code, 0, second.stderr)
    assert.ok(JSON.stringify(model.requests[1]).includes('缺页（改）'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POV knowledge splits critical scene state from compressible background', async () => {
  const facts = [
    {
      factId: 'fact-location',
      subject: '林岚',
      predicate: 'location',
      object: '三号泊位',
      validFromChapter: 1,
      validToChapter: null,
      sourceRecordId: 'r1',
      origin: 'derived',
      supersedes: null,
      confidence: 0.9,
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      factId: `fact-habit-${index}`,
      subject: '林岚',
      predicate: `habit_${index}`,
      object: `旧习惯 ${index}`,
      validFromChapter: 1,
      validToChapter: null,
      sourceRecordId: 'r1',
      origin: 'derived',
      supersedes: null,
      confidence: 0.5,
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    })),
  ]
  const beliefs = [
    {
      beliefId: 'belief-mis',
      characterId: '林岚',
      proposition: '周砚出卖了父亲',
      attitude: 'misbelieves',
      sourceRecordId: 'r1',
      learnedAtChapter: 1,
      confidence: 0.7,
      validFromChapter: 1,
      validToChapter: null,
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      beliefId: `belief-bg-${index}`,
      characterId: '林岚',
      proposition: `旧传闻 ${index}`,
      attitude: 'believes',
      sourceRecordId: 'r1',
      learnedAtChapter: 1,
      confidence: 0.4,
      validFromChapter: 1,
      validToChapter: null,
      evidence: [{ quote: '她发现缺页上留着港务局的印。', occurrence: 1 }],
    })),
  ]
  const model = new FakeModel([
    P05_DRAFT,
    ledgerExtractionPayload(facts, beliefs),
    coveragePayload(),
    warningReviewFor('她发现缺页上留着港务局的印。'),
    '第二章正文。',
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)

    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    const written = await runCli(dir, ['write', '2', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const included = parseJson<{ included: string[] }>(written.stdout).included
    assert.ok(included.includes('pov:knowledge:critical'))
    assert.ok(included.includes('pov:knowledge:background'))

    const body = JSON.stringify(model.requests[4])
    assert.ok(body.includes('三号泊位'), 'current scene state must stay')
    assert.ok(body.includes('周砚出卖了父亲'), 'motivating misbelief must stay')
    assert.ok(body.includes('旧传闻 0'), 'long-tail background is still available')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('prompt renderers switch without changing materials, and stable layers stay stable', async () => {
  const model = new FakeModel(['第一章正文。', '第二章正文。', '第二章正文（json）。'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await setContract(dir, 1, {
      readerIntent: {
        purpose: 'release',
        payoff: '读者看到林岚确认账本被人动过',
        intensity: 'strong',
        hook: '谁动过账本',
      },
    })
    assert.equal((await checkContract(dir, 1)).code, 0)
    const first = await runCli(dir, ['write', '1', '--json'], { WEAVE_PROMPT_RENDERER: 'mission' })
    assert.equal(first.code, 0, first.stderr)
    const firstPayload = parseJson<{ renderer: string; layers: { stable: string; chapter: string } }>(first.stdout)
    assert.equal(firstPayload.renderer, 'mission')
    const missionBody = JSON.stringify(model.requests[0])
    assert.ok(missionBody.includes('环境描写'))
    assert.ok(missionBody.includes('【本章任务】'))
    assert.ok(missionBody.includes('【这一章要发生的事】'))
    assert.ok(missionBody.includes('必须发生：'))
    assert.ok(missionBody.includes('【阅读效果意图（软目标）】'))
    assert.ok(missionBody.includes('读者看到林岚确认账本被人动过'))
    assert.ok(missionBody.includes('谁动过账本'))
    assert.equal(missionBody.includes('"mustHappen"'), false)

    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    const second = await runCli(dir, ['write', '2', '--json'], { WEAVE_PROMPT_RENDERER: 'mission' })
    assert.equal(second.code, 0, second.stderr)
    const secondPayload = parseJson<{ layers: { stable: string; chapter: string } }>(second.stdout)
    assert.equal(secondPayload.layers.stable, firstPayload.layers.stable)
    assert.notEqual(secondPayload.layers.chapter, firstPayload.layers.chapter)

    const json = await runCli(dir, ['write', '2', '--json'], { WEAVE_PROMPT_RENDERER: 'json' })
    assert.equal(json.code, 0, json.stderr)
    assert.equal(parseJson<{ renderer: string }>(json.stdout).renderer, 'json')
    assert.ok(JSON.stringify(model.requests[2]).includes('mustHappen'))
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('key chapters add bounded paragraph candidates while ordinary chapters stay single-pass', async () => {
  const model = new FakeModel([
    '第一章草稿，开头平铺。\n\n中段没有变化。\n\n结尾停在半句上。',
    JSON.stringify({ text: '改好的结尾，问题还悬着。' }),
    JSON.stringify({ text: '另一种收法，把问题推到明天。' }),
    '第二章草稿。',
  ])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    await setContract(dir, 1, { importance: 'key', keyFocus: ['ending'] })
    assert.equal((await checkContract(dir, 1)).code, 0)
    const written = await runCli(dir, ['write', '1', '--json'])
    assert.equal(written.code, 0, written.stderr)
    const payload = parseJson<{
      keyCandidates: Array<{ focus: string; paragraphId: string; revisionIds: string[] }>
    }>(written.stdout)
    assert.equal(payload.keyCandidates.length, 1)
    assert.equal(payload.keyCandidates[0]?.focus, 'ending')
    assert.equal(payload.keyCandidates[0]?.paragraphId, 'p003')
    assert.equal(payload.keyCandidates[0]?.revisionIds.length, 2)
    assert.equal(model.requests.length, 3)

    const draftBefore = await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8')
    assert.match(draftBefore, /结尾停在半句上/)
    const merged = await runCli(dir, [
      'merge', '1', '--revision', payload.keyCandidates[0]!.revisionIds[0]!, '--json',
    ])
    assert.equal(merged.code, 0, merged.stderr)
    assert.match(await readFile(path.join(dir, 'chapters', 'drafts', '001.md'), 'utf8'), /改好的结尾/)

    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    const ordinary = await runCli(dir, ['write', '2', '--json'])
    assert.equal(ordinary.code, 0, ordinary.stderr)
    assert.deepEqual(parseJson<{ keyCandidates: unknown[] }>(ordinary.stdout).keyCandidates, [])
    assert.equal(model.requests.length, 4)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('author preferences learn only from repeated signals and can be disabled', async () => {
  const review = JSON.stringify({
    summary: '两条建议',
    findings: [
      { dimension: '章末追读', severity: 'warning', description: '章末可以更狠', quote: '林岚在码头翻开账本。', occurrence: 1 },
      { dimension: '章末追读', severity: 'warning', description: '结尾少一句解释', quote: '她发现缺页上留着港务局的印。', occurrence: 1 },
    ],
  })
  const model = new FakeModel([
    P05_DRAFT,
    extractionPayload(),
    coveragePayload(),
    review,
    '第二章草稿。',
    '第二章草稿二。',
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    for (const finding of ['f1', 'f2']) {
      const ignored = await runCli(dir, ['ignore', '1', '--finding', finding, '--reason', '作者保留原句节奏', '--json'])
      assert.equal(ignored.code, 0, ignored.stderr)
    }

    const signals = parseJson<{ signals: Array<{ dimension: string; kind: string }> }>(
      (await runCli(dir, ['preference', 'status', '--json'])).stdout,
    )
    assert.equal(signals.signals.filter(item => item.kind === 'rejected').length, 2)

    const reviewed = await runCli(dir, ['preference', 'review', '--json'])
    assert.equal(reviewed.code, 0, reviewed.stderr)
    const candidates = parseJson<{ candidates: Array<{ id: string; evidenceCount: number; status: string }> }>(reviewed.stdout)
    assert.equal(candidates.candidates.length, 1)
    assert.equal(candidates.candidates[0]?.evidenceCount, 2)
    assert.equal(candidates.candidates[0]?.status, 'draft')

    const id = candidates.candidates[0]!.id
    assert.equal((await runCli(dir, ['preference', 'approve', id, '--json'])).code, 0)

    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
    await setContract(dir, 2, { characters: ['林岚'], pov: '林岚' })
    assert.equal((await checkContract(dir, 2)).code, 0)
    const written = await runCli(dir, ['write', '2', '--json'])
    assert.equal(written.code, 0, written.stderr)
    assert.ok(JSON.stringify(model.requests[4]).includes('已批准的创作偏好'))
    assert.ok(JSON.stringify(model.requests[4]).includes('作者保留原句节奏'))

    assert.equal((await runCli(dir, ['preference', 'disable', id, '--json'])).code, 0)
    const second = await runCli(dir, ['write', '2', '--json'])
    assert.equal(second.code, 0, second.stderr)
    assert.equal(JSON.stringify(model.requests[5]).includes('已批准的创作偏好'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('content check blocks prose that ends mid-sentence', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '林岚在码头翻开账本。\n\n她停下来，把调')
    const checked = await runCli(dir, ['check', '1', '--json'])
    assert.equal(checked.code, 3)
    const payload = parseJson<{ passed: boolean; findings: Array<{ code: string; severity: string }> }>(checked.stdout)
    assert.equal(payload.passed, false)
    assert.ok(payload.findings.some(item => item.code === 'TRUNCATED_ENDING' && item.severity === 'blocking'))

    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '林岚在码头翻开账本。\n\n她听见身后有人，猛地回头——')
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0, 'em dash is a valid suspense ending')

    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), P05_DRAFT)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('content check warns when a chapter opens with an environment block', async () => {
  const model = new FakeModel([P05_DRAFT, extractionPayload(), coveragePayload(), reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    await writeFile(
      path.join(dir, 'chapters', 'drafts', '001.md'),
      '风从海面压过来，带着铁锈和柴油味。天还没黑透，西边云层低矮，只剩一条黄线。\n\n林岚把帆布包抱在胸前。\n',
    )
    const warned = await runCli(dir, ['check', '1', '--json'])
    assert.equal(warned.code, 0, warned.stderr)
    const warnedPayload = parseJson<{ findings: Array<{ code: string; severity: string }> }>(warned.stdout)
    assert.ok(warnedPayload.findings.some(item => item.code === 'ENVIRONMENT_OPENING' && item.severity === 'warning'))

    await writeFile(
      path.join(dir, 'chapters', 'drafts', '001.md'),
      '林岚把帆布包抱在胸前，走进仓库。\n\n风从海面压过来，带着铁锈和柴油味。\n',
    )
    const clean = await runCli(dir, ['check', '1', '--json'])
    assert.equal(clean.code, 0, clean.stderr)
    const cleanPayload = parseJson<{ findings: Array<{ code: string }> }>(clean.stdout)
    assert.equal(cleanPayload.findings.some(item => item.code === 'ENVIRONMENT_OPENING'), false)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('p0 finalize runs the deterministic content check and blocks truncated prose', async () => {
  const model = new FakeModel(['林岚把账本摊在桌上，缺页的边缘还留着新鲜折痕，她伸手去摸那道'])
  await model.start()
  const dir = await initBook(model.baseUrl)
  try {
    await contract1(dir)
    const written = await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })
    assert.equal(written.code, 0, written.stderr)
    const blocked = await runCli(dir, ['finalize', '1', '--json'])
    assert.notEqual(blocked.code, 0)
    const payload = parseJson<{ error: { message: string; details: Array<{ code: string }> } }>(blocked.stdout)
    assert.match(payload.error.message, /内容检查未通过/)
    assert.ok(payload.error.details.some(finding => finding.code === 'TRUNCATED_ENDING'))
    assert.equal(await readFile(path.join(dir, 'chapters', 'final', '001.md'), 'utf8').catch(() => null), null)

    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), '林岚把账本摊在桌上，缺页的边缘还留着新鲜折痕。\n')
    const finalized = await runCli(dir, ['finalize', '1', '--json'])
    assert.equal(finalized.code, 0, finalized.stdout + finalized.stderr)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Stage A: second-pass audit missed items can be dismissed with reason or ignored when quote is unresolvable', async () => {
  const missedWithBadQuote = JSON.stringify({
    summary: '第二遍发现遗漏但含一条坏引文',
    missed: [
      {
        summary: '林岚其实已经把信交给了港务局',
        quote: '她发现缺页上留着港务局的印。',
        occurrence: 1,
      },
      {
        summary: '模型幻觉出的不存在事件',
        quote: '这段话在正文里根本不存在。',
        occurrence: 1,
      },
    ],
  })
  const model = new FakeModel([P05_DRAFT, extractionPayload(), missedWithBadQuote, reviewPayload()])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    const audited = await runCli(dir, ['audit', '1', '--json'])
    assert.equal(audited.code, 3)
    const auditPayload = parseJson<{
      passed: boolean
      secondPass: {
        missed: string[]
        missedItems: Array<{ missedId: string; summary: string }>
        rejected: string[]
      }
      warnings: string[]
    }>(audited.stdout)
    assert.equal(auditPayload.passed, false)
    assert.deepEqual(auditPayload.secondPass.missed, ['林岚其实已经把信交给了港务局'])
    assert.equal(auditPayload.secondPass.missedItems.length, 1)
    assert.equal(auditPayload.secondPass.rejected.length, 1)
    assert.ok(auditPayload.warnings.some(w => w.includes('作为噪声忽略')))

    const missedId = auditPayload.secondPass.missedItems[0]!.missedId
    const decided = await runCli(dir, [
      'audit', 'decide', '1', '--missed', missedId, '--decision', 'dismiss', '--reason', '只是背景修辞，非遗漏事件', '--json',
    ])
    assert.equal(decided.code, 0, decided.stdout + decided.stderr)
    const decidedPayload = parseJson<{ ok: boolean; audit: { passed: boolean; secondPass: { missed: string[] } } }>(decided.stdout)
    assert.equal(decidedPayload.ok, true)
    assert.equal(decidedPayload.audit.passed, true)
    assert.deepEqual(decidedPayload.audit.secondPass.missed, [])

    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['finalize', '1', '--json'])).code, 0)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Stage B: recheck includes manual edits in non-target paragraphs and blocks >30% manual rewrites', async () => {
  const fourParaDraft = [
    '林岚在码头翻开账本。海风吹得纸页哗哗作响，她把每一行数字都核对了一遍。',
    '她发现缺页上留着港务局的印。',
    '远处仓库的灯还亮着，守夜人正在巡逻，脚步声在石板路上回荡了很久。',
    '林岚合上账本，决定明天一早再去档案室核查底单与货运编号。',
  ].join('\n\n')
  const revision = JSON.stringify({
    paragraphs: [{
      paragraphId: 'p002',
      text: '第二段：她发现缺页上留着港务局的印，决定追查下去。',
      findingIds: ['f1'],
    }],
  })
  const recheck = JSON.stringify({
    summary: '复检通过且检查了手改段',
    findings: [{
      findingId: 'f1',
      resolved: true,
      note: '已补充动机',
      quote: '她发现缺页上留着港务局的印，决定追查下去。',
    }],
    newFindings: [],
  })
  const model = new FakeModel([
    fourParaDraft,
    extractionPayload('她发现缺页上留着港务局的印。'),
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
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    assert.equal(revised.code, 0, revised.stderr)
    const { revisionId } = parseJson<{ revisionId: string }>(revised.stdout)

    // Small manual edit in p004 (<30% of chapter) before merge:
    const smallManual = [
      '林岚在码头翻开账本。海风吹得纸页哗哗作响，她把每一行数字都核对了一遍。',
      '她发现缺页上留着港务局的印。',
      '远处仓库的灯还亮着，守夜人正在巡逻，脚步声在石板路上回荡了很久。',
      '林岚合上账本，顺手记下值班表编号。',
    ].join('\n\n')
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), smallManual)

    const merged = await runCli(dir, ['merge', '1', '--revision', revisionId, '--json'])
    assert.equal(merged.code, 0, merged.stdout + merged.stderr)
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const rechecked = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(rechecked.code, 0, rechecked.stdout + rechecked.stderr)
    const recheckPrompt = JSON.stringify(model.requests[7])
    assert.ok(recheckPrompt.includes('顺手记下值班表编号'), 'recheck prompt must include manually edited p004')
    assert.ok(recheckPrompt.includes('作者在修订目标之外手动修改'))

    // Now test >30% manual edits: rewrite both p001 and p003 manually (>60% of chapter) and recheck must block
    const SecondReview = reviewPayload(true)
    model.requests.length = 0
    const heavyManual = [
      '林岚在码头翻开账本。她把整本册子从头到尾重新抄录在防水纸上，又核对了三遍船期。',
      '第二段：她发现缺页上留着港务局的印，决定追查下去。',
      '远处仓库的灯已经熄了，整条栈桥空无一人，只有海水拍打缆桩的闷响。',
      '林岚合上账本，顺手记下值班表编号。',
    ].join('\n\n')
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), heavyManual)
    const mergeReportPath = path.join(dir, '.weave', 'revisions', '001', `${revisionId}.merge.json`)
    const mergeData = JSON.parse(await readFile(mergeReportPath, 'utf8')) as { mergedDraftHash: string }
    const { hashText } = await import('../src/core/hash.ts')
    mergeData.mergedDraftHash = hashText(heavyManual)
    await writeFile(mergeReportPath, JSON.stringify(mergeData, null, 2))
    const reviewStagePath = path.join(dir, '.weave', 'stages', 'review', '001.json')
    const reviewStage = JSON.parse(await readFile(reviewStagePath, 'utf8')) as { findings: Array<{ status: string }> }
    reviewStage.findings[0]!.status = 'applied'
    await writeFile(reviewStagePath, JSON.stringify(reviewStage, null, 2))
    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    // Push extraction + audit responses for heavyManual
    ;(model as unknown as { texts: string[] }).texts.push(
      extractionPayload('她发现缺页上留着港务局的印'),
      coveragePayload(),
    )
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    const blockedRecheck = await runCli(dir, ['recheck', '1', '--json'])
    assert.equal(blockedRecheck.code, 4)
    assert.match(parseJson<{ error: { message: string } }>(blockedRecheck.stdout).error.message, /超过 30% 阈值/)
    void SecondReview
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Stage B: merge detects paragraph count changes as conflict instead of silently shifting IDs', async () => {
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
  ])
  await model.start()
  const dir = await prepareP05(model)
  try {
    assert.equal((await runCli(dir, ['extract', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['audit', '1', '--json'])).code, 0)
    assert.equal((await runCli(dir, ['review', '1', '--json'])).code, 7)
    const revised = await runCli(dir, ['revise', '1', '--findings', 'f1', '--json'])
    const { revisionId } = parseJson<{ revisionId: string }>(revised.stdout)

    // Author inserts a new paragraph at the top, shifting p001/p002
    await writeFile(path.join(dir, 'chapters', 'drafts', '001.md'), `新插入的开头段。\n\n${P05_DRAFT}\n`)
    const merged = await runCli(dir, ['merge', '1', '--revision', revisionId, '--json'])
    assert.equal(merged.code, 3)
    const payload = parseJson<{ report: { status: string } }>(merged.stdout)
    assert.equal(payload.report.status, 'conflict')
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Stage C & D: status reports two-phase next step and key-candidates command generates passage candidates', async () => {
  const longDraft = [
    '林岚站在三号泊位的探照灯下，手里的潮汐账本已经被雨水泡软了边角。她盯着被撕掉的那一页编号，心里清楚今晚必须拿到货单。港区巡逻队的哨声从栈桥另一头逼近，留给她翻找底档的时间只剩不到十分钟。',
    '守门的老谭把钥匙压在铁盒下面，低声警告她港务局的人刚刚来过。如果她现在推门进去，不管是谁都会被当成夜盗扣下；可如果她退回去，明早这批货就会随着早潮彻底消失在公海。',
    '她没有再犹豫，直接用袖口垫着拧开了生锈的挂锁。冷库里的寒气扑面而来，最里侧的货架上整齐码着十二只本该已经沉海的木箱，每只木箱侧面都烙着同一个编号。',
    '就在她举起相机拍下编号的瞬间，冷库大门在身后轰然合拢，门外传来周砚冷静的声音：“林会计，账算到这一页就够了。”',
  ].join('\n\n')
  const model = new FakeModel([
    longDraft,
    JSON.stringify({ text: '门外传来周砚贴着铁门的声音：“林岚，你翻开的那一页，正是我今晚要烧掉的。”\n\n冷库的排风扇同时停转，温度表开始往下掉。' }),
    JSON.stringify({ text: '手电筒的光柱从观察窗外直直打在她脸上，周砚隔着厚玻璃举起了那页失踪的底单。' }),
  ])
  await model.start()
  const dir = await initBook(model.baseUrl, [], 'p05')
  try {
    await contract1(dir)
    assert.equal((await runCli(dir, ['write', '1', '--json'], { WEAVE_API_KEY: SECRET })).code, 0)
    const status1 = parseJson<{ draftStages: Array<{ phase: string; nextCommand: string }> }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status1.draftStages[0]?.phase, 'polishing')
    assert.equal(status1.draftStages[0]?.nextCommand, 'weave check 1')

    assert.equal((await runCli(dir, ['check', '1', '--json'])).code, 0)
    const status2 = parseJson<{ draftStages: Array<{ phase: string; nextCommand: string }> }>(
      (await runCli(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status2.draftStages[0]?.phase, 'polishing')
    assert.equal(status2.draftStages[0]?.nextCommand, 'weave effect-review 1')

    const kc = await runCli(dir, ['key-candidates', '1', '--focus', 'ending', '--json'])
    assert.equal(kc.code, 0, kc.stdout + kc.stderr)
    const kcPayload = parseJson<{
      keyCandidates: Array<{ focus: string; paragraphIds: string[]; revisionIds: string[] }>
    }>(kc.stdout)
    assert.equal(kcPayload.keyCandidates.length, 1)
    assert.equal(kcPayload.keyCandidates[0]?.focus, 'ending')
    assert.ok((kcPayload.keyCandidates[0]?.paragraphIds.length ?? 0) >= 2, 'should select a multi-paragraph passage')
    assert.equal(kcPayload.keyCandidates[0]?.revisionIds.length, 2)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
