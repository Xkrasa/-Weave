import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
  private readonly server: Server
  baseUrl = ''

  constructor() {
    this.server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第五章正文。' } }] })}\n\n`)
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

const DUPLICATE = '港口的旧册子写着每次靠岸前压了多深的水。'
const LIGHTHOUSE = [
  '灯塔的玻璃上结着盐霜，她抬手擦了一遍。',
  '灯塔下面堆着生锈的铁桶，桶口缠着旧绳。',
  '她沿着灯塔外的石阶往下走，鞋跟磕出回声。',
]

test('retrieved evidence deduplicates near-identical prose and caps each chapter', async () => {
  const model = new FakeModel()
  await model.start()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-diversity-'))
  try {
    const init = await runCli(dir, ['init', '.', '--title', '检索多样性', '--model', 'fake', '--base-url', model.baseUrl, '--workflow', 'p0'])
    assert.equal(init.code, 0, init.stderr)
    await writeFile(
      path.join(dir, 'canon', 'characters.json'),
      `${JSON.stringify({ characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }] }, null, 2)}\n`,
    )

    const texts = [
      DUPLICATE,
      DUPLICATE,
      DUPLICATE,
      LIGHTHOUSE.join('\n\n'),
      '她把抽屉清空，只剩一把钥匙。',
    ]
    for (const [index, text] of texts.entries()) {
      const chapter = index + 1
      const stem = String(chapter).padStart(3, '0')
      await writeFile(path.join(dir, 'outlines', 'chapters', `${stem}.json`), `${JSON.stringify({
        chapter,
        title: `第${chapter}章`,
        pov: '林岚',
        time: `第${chapter}天`,
        location: '码头',
        openingState: '天色将晚',
        endingState: '事情没有结果',
        goal: '处理当天的事',
        obstacle: '没有进展',
        mustHappen: ['她处理了一件事'],
        mayHappen: [],
        mustNotHappen: [],
        characters: ['林岚'],
        threads: ['记录'],
        targetWords: 800,
        previousLink: '承接上一章',
        nextLink: '继续',
      }, null, 2)}\n`)
      assert.equal((await runCli(dir, ['contract', 'check', String(chapter), '--json'])).code, 0)
      await writeFile(path.join(dir, 'chapters', 'drafts', `${stem}.md`), `${text}\n`)
      assert.equal((await runCli(dir, ['finalize', String(chapter), '--json'])).code, 0)
    }

    await writeFile(path.join(dir, 'outlines', 'chapters', '006.json'), `${JSON.stringify({
      chapter: 6,
      title: '核对',
      pov: '林岚',
      time: '第6天',
      location: '码头',
      openingState: '她带着旧册子',
      endingState: '她发现一处对不上',
      goal: '核对旧册子',
      obstacle: '记录分散',
      mustHappen: ['她核对了一处记录'],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['林岚'],
      threads: ['旧册子'],
      targetWords: 800,
      previousLink: '承接灯塔',
      nextLink: '继续',
    }, null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '6', '--json'])).code, 0)
    const written = await runCli(dir, ['write', '6', '--json'])
    assert.equal(written.code, 0, written.stdout + written.stderr)

    const included = parseJson<{ included: string[] }>(written.stdout).included
    const retrieved = included.filter(id => id.startsWith('finalized-history'))
    assert.ok(retrieved.length >= 2, JSON.stringify(retrieved))

    const chapters = retrieved.map(id => Number(/ch-(\d{3})/.exec(id)?.[1]))
    const counts = new Map<number, number>()
    for (const chapter of chapters) counts.set(chapter, (counts.get(chapter) ?? 0) + 1)
    for (const [chapter, count] of counts) {
      assert.ok(count <= 2, `chapter ${chapter} used ${count} retrieval slots`)
    }

    const duplicateSlots = chapters.filter(chapter => chapter <= 3)
    assert.equal(duplicateSlots.length, 1, `only one near-duplicate passage may survive: ${retrieved.join(', ')}`)
    assert.ok(chapters.includes(4), `the distinct chapter must be retrieved: ${retrieved.join(', ')}`)
  } finally {
    await model.close()
    await rm(dir, { recursive: true, force: true })
  }
})
