import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadMethods } from '../src/core/methods.ts'

const CLI = path.resolve('src/cli.ts')
interface Result { code: number; stdout: string; stderr: string }
function runCli(cwd: string, args: string[]): Promise<Result> {
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

test('approved webnovel cards preserve platform, notFor, purpose routing and disable behavior', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-method-routing-'))
  try {
    assert.equal((await runCli(dir, ['init', '.', '--title', '方法路由', '--model', 'fake', '--base-url', 'http://127.0.0.1:1/v1', '--workflow', 'p0'])).code, 0)
    await writeFile(path.join(dir, 'canon', 'characters.json'), `${JSON.stringify({ characters: [{ name: '许舟', status: 'alive', introducedIn: 1 }] })}\n`)
    await writeFile(path.join(dir, 'outlines', 'chapters', '001.json'), `${JSON.stringify({
      chapter: 1,
      title: '退单',
      pov: '许舟',
      time: '午高峰',
      location: '站点',
      openingState: '许舟收到罚单',
      endingState: '罚单被撤销',
      goal: '撤销错误罚单',
      obstacle: '邱岳拒绝复核',
      mustHappen: ['许舟让邱岳撤回扣款'],
      mayHappen: [],
      mustNotHappen: [],
      characters: ['许舟'],
      threads: ['异常退款'],
      targetWords: 800,
      previousLink: '开篇',
      nextLink: '继续',
      readerIntent: { purpose: 'release', payoff: '读者看到邱岳主动撤回扣款' },
      sceneTypes: ['confrontation'],
    }, null, 2)}\n`)
    assert.equal((await runCli(dir, ['contract', 'check', '1', '--json'])).code, 0)

    const source = await readFile(path.resolve('methods/candidates/payoff-reaction.json'), 'utf8')
    await mkdir(path.join(dir, 'methods', 'candidates'), { recursive: true })
    await writeFile(path.join(dir, 'methods', 'candidates', 'payoff-reaction.json'), source)
    const before = json<{ modules: Array<{ id: string }> }>((await runCli(dir, ['method', 'list', '--json'])).stdout)
    assert.equal(before.modules.some(module => module.id === 'payoff-reaction'), false)
    assert.equal((await runCli(dir, ['method', 'approve', 'payoff-reaction', '--json'])).code, 0)

    const markdown = await readFile(path.join(dir, 'methods', 'payoff-reaction.md'), 'utf8')
    assert.ok(markdown.includes('platforms: long-form, fanqie'))
    assert.ok(markdown.includes('## Not For'))
    const approved = (await loadMethods(dir)).find(module => module.id === 'payoff-reaction')
    assert.deepEqual(approved?.platforms, ['long-form', 'fanqie'])
    assert.equal(approved?.notFor, 'tragedy-with-delayed-catharsis')

    const route = json<{ modules: Array<{ id: string; reason: string }> }>((await runCli(dir, ['method', 'route', '1', '--platform', 'fanqie', '--json'])).stdout)
    assert.equal(route.modules[0]?.id, 'payoff-reaction')
    assert.ok(route.modules[0]?.reason.includes('release'))
    assert.ok(route.modules[0]?.reason.includes('confrontation'))

    await writeFile(path.join(dir, 'methods', 'disabled.json'), `${JSON.stringify({ ids: ['payoff-reaction'] })}\n`)
    const disabled = json<{ modules: Array<{ id: string }> }>((await runCli(dir, ['method', 'route', '1', '--platform', 'fanqie', '--json'])).stdout)
    assert.equal(disabled.modules.some(module => module.id === 'payoff-reaction'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
