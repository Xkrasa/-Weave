import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assembleContext } from '../src/core/context.ts'
import { effectiveContextWindow, migrateModelConfig, updateModelConfig, validateModelConfig } from '../src/core/config.ts'
import { normalizeContract } from '../src/core/contract.ts'
import { hashText } from '../src/core/hash.ts'
import { initProject, loadModelConfig, projectPaths } from '../src/core/project.ts'
import type { Material, ModelConfig } from '../src/core/types.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'weave-config-'))
}

async function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

const contract = normalizeContract({
  chapter: 1,
  title: '退单',
  pov: '许舟',
  time: '23:50',
  location: '唐姨家门口',
  openingState: '许舟送出药品',
  endingState: '罚单被撤销',
  goal: '证明按时送达',
  obstacle: '平台时间线异常',
  mustHappen: ['许舟核对退款操作'],
  mayHappen: [],
  mustNotHappen: [],
  characters: ['许舟'],
  threads: ['异常退款'],
  targetWords: 1800,
  previousLink: '开篇',
  nextLink: '追查其他退单',
})

function material(overrides: Partial<Material> & { sourceId: string; text: string }): Material {
  return {
    category: 'author',
    provenance: 'author',
    required: false,
    label: overrides.sourceId,
    contentHash: hashText(overrides.text),
    visibility: 'project',
    purpose: 'test',
    ...overrides,
  }
}

const baseConfig: ModelConfig = {
  model: 'fake',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindow: 1_000_000,
  maxOutputTokens: 1000,
  safetyMarginTokens: 512,
  charsPerToken: 1.6,
  temperature: 0.7,
  timeoutMs: 1000,
  snapshotEvery: 1,
  promptRenderer: 'mission',
}

test('new projects default to a one-million window with a soft writing budget', async () => {
  const dir = await tempDir()
  try {
    await initProject(dir, { title: '预算', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
    const config = await loadModelConfig(dir)
    assert.equal(config.contextWindow, 1_000_000)
    assert.equal(config.maxOutputTokens, 8192)
    assert.equal(config.contextBudgetTokens, 120_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('soft budget caps assembly even when the model window is larger', () => {
  const premise = material({ sourceId: 'canon:premise.md', text: '前提一句话。', required: true })
  const arcs = material({
    sourceId: 'plan:character-arcs',
    text: '人物弧。'.repeat(5000),
    priority: 5,
    compact: '人物弧（本章未展开）：许舟',
  })
  const tight = assembleContext(contract, [premise, arcs], { ...baseConfig, contextBudgetTokens: 8000 })
  assert.equal(tight.decision.decision, 'ready')
  assert.equal(tight.decision.effectiveWindow, 8000)
  assert.ok(tight.decision.capacityTokens < 8000)
  assert.deepEqual(tight.context!.degraded, [{ sourceId: 'plan:character-arcs', reason: 'budget' }])
  assert.equal(tight.context!.included.find(item => item.sourceId === 'plan:character-arcs')!.text, '人物弧（本章未展开）：许舟')

  const roomy = assembleContext(contract, [premise, arcs], { ...baseConfig })
  assert.equal(roomy.decision.decision, 'ready')
  assert.equal(roomy.decision.effectiveWindow, 1_000_000)
  assert.deepEqual(roomy.context!.degraded, [])
  assert.ok(roomy.context!.included.find(item => item.sourceId === 'plan:character-arcs')!.text.includes('人物弧。'))
})

test('old configs without a soft budget keep using the model window', () => {
  const config: ModelConfig = { ...baseConfig, contextWindow: 32768 }
  delete (config as { contextBudgetTokens?: number }).contextBudgetTokens
  assert.equal(effectiveContextWindow(config), 32768)
  assert.equal(effectiveContextWindow({ ...config, contextBudgetTokens: 20_000 }), 20_000)
})

test('config updates validate before writing and never partially apply', async () => {
  const dir = await tempDir()
  try {
    await initProject(dir, { title: '预算', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
    const before = await loadModelConfig(dir)
    await updateModelConfig(dir, { contextBudgetTokens: 160_000, maxOutputTokens: 12_000 })
    const after = await loadModelConfig(dir)
    assert.equal(after.contextBudgetTokens, 160_000)
    assert.equal(after.maxOutputTokens, 12_000)

    await assert.rejects(
      updateModelConfig(dir, { maxOutputTokens: 2_000_000 }),
      /输出预留/,
    )
    const unchanged = await loadModelConfig(dir)
    assert.deepEqual(unchanged, after)

    await assert.rejects(
      updateModelConfig(dir, { charsPerToken: 0 }),
      /charsPerToken/,
    )
    assert.deepEqual(await loadModelConfig(dir), after)
    assert.deepEqual(validateModelConfig(before), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit migration only fills the missing soft budget', async () => {
  const dir = await tempDir()
  try {
    await initProject(dir, { title: '预算', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
    const configPath = projectPaths(dir).modelConfig
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    delete config.contextBudgetTokens
    config.contextWindow = 32768
    config.maxOutputTokens = 4096
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = await migrateModelConfig(dir)
    assert.deepEqual(result.changed, ['contextBudgetTokens'])
    const migrated = await loadModelConfig(dir)
    assert.equal(migrated.contextBudgetTokens, 32768)
    assert.equal(migrated.contextWindow, 32768)
    assert.equal(migrated.maxOutputTokens, 4096)

    const again = await migrateModelConfig(dir)
    assert.deepEqual(again.changed, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('weave config show and set expose and validate the soft budget', async () => {
  const dir = await tempDir()
  try {
    const init = await runCli(dir, [
      'init', '.', '--title', '预算', '--model', 'fake', '--base-url', 'http://127.0.0.1:1/v1',
      '--context-budget', '64000',
    ])
    assert.equal(init.code, 0, init.stderr)

    const shown = await runCli(dir, ['config', 'show', '--json'])
    assert.equal(shown.code, 0, shown.stderr)
    const payload = JSON.parse(shown.stdout) as {
      config: { contextWindow: number; contextBudgetTokens: number; maxOutputTokens: number }
      budget: { effectiveWindow: number; capacityTokens: number }
    }
    assert.equal(payload.config.contextWindow, 1_000_000)
    assert.equal(payload.config.contextBudgetTokens, 64_000)
    assert.equal(payload.budget.effectiveWindow, 64_000)
    assert.ok(payload.budget.capacityTokens < 64_000)

    const set = await runCli(dir, ['config', 'set', '--context-budget', '96000', '--max-output', '4096'])
    assert.equal(set.code, 0, set.stderr)
    const updated = await loadModelConfig(dir)
    assert.equal(updated.contextBudgetTokens, 96_000)
    assert.equal(updated.maxOutputTokens, 4096)

    const bad = await runCli(dir, ['config', 'set', '--max-output', '2000000'])
    assert.notEqual(bad.code, 0)
    assert.match(bad.stderr, /输出预留/)
    assert.equal((await loadModelConfig(dir)).maxOutputTokens, 4096)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
