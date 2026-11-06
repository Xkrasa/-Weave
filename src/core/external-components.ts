import path from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileHash, readTextIfExists } from './io.ts'
import { validationError } from './errors.ts'

const OH_STORY_COMMIT = 'aa0f874362504c715b8efaec7938df87e70a4742'
const execFileAsync = promisify(execFile)

export interface ExternalComponentManifest {
  component: 'story-deslop'
  kind: 'lint'
  repository: string
  commit: string
  license: 'MIT'
  contentHashes: Record<string, string>
  permissions: {
    subprocess: boolean
    network: boolean
    model: boolean
    browser: boolean
    writes: string[]
  }
  status: 'draft'
}

export interface ExternalFinding {
  dimension: '表达模板'
  severity: 'warning' | 'info'
  description: string
  quote: string
  ruleId: string
  ruleVersion: 1
  source: 'external'
  upstreamSeverity: string
  review?: string
  evidence: { file: string; line: number; column: number; quote: string }
}

export interface ExternalDeslopResult {
  manifest: ExternalComponentManifest
  status: 'draft' | 'disabled'
  findings: ExternalFinding[]
  fixtureHashBefore: string
  fixtureHashAfter: string
}

export async function loadDeslopManifest(root: string): Promise<ExternalComponentManifest> {
  const script = await deslopScript(root)
  const metadata = await readTextIfExists(path.join(root, 'UPSTREAM.md'))
  let commit = ''
  if (metadata) {
    commit = /^Commit:\s*([a-f0-9]{40})$/m.exec(metadata)?.[1] ?? ''
    if (!commit) throw validationError('UPSTREAM.md 缺少固定 commit')
    if (!/License:\s*MIT\b/.test(metadata)) throw validationError('UPSTREAM.md 未声明 MIT 许可证')
    for (const name of ['check-ai-patterns.js', 'style-whitelist.js'] as const) {
      const expected = new RegExp(`${name}: sha256:([A-F0-9]{64})`, 'i').exec(metadata)?.[1]
      const actual = (await fileHash(await scriptFor(root, name))).replace(/^sha256:/, '').toUpperCase()
      if (!expected || expected.toUpperCase() !== actual) {
        throw validationError(`${name} 的内容哈希与 UPSTREAM.md 不一致`)
      }
    }
  } else {
    commit = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    const license = await readTextIfExists(path.join(root, 'LICENSE'))
    if (!license?.includes('MIT License')) throw validationError('上游组件缺少 MIT LICENSE')
  }
  if (commit !== OH_STORY_COMMIT) throw validationError(`外部组件 commit 不匹配：${commit || '未知'}`)
  return {
    component: 'story-deslop',
    kind: 'lint',
    repository: 'https://github.com/zenstory-ai/oh-story-claudecode',
    commit,
    license: 'MIT',
    contentHashes: {
      'check-ai-patterns.js': await fileHash(await scriptFor(root, 'check-ai-patterns.js')),
      'style-whitelist.js': await fileHash(await scriptFor(root, 'style-whitelist.js')),
    },
    permissions: { subprocess: true, network: false, model: false, browser: false, writes: [] },
    status: 'draft',
  }
}

