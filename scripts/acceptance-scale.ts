import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'src', 'cli.ts')
const CHAPTERS = 150
const AMEND_CHAPTER = 75

interface Result {
  code: number
  stdout: string
  stderr: string
}

function run(cwd: string, args: string[]): Promise<Result> {
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`command timed out: ${args.join(' ')}`))
    }, 120_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function json<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, `no JSON output: ${stdout}`)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-scale-'))
  const startedAt = Date.now()
  let kept = false
  try {
    let result = await run(dir, [
      'init', '.', '--title', '百五十章验收', '--model', 'fake',
      '--base-url', 'http://127.0.0.1:1/v1', '--snapshot-every', '10',
    ])
    assert.equal(result.code, 0, result.stderr)

    await writeFile(
      path.join(dir, 'canon', 'characters.json'),
      `${JSON.stringify({
        characters: [{ name: '林岚', status: 'alive', introducedIn: 1 }],
      }, null, 2)}\n`,
    )

    for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
      const contract = {
        chapter,
        title: `第${chapter}章`,
        pov: '林岚',
        time: `第${chapter}天`,
        location: '海港',
        openingState: '林岚继续核对账本',
        endingState: '林岚确认一处缺页',
        goal: '推进账本线索',
        obstacle: '港务局阻挠',
        mustHappen: ['林岚核对一页账本'],
        mayHappen: [],
        mustNotHappen: [],
        characters: ['林岚'],
        threads: ['账本主线'],
        targetWords: 3000,
        previousLink: '承接上一章',
        nextLink: '继续推进',
      }
      const stem = String(chapter).padStart(3, '0')
      await writeFile(
        path.join(dir, 'outlines', 'chapters', `${stem}.json`),
        `${JSON.stringify(contract, null, 2)}\n`,
      )
      await writeFile(
        path.join(dir, 'chapters', 'drafts', `${stem}.md`),
        `第${chapter}章验收正文。\n\n${'林岚沿着海港的旧仓库逐页核对账本，缺页的边缘留着折痕。'.repeat(60)}\n`,
      )
    }

    result = await run(dir, ['contract', 'check', '--all', '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(json<{ checked: number }>(result.stdout).checked, CHAPTERS)

    for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
      result = await run(dir, ['finalize', String(chapter), '--json'])
      assert.equal(result.code, 0, `finalize ${chapter}: ${result.stdout}${result.stderr}`)
      if (chapter % 25 === 0) process.stderr.write(`finalized ${chapter}/${CHAPTERS}\n`)
    }

    const status = json<{ chapters: unknown[]; mainlineRevision: number }>(
      (await run(dir, ['status', '--json'])).stdout,
    )
    assert.equal(status.chapters.length, CHAPTERS)
    assert.equal(status.mainlineRevision, CHAPTERS)

    result = await run(dir, ['doctor', '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)

    result = await run(dir, ['amend', String(AMEND_CHAPTER), '--json'])
    assert.equal(result.code, 0, result.stderr)
    const amendedStem = String(AMEND_CHAPTER).padStart(3, '0')
    await writeFile(
      path.join(dir, 'chapters', 'drafts', `${amendedStem}.md`),
      `第${AMEND_CHAPTER}章修订正文。\n\n林岚发现缺页来自港务局的旧档案。\n`,
    )
    result = await run(dir, ['finalize', String(AMEND_CHAPTER), '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const amended = json<{
      projection: { replayBaseChapter: number | null; invalidFrom: number | null; status: string }
      impact: { items: Array<{ targetChapter: number }> }
    }>(result.stdout)
    assert.equal(amended.projection.status, 'current')
    assert.equal(amended.projection.invalidFrom, AMEND_CHAPTER)
    assert.ok(amended.projection.replayBaseChapter !== null)
    assert.ok((amended.projection.replayBaseChapter ?? 0) < AMEND_CHAPTER)
    assert.deepEqual(
      amended.impact.items.map(item => item.targetChapter),
      Array.from({ length: CHAPTERS - AMEND_CHAPTER }, (_, index) => AMEND_CHAPTER + index + 1),
    )

    result = await run(dir, ['resolve-impact', String(AMEND_CHAPTER), '--all', '--decision', 'accept', '--json'])
    assert.equal(result.code, 0, result.stderr)
    result = await run(dir, ['doctor', '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)

    result = await run(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const exportPath = path.join(dir, 'exports', 'book-merged.md')
    const before = await readFile(exportPath, 'utf8')
    assert.equal((before.match(/^## 第\d+章/gm) ?? []).length, CHAPTERS)

    result = await run(dir, ['rebuild', '--json'])
    assert.equal(result.code, 0, result.stderr)
    result = await run(dir, ['export', '--format', 'merged', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const after = await readFile(exportPath, 'utf8')
    assert.equal(after, before)

    const elapsed = Date.now() - startedAt
    console.log(JSON.stringify({
      ok: true,
      chapters: CHAPTERS,
      commitCount: CHAPTERS + 1,
      amendChapter: AMEND_CHAPTER,
      replayBaseChapter: amended.projection.replayBaseChapter,
      impactTargets: amended.impact.items.length,
      exportBytes: Buffer.byteLength(before),
      elapsedMs: elapsed,
    }, null, 2))
  } catch (error) {
    kept = process.env.WEAVE_KEEP_ACCEPTANCE === '1'
    console.error(error)
    console.error(`acceptance project: ${dir}${kept ? '' : ' (cleaned)'}`)
    process.exitCode = 1
    if (kept) return
  } finally {
    if (!kept) await rm(dir, { recursive: true, force: true })
  }
}

await main()
