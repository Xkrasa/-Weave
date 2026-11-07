import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeContract } from '../src/core/contract.ts'
import { assembleContext } from '../src/core/context.ts'
import { hashText } from '../src/core/hash.ts'
import { initProject, loadModelConfig } from '../src/core/project.ts'
import {
  calibrationDeviation,
  calibrationPath,
  calibrationWarning,
  effectiveCharsPerToken,
  loadTokenCalibration,
  recordTokenObservation,
} from '../src/core/token-calibration.ts'
import type { ChapterContract, Material } from '../src/core/types.ts'

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts')

async function project(name: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `weave-calibration-${name}-`))
  await initProject(dir, { title: '校准', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
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

function contract(): ChapterContract {
  return normalizeContract({
    chapter: 1,
    title: '退单',
    pov: '许舟',
    time: '午高峰',
    location: '站点',
    openingState: '许舟收到罚单',
    endingState: '罚单被撤销',
    goal: '撤销错误罚单',
    obstacle: '平台记录不一致',
    mustHappen: [],
    mayHappen: [],
    mustNotHappen: [],
    characters: ['许舟'],
    threads: [],
    targetWords: 1000,
    previousLink: '开篇',
    nextLink: '继续',
  })
}

function material(sourceId: string, text: string, required = false): Material {
  return {
    sourceId,
    label: sourceId,
    category: 'author',
    provenance: 'author',
    text,
    required,
    contentHash: hashText(text),
    visibility: 'project',
    purpose: '校准测试',
  }
}

test('calibration keeps an EWMA of provider-reported chars per token', async () => {
  const { dir, cleanup } = await project('ewma')
  try {
    const config = await loadModelConfig(dir)
    assert.equal(await loadTokenCalibration(dir), null)
    assert.equal(effectiveCharsPerToken(config, null), config.charsPerToken)

    assert.equal(await recordTokenObservation(dir, 0, 10, config.charsPerToken), null)
    assert.equal(await recordTokenObservation(dir, 1000, undefined, config.charsPerToken), null)
    assert.equal(await recordTokenObservation(dir, 1000, 0, config.charsPerToken), null)

    const first = await recordTokenObservation(dir, 1000, 800, config.charsPerToken)
    assert.equal(first?.observedCharsPerToken, 1.25)
    assert.equal(first?.samples, 1)
    assert.equal(first?.last.estimatedTokens, Math.ceil(1000 / config.charsPerToken))

    const second = await recordTokenObservation(dir, 1000, 500, config.charsPerToken)
    // 1.25 * 0.7 + 2 * 0.3
    assert.equal(second?.observedCharsPerToken, 1.475)
    assert.equal(second?.samples, 2)
    assert.equal(effectiveCharsPerToken(config, second), 1.475)

    const stored = await loadTokenCalibration(dir)
    assert.deepEqual(stored, second)
  } finally {
    await cleanup()
  }
})

test('the conservative ratio wins and the estimate shrinks the budget', async () => {
  const { dir, cleanup } = await project('estimate')
  try {
    const config = await loadModelConfig(dir)
    const assembly = assembleContext(contract(), [material('m1', '林岚'.repeat(2000))], config, {
      charsPerToken: 1,
    })
    assert.equal(assembly.context?.charsPerToken, 1)
    assert.equal(assembly.context?.promptChars, [...assembly.context!.system].length + [...assembly.context!.user].length)

    const generous = assembleContext(contract(), [material('m1', '林岚'.repeat(2000))], config)
    assert.equal(generous.context?.charsPerToken, config.charsPerToken)
    assert.ok(assembly.context!.estimatedTokens > generous.context!.estimatedTokens)
  } finally {
    await cleanup()
  }
})

test('doctor reports the estimate deviation and warns past 20%', async () => {
  const { dir, cleanup } = await project('doctor')
  try {
    const config = await loadModelConfig(dir)
    await writeFile(calibrationPath(dir), `${JSON.stringify({
      schemaVersion: 1,
      observedCharsPerToken: 1.1,
      samples: 3,
      updatedAt: new Date().toISOString(),
      last: { promptChars: 1000, estimatedTokens: 300, promptTokens: 900 },
    }, null, 2)}\n`)

    const calibration = await loadTokenCalibration(dir)
    const report = calibrationDeviation(config, calibration)!
    assert.equal(report.deviation, -0.6667)
    assert.match(calibrationWarning(report)!, /估算少估 67%/)

    const doctor = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr)
    const payload = JSON.parse(doctor.stdout) as {
      calibration?: { deviation: number; samples: number }
      warnings: string[]
    }
    assert.equal(payload.calibration?.samples, 3)
    assert.equal(payload.calibration?.deviation, -0.6667)
    assert.ok(payload.warnings.some(warning => warning.includes('token 估算')))

    const text = await runCli(dir, ['doctor'])
    assert.equal(text.code, 0, text.stdout + text.stderr)
    assert.match(text.stdout, /token 校准/)
    assert.match(text.stdout, /偏差 -67%/)
  } finally {
    await cleanup()
  }
})

test('a deviation inside 20% does not warn', async () => {
  const { dir, cleanup } = await project('quiet')
  try {
    const config = await loadModelConfig(dir)
    await writeFile(calibrationPath(dir), `${JSON.stringify({
      schemaVersion: 1,
      observedCharsPerToken: 1.5,
      samples: 1,
      updatedAt: new Date().toISOString(),
      last: { promptChars: 1000, estimatedTokens: 640, promptTokens: 620 },
    }, null, 2)}\n`)
    const report = calibrationDeviation(config, await loadTokenCalibration(dir))!
    assert.equal(Math.abs(report.deviation) <= 0.2, true)
    assert.equal(calibrationWarning(report), null)

    const doctor = await runCli(dir, ['doctor', '--json'])
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr)
    const payload = JSON.parse(doctor.stdout) as { warnings: string[] }
    assert.equal(payload.warnings.some(warning => warning.includes('token 估算')), false)
  } finally {
    await cleanup()
  }
})