export async function runExternalDeslop(root: string, input: string, options: { disabled?: boolean } = {}): Promise<ExternalDeslopResult> {
  const manifest = await loadDeslopManifest(root)
  const fixtureHashBefore = await fileHash(input)
  if (options.disabled) {
    return { manifest, status: 'disabled', findings: [], fixtureHashBefore, fixtureHashAfter: fixtureHashBefore }
  }
  const script = await deslopScript(root)
  const result = await runNode(script, ['--check', '--json', '--fail-on=blocking', path.resolve(input)])
  if (result.code === 2 || (!result.stdout.trim() && result.code !== 0)) {
    throw validationError(`外部去味脚本执行失败：${result.stderr || '没有返回 JSON'}`)
  }
  let payload: { findings?: Array<Record<string, unknown>> }
  try {
    payload = JSON.parse(result.stdout) as { findings?: Array<Record<string, unknown>> }
  } catch {
    throw validationError(`外部去味脚本没有返回可解析 JSON：${result.stdout.slice(0, 200)}`)
  }
  const findings: ExternalFinding[] = (payload.findings ?? []).map(item => {
    const type = String(item.type ?? 'unknown')
    const excerpt = String(item.excerpt ?? '')
    const upstreamSeverity = String(item.severity ?? 'advisory')
    return {
      dimension: '表达模板',
      severity: upstreamSeverity === 'blocking' ? 'warning' : 'info',
      description: `外部 story-deslop/${type}：${String(item.message ?? '需要人工复核')}`,
      quote: excerpt,
      ruleId: type,
      ruleVersion: 1,
      source: 'external',
      upstreamSeverity,
      ...(typeof item.review === 'string' ? { review: item.review } : {}),
      evidence: {
        file: String(item.file ?? input),
        line: Number(item.line) || 1,
        column: Number(item.column) || 1,
        quote: excerpt,
      },
    }
  })
  return {
    manifest,
    status: 'draft',
    findings,
    fixtureHashBefore,
    fixtureHashAfter: await fileHash(input),
  }
}

export async function inspectExternalComponents(root: string): Promise<Array<{
  component: string
  kind: 'lint' | 'publish-profile' | 'hotspot-aggregator' | 'review-rubric'
  entry: string
  present: boolean
  permissions: { subprocess: boolean; network: boolean; model: boolean; browser: boolean; writes: string[] }
  decision: string
}>> {
  const candidates = [
    {
      component: 'story-deslop', kind: 'lint' as const,
      entry: 'skills/story-deslop/scripts/check-ai-patterns.js',
      permissions: { subprocess: true, network: false, model: false, browser: false, writes: [] },
      decision: '优先原生重写；脚本仅在隔离 fixture 中作为只读参考适配，不继承 blocking',
    },
    {
      component: 'story-publish', kind: 'publish-profile' as const,
      entry: 'skills/story-publish/scripts/check-publish-format.py',
      permissions: { subprocess: true, network: false, model: false, browser: false, writes: [] },
      decision: '仅借鉴声明式发布档案与格式契约，保留字段状态和人工后台核实',
    },
    {
      component: 'story-long-scan', kind: 'hotspot-aggregator' as const,
      entry: 'skills/story-long-scan/scripts/aggregate-rank.js',
      permissions: { subprocess: true, network: true, model: false, browser: true, writes: [] },
      decision: '原生重写离线聚合；CDP、登录态和实时抓取后置单独评审',
    },
    {
      component: 'story-review', kind: 'review-rubric' as const,
      entry: 'skills/story-review/references/rubrics/fanqie.md',
      permissions: { subprocess: false, network: false, model: true, browser: false, writes: [] },
      decision: '仅借鉴声明式软 rubric，不引入宿主多 Agent 或 S1/S2 阻断体系',
    },
  ]
  return Promise.all(candidates.map(async candidate => ({
    ...candidate,
    present: await exists(path.join(root, candidate.entry)) || (candidate.component === 'story-deslop' && await exists(path.join(root, 'check-ai-patterns.js'))),
  })))
}

async function deslopScript(root: string): Promise<string> {
  const direct = path.join(root, 'check-ai-patterns.js')
  if (await exists(direct)) return direct
  const nested = path.join(root, 'skills', 'story-deslop', 'scripts', 'check-ai-patterns.js')
  if (await exists(nested)) return nested
  throw validationError('缺少 story-deslop 的 check-ai-patterns.js 或必要依赖')
}

async function scriptFor(root: string, name: 'check-ai-patterns.js' | 'style-whitelist.js'): Promise<string> {
  const direct = path.join(root, name)
  if (await exists(direct)) return direct
  return path.join(root, 'skills', 'story-deslop', 'scripts', name)
}

async function exists(file: string): Promise<boolean> {
  return (await readTextIfExists(file)) !== null
}

function runNode(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.dirname(script),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? 2, stdout, stderr }))
  })
}
