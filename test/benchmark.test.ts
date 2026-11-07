import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'benchmark.ts')

interface Result { code: number; stdout: string; stderr: string }

function run(args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
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

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'weave-bench-'))
}

test('benchmark repeats each configuration three times by default and reports medians', async () => {
  const out = await tempDir()
  try {
    const result = await run(['run', '--suite', 'segmented-rollout', '--seed', 'segmented-rollout-s', '--out', out])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const consolePayload = JSON.parse(result.stdout.trim()) as { repeats: number; seeds: number; chapters: number }
    assert.equal(consolePayload.repeats, 3)
    assert.equal(consolePayload.seeds, 1)
    assert.equal(consolePayload.chapters, 1)

    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      repeats: number
      totals: { seeds: number; chapters: number }
      seeds: Array<{ seed: string; chapters: number }>
    }
    assert.equal(report.repeats, 3)
    // Medians stay per configuration: three repeats are not three extra chapters.
    assert.equal(report.totals.seeds, 1)
    assert.equal(report.totals.chapters, 1)
    assert.equal(report.seeds.length, 1)
    assert.equal(report.seeds[0]?.seed, 'segmented-rollout-s')

    for (const repeat of ['repeat-2', 'repeat-3']) {
      const single = JSON.parse(await readFile(path.join(out, repeat, 'report.json'), 'utf8')) as { repeats: number }
      assert.equal(single.repeats, 1)
      assert.ok((await readFile(path.join(out, repeat, 'report.md'), 'utf8')).length > 0)
    }
    const markdown = await readFile(path.join(out, 'report.md'), 'utf8')
    assert.match(markdown, /repeats: 3（数值为中位数）/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('benchmark fake mode records craft and longitudinal runs without a real model', async () => {
  const out = await tempDir()
  try {
    const craft = await run(['run', '--suite', 'craft', '--seed', 'harbor-ledger', '--repeat', '1', '--out', out])
    assert.equal(craft.code, 0, craft.stderr)
    const craftPayload = JSON.parse(craft.stdout.trim()) as { ok: boolean; mode: string; chapters: number }
    assert.equal(craftPayload.ok, true)
    assert.equal(craftPayload.mode, 'fake')
    assert.equal(craftPayload.chapters, 4)

    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      ok: boolean
      mode: string
      note: string
      totals: { seeds: number; chapters: number }
      seeds: Array<{ seed: string; estimatedTokens: number; characters: number }>
    }
    assert.equal(report.ok, true)
    assert.equal(report.mode, 'fake')
    assert.match(report.note, /plumbing only/)
    assert.equal(report.totals.chapters, 4)
    assert.equal(report.seeds[0]?.seed, 'harbor-ledger')
    assert.ok((report.seeds[0]?.characters ?? 0) > 0)
    assert.ok((report.seeds[0]?.estimatedTokens ?? 0) > 0)

    const runFile = JSON.parse(await readFile(path.join(out, 'harbor-ledger.run.json'), 'utf8')) as {
      chapters: Array<{ included?: string[]; exitCode: number; omitted?: unknown[] }>
    }
    assert.ok(runFile.chapters.every(chapter => chapter.exitCode === 0))
    assert.ok(runFile.chapters.every(chapter => Array.isArray(chapter.included)))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('benchmark longitudinal mode synthesizes prior chapters, then measures continuations', async () => {
  const out = await tempDir()
  try {
    const result = await run(['run', '--suite', 'longitudinal', '--seed', 'long-harbor', '--repeat', '1', '--out', out])
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      ok: boolean
      totals: { chapters: number }
      recall: { expectations: number; matchedTerms: number; missedTerms: number }
    }
    assert.equal(report.ok, true)
    assert.equal(report.totals.chapters, 3)
    // Recall is measured against the seed's expectations, not inferred from the prose.
    assert.equal(report.recall.expectations, 3)
    assert.ok(report.recall.matchedTerms > 0, 'retrieval must reach at least one expected prior chapter')
    assert.ok(report.recall.matchedTerms + report.recall.missedTerms > 0)

    const mainline = await readFile(path.join(out, 'long-harbor', 'ledger', 'mainline.jsonl'), 'utf8')
    const lines = mainline.split(/\r?\n/).filter(Boolean)
    const head = JSON.parse(lines[lines.length - 1]!) as { mainlineRevision: number }
    assert.equal(head.mainlineRevision, 33)
    const finals = await readdir(path.join(out, 'long-harbor', 'chapters', 'final'))
    assert.equal(finals.filter(name => name.endsWith('.md')).length, 33)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('benchmark pairs anonymizes order and score recovers the configured winner', async () => {
  const root = await tempDir()
  try {
    const a = path.join(root, 'run-a')
    const b = path.join(root, 'run-b')
    const first = await run(['run', '--suite', 'craft', '--seed', 'harbor-ledger', '--repeat', '1', '--out', a])
    assert.equal(first.code, 0, first.stderr)
    const second = await run(['run', '--suite', 'craft', '--seed', 'harbor-ledger', '--repeat', '1', '--out', b])
    assert.equal(second.code, 0, second.stderr)

    const pairsDir = path.join(root, 'pairs')
    const pairs = await run(['pairs', '--a', a, '--b', b, '--out', pairsDir])
    assert.equal(pairs.code, 0, pairs.stderr)
    const built = JSON.parse(pairs.stdout.trim()) as { pairs: number }
    assert.equal(built.pairs, 4)
    const pairPayload = JSON.parse(await readFile(path.join(pairsDir, 'pairs.json'), 'utf8')) as Array<{
      left: string
      right: string
    }>
    assert.ok(pairPayload.every(pair => pair.left.trim().length > 0 && pair.right.trim().length > 0),
      'pairs must carry final prose, not empty strings')

    const pairFile = path.join(pairsDir, 'pairs.json')
    const mapping = JSON.parse(await readFile(path.join(pairsDir, 'mapping.json'), 'utf8')) as {
      entries: Array<{ pairId: string; left: string; right: string }>
    }
    const scores = mapping.entries.map(entry => JSON.stringify({ pairId: entry.pairId, winner: 'left' })).join('\n')
    const scoresFile = path.join(root, 'scores.jsonl')
    await writeFile(scoresFile, `${scores}\n`)

    const scored = await run(['score', '--pairs', pairFile, '--scores', scoresFile])
    assert.equal(scored.code, 0, scored.stderr)
    const result = JSON.parse(scored.stdout.trim()) as {
      winRateA: number | null
      wins: { a: number; b: number; tie: number }
    }
    assert.equal(result.wins.tie, 0)
    assert.equal(result.wins.a + result.wins.b, 4)
    assert.ok(result.winRateA !== null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('benchmark records Fanqie evaluation metadata without turning holdout into a score', async () => {
  const out = await tempDir()
  try {
    const result = await run(['run', '--suite', 'craft', '--seed', 'fanqie-rewind-ten-minutes', '--max-output', '4096', '--repeat', '1', '--out', out])
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      seeds: Array<{
        seed: string
        platform?: string
        evaluation?: { focus: string[]; materialPolicy: string; holdout: boolean }
      }>
    }
    assert.equal(report.seeds[0]?.seed, 'fanqie-rewind-ten-minutes')
    assert.equal(report.seeds[0]?.platform, 'fanqie')
    assert.equal(report.seeds[0]?.evaluation?.holdout, true)
    assert.ok(report.seeds[0]?.evaluation?.focus.some(item => item.includes('对方反应')))
    assert.match(report.seeds[0]?.evaluation?.materialPolicy ?? '', /不注入任何参考作品原文/)

    const runFile = JSON.parse(await readFile(path.join(out, 'fanqie-rewind-ten-minutes.run.json'), 'utf8')) as {
      platform?: string
      evaluation?: { holdout: boolean }
    }
    assert.equal(runFile.platform, 'fanqie')
    assert.equal(runFile.evaluation?.holdout, true)
    assert.equal('winRateA' in report, false)
    const modelConfig = JSON.parse(await readFile(path.join(out, 'fanqie-rewind-ten-minutes', '.weave', 'config.json'), 'utf8')) as { maxOutputTokens: number }
    assert.equal(modelConfig.maxOutputTokens, 4096)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('benchmark readerIntent ablation removes only the optional intent', async () => {
  const root = await tempDir()
  try {
    const baselineDir = path.join(root, 'baseline')
    const ablatedDir = path.join(root, 'ablated')
    const baseline = await run(['run', '--suite', 'craft', '--seed', 'fanqie-rewind-ten-minutes', '--repeat', '1', '--out', baselineDir])
    assert.equal(baseline.code, 0, baseline.stderr)
    const ablated = await run([
      'run', '--suite', 'craft', '--seed', 'fanqie-rewind-ten-minutes', '--repeat', '1',
      '--ablation.readerIntent=off', '--out', ablatedDir,
    ])
    assert.equal(ablated.code, 0, ablated.stderr)

    const baselineContract = JSON.parse(await readFile(path.join(baselineDir, 'fanqie-rewind-ten-minutes', 'outlines', 'chapters', '001.json'), 'utf8')) as Record<string, unknown>
    const ablatedContract = JSON.parse(await readFile(path.join(ablatedDir, 'fanqie-rewind-ten-minutes', 'outlines', 'chapters', '001.json'), 'utf8')) as Record<string, unknown>
    assert.equal(baselineContract.readerIntent !== undefined, true)
    assert.equal('readerIntent' in ablatedContract, false)
    const { readerIntent: _ignored, ...baselineRemainder } = baselineContract
    assert.deepEqual(ablatedContract, baselineRemainder)

    const runFile = JSON.parse(await readFile(path.join(ablatedDir, 'fanqie-rewind-ten-minutes.run.json'), 'utf8')) as {
      ablations: Record<string, string>
    }
    assert.equal(runFile.ablations.readerIntent, 'off')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('benchmark beat-first uses unapproved generated fixtures and one prose run', async () => {
  const out = await tempDir()
  try {
    const result = await run([
      'run', '--suite', 'craft', '--seed', 'fanqie-rewind-ten-minutes',
      '--strategy', 'beat-first', '--repeat', '1', '--out', out,
    ])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const candidate = JSON.parse(await readFile(path.join(out, 'fanqie-rewind-ten-minutes', 'plans', 'beats', '001.json'), 'utf8')) as {
      status: string
      approvedBy?: string
    }
    assert.equal(candidate.status, 'draft')
    assert.equal(candidate.approvedBy, undefined)

    const runsDir = path.join(out, 'fanqie-rewind-ten-minutes', '.weave', 'runs')
    const runs = await Promise.all((await readdir(runsDir)).map(async name =>
      JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as { task: string; draftingStrategy?: string }))
    assert.equal(runs.filter(run => run.task === 'planning').length, 4)
    assert.equal(runs.filter(run => run.task === 'writing' && run.draftingStrategy === 'beat-first').length, 4)
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as { draftingStrategy?: string }
    assert.equal(report.draftingStrategy, 'beat-first')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('benchmark authorSamples supports independent scene, legacy and off ablations', async () => {
  const root = await tempDir()
  try {
    async function runStrategy(strategy: string): Promise<{ sampleId: string | null; included: string[] }> {
      const dir = path.join(root, strategy)
      const result = await run([
        'run', '--suite', 'craft', '--seed', 'fanqie-rewind-ten-minutes', '--repeat', '1',
        '--ablation.authorSamples', strategy, '--out', dir,
      ])
      assert.equal(result.code, 0, result.stdout + result.stderr)
      const runsDir = path.join(dir, 'fanqie-rewind-ten-minutes', '.weave', 'runs')
      const runs = await Promise.all((await readdir(runsDir)).map(async name =>
        JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as {
          task: string
          sampleSelection?: { samples: Array<{ id: string }> }
        }))
      const writing = runs.find(run => run.task === 'writing')
      const runFile = JSON.parse(await readFile(path.join(dir, 'fanqie-rewind-ten-minutes.run.json'), 'utf8')) as {
        chapters: Array<{ included?: string[] }>
      }
      return {
        sampleId: writing?.sampleSelection?.samples[0]?.id ?? null,
        included: runFile.chapters[0]?.included ?? [],
      }
    }

    const scene = await runStrategy('scene')
    assert.equal(scene.sampleId, 'b-release')
    const legacy = await runStrategy('legacy')
    assert.equal(legacy.sampleId, 'a-daily')
    const off = await runStrategy('off')
    assert.equal(off.sampleId, null)
    assert.equal(off.included.includes('style:author-samples'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
