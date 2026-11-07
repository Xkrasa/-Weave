import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  inspectExternalComponents,
  loadDeslopManifest,
  runExternalDeslop,
} from '../src/core/external-components.ts'
import { loadExpressionLintConfig } from '../src/core/expression-lint.ts'
import { initProject } from '../src/core/project.ts'

const FIXTURE_ROOT = path.resolve('test/fixtures/oh-story')
const CLI = path.resolve('src/cli.ts')

function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

function json<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, stdout)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

test('isolated story-deslop emits scoped soft findings without modifying fixture or native config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-external-deslop-'))
  try {
    const input = path.join(dir, 'chapter.md')
    await writeFile(input, '不是账本缺页，而是有人换掉了它。\n\n“不是我不去，而是路太远。”林岚解释。')
    const result = await runExternalDeslop(FIXTURE_ROOT, input)
    assert.equal(result.manifest.commit, 'aa0f874362504c715b8efaec7938df87e70a4742')
    assert.equal(result.manifest.license, 'MIT')
    assert.equal(result.manifest.permissions.network, false)
    assert.equal(result.manifest.permissions.model, false)
    assert.equal(result.manifest.permissions.writes.length, 0)
    assert.equal(result.fixtureHashBefore, result.fixtureHashAfter)

    const finding = result.findings.find(item => item.ruleId === 'not-is-comparison')
    assert.ok(finding)
    assert.equal(finding.severity, 'warning')
    assert.equal(finding.upstreamSeverity, 'blocking')
    assert.equal(finding.source, 'external')
    assert.ok(finding.quote.includes('不是账本缺页'))
    assert.equal(result.findings.some(item => item.quote.includes('不是我不去')), false)
    assert.equal(finding.evidence.line, 1)

    const disabled = await runExternalDeslop(FIXTURE_ROOT, input, { disabled: true })
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.findings.length, 0)

    await initProject(dir, { title: '原生规则不受影响', model: 'fake', baseUrl: 'http://127.0.0.1:1/v1', workflowVersion: 2 })
    const native = await loadExpressionLintConfig(dir)
    assert.ok(native.rules.some(rule => rule.id === 'not-is-comparison'))
    assert.equal(native.rules.some(rule => rule.id.startsWith('external')), false)

    const candidates = await inspectExternalComponents(FIXTURE_ROOT)
    assert.equal(candidates.find(candidate => candidate.component === 'story-deslop')?.present, true)
    assert.equal(candidates.find(candidate => candidate.component === 'story-long-scan')?.permissions.browser, true)
    assert.equal(candidates.find(candidate => candidate.component === 'story-review')?.present, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('component manifest rejects changed upstream content hashes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-external-hash-'))
  try {
    await mkdir(path.join(dir, 'scripts'), { recursive: true })
    await writeFile(path.join(dir, 'check-ai-patterns.js'), await readFile(path.join(FIXTURE_ROOT, 'check-ai-patterns.js'), 'utf8'))
    await writeFile(path.join(dir, 'style-whitelist.js'), await readFile(path.join(FIXTURE_ROOT, 'style-whitelist.js'), 'utf8'))
    await writeFile(path.join(dir, 'UPSTREAM.md'), await readFile(path.join(FIXTURE_ROOT, 'UPSTREAM.md'), 'utf8'))
    await writeFile(path.join(dir, 'style-whitelist.js'), "'use strict';\nmodule.exports = { changed: true };\n")
    await assert.rejects(loadDeslopManifest(dir), /内容哈希/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('external CLI inspects components and runs test-deslop with an independent component root', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-external-cli-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '外部组件 CLI', '--model', 'fake', '--base-url', 'http://127.0.0.1:1/v1', '--workflow', 'p0'])).code, 0)
    const missingRoot = await runCli(dir, ['external', 'inspect', '--json'])
    assert.equal(missingRoot.code, 2)
    assert.match(missingRoot.stdout, /缺少 --component-root/)
    const inspected = await runCli(dir, ['external', 'inspect', '--component-root', FIXTURE_ROOT, '--json'])
    assert.equal(inspected.code, 0, inspected.stdout + inspected.stderr)
    assert.equal(json<{ candidates: Array<{ component: string; present: boolean }> }>(inspected.stdout).candidates.find(item => item.component === 'story-deslop')?.present, true)

    const input = path.join(dir, 'chapter.md')
    await writeFile(input, '不是账本缺页，而是有人换掉了它。')
    const tested = await runCli(dir, ['external', 'test-deslop', input, '--component-root', FIXTURE_ROOT, '--json'])
    assert.equal(tested.code, 0, tested.stdout + tested.stderr)
    const result = json<{ status: string; findings: Array<{ severity: string; upstreamSeverity: string }>; fixtureHashBefore: string; fixtureHashAfter: string }>(tested.stdout)
    assert.equal(result.status, 'draft')
    assert.equal(result.findings[0]?.severity, 'warning')
    assert.equal(result.findings[0]?.upstreamSeverity, 'blocking')
    assert.equal(result.fixtureHashBefore, result.fixtureHashAfter)

    const disabled = await runCli(dir, ['external', 'test-deslop', input, '--component-root', FIXTURE_ROOT, '--disabled', '--json'])
    assert.equal(json<{ status: string; findings: unknown[] }>(disabled.stdout).status, 'disabled')
    assert.equal(json<{ findings: unknown[] }>(disabled.stdout).findings.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
