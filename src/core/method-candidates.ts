import path from 'node:path'
import type { ModelConfig } from './types.ts'
import type { DeconstructReport } from './deconstruct.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { atomicWrite, ensureDir, listFiles, readTextIfExists } from './io.ts'
import type { MethodModule } from './methods.ts'
import { conflictError, validationError } from './errors.ts'

export interface MethodCandidate {
  id: string
  status: 'draft' | 'approved'
  createdAt: string
  source: string
  method: MethodModule
}

export interface DeconstructAnalysis {
  summary: string
  scenes: Array<{
    chapter: number
    goal: string
    obstacle: string
    choice: string
    turn: string
    stateChange: string
    infoRelease: string
    endingQuestion: string
  }>
  patterns: string[]
  methods: MethodModule[]
}

const SCHEMA_PROMPT = [
  '你是中文网文的拆书分析器。只分析结构，不复制原文。',
  '只输出一个 JSON 对象，不要解释或 Markdown 围栏。',
  '每条结论必须能由给出的章节统计与少量摘录支持；不确定时留空。',
  '正反例必须是你自己重写的短句，不得使用参考作品原句。',
].join('\n')

/**
 * Turns structural statistics into scene-level reading and reusable method cards.
 * Excerpts stay short: analysis never needs the full reference text.
 */
export async function analyzeDeconstruction(
  root: string,
  report: DeconstructReport,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<DeconstructAnalysis> {
  const chapters = report.chapters.slice(0, 12).map(chapter => ({
    index: chapter.index,
    title: chapter.title,
    characters: chapter.characters,
    paragraphs: chapter.paragraphs,
    dialogueRatio: Number(chapter.dialogueRatio.toFixed(3)),
    structureTags: chapter.structureTags,
    sceneFunctions: chapter.sceneFunctions,
    suspensePositions: chapter.suspensePositions,
    openingExcerpt: chapter.openingExcerpt,
    endingExcerpt: chapter.endingExcerpt,
  }))
  const prompt = [
    '拆书统计与有限摘录：',
    JSON.stringify({ totals: report.totals, chapters }, null, 2),
    '',
    '请输出结构分析与可复用方法：',
    JSON.stringify({
      summary: '这部作品的章节结构判断',
      scenes: [{
        chapter: 1,
        goal: '场景目标',
        obstacle: '阻力',
        choice: '人物选择',
        turn: '转折',
        stateChange: '结束后改变了什么',
        infoRelease: '读者/角色分别何时获得什么信息',
        endingQuestion: '章末留下的具体问题',
      }],
      patterns: ['跨章重复出现的结构模式'],
      methods: [{
        id: 'method-slug',
        tags: ['结构', '章末'],
        scope: 'long-form chapter',
        signal: '什么信号下使用',
        diagnosis: '故障诊断',
        process: '可执行步骤',
        output: '交付要求',
        positive: '原创正例',
        negative: '原创反例',
        selfCheck: '自检清单',
      }],
    }, null, 2),
  ].join('\n')

  const taskConfig = resolveTaskConfig(config, 'planning')
  const result = await completeJsonObject({ config: taskConfig, system: SCHEMA_PROMPT, user: prompt, signal })
  await appendUsage(root, { task: 'planning', model: taskConfig.model, usage: result.usage })
  return normalizeAnalysis(result.raw)
}

function normalizeAnalysis(raw: Record<string, unknown>): DeconstructAnalysis {
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('拆书分析缺少 summary')
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(item => ({
      chapter: Number(item.chapter) || 0,
      goal: text(item.goal),
      obstacle: text(item.obstacle),
      choice: text(item.choice),
      turn: text(item.turn),
      stateChange: text(item.stateChange),
      infoRelease: text(item.infoRelease),
      endingQuestion: text(item.endingQuestion),
    }))
    .filter(item => item.chapter > 0)
  const patterns = (Array.isArray(raw.patterns) ? raw.patterns : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
  const methods = (Array.isArray(raw.methods) ? raw.methods : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item, index) => normalizeMethod(item, index))
    .filter((item): item is MethodModule => item !== null)
  return { summary, scenes, patterns, methods }
}

function normalizeMethod(raw: Record<string, unknown>, index: number): MethodModule | null {
  const id = typeof raw.id === 'string' && /^[a-z0-9-]+$/.test(raw.id) ? raw.id : `card-${index + 1}`
  const signal = text(raw.signal)
  const process = text(raw.process)
  if (!signal || !process) return null
  return {
    id,
    version: 1,
    tags: arrayOfStrings(raw.tags),
    scope: text(raw.scope) || 'long-form chapter',
    signal,
    diagnosis: text(raw.diagnosis),
    process,
    output: text(raw.output),
    positive: text(raw.positive),
    negative: text(raw.negative),
    selfCheck: text(raw.selfCheck),
  }
}

export function candidatesDir(root: string): string {
  return path.join(root, 'methods', 'candidates')
}

export async function saveMethodCandidates(
  root: string,
  methods: MethodModule[],
  source: string,
): Promise<MethodCandidate[]> {
  const dir = candidatesDir(root)
  await ensureDir(dir)
  const saved: MethodCandidate[] = []
  for (const method of methods) {
    const candidate: MethodCandidate = {
      id: method.id,
      status: 'draft',
      createdAt: new Date().toISOString(),
      source,
      method,
    }
    const file = path.join(dir, `${method.id}.json`)
    await atomicWrite(file, `${JSON.stringify(candidate, null, 2)}\n`)
    saved.push(candidate)
  }
  return saved
}

export async function listMethodCandidates(root: string): Promise<MethodCandidate[]> {
  const dir = candidatesDir(root)
  const candidates: MethodCandidate[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const text = await readTextIfExists(path.join(dir, name))
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as MethodCandidate
      if (parsed?.method?.id) candidates.push(parsed)
    } catch {
      // Ignore unreadable candidates rather than blocking the method library.
    }
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id))
}

/** Approval writes a normal `methods/*.md`, which the existing hot loader already understands. */
export async function approveMethodCandidate(root: string, id: string): Promise<string> {
  const candidate = (await listMethodCandidates(root)).find(item => item.id === id)
  if (!candidate) throw conflictError(`未找到方法卡候选：${id}`)
  if (!candidate.method.signal || !candidate.method.process) {
    throw validationError(`方法卡 ${id} 缺少 signal 或 process，不能批准`)
  }
  const target = path.join(root, 'methods', `${id}.md`)
  await ensureDir(path.dirname(target))
  await atomicWrite(target, methodMarkdown(candidate.method))
  await atomicWrite(
    path.join(candidatesDir(root), `${id}.json`),
    `${JSON.stringify({ ...candidate, status: 'approved' }, null, 2)}\n`,
  )
  return target
}

export function methodMarkdown(method: MethodModule): string {
  return [
    '---',
    `version: ${method.version}`,
    `tags: ${method.tags.join(', ')}`,
    '---',
    '',
    `## Scope`,
    method.scope,
    '',
    '## Signal',
    method.signal,
    '',
    '## Diagnosis',
    method.diagnosis,
    '',
    '## Process',
    method.process,
    '',
    '## Output Contract',
    method.output,
    '',
    '## Positive Example',
    method.positive,
    '',
    '## Negative Example',
    method.negative,
    '',
    '## Self Check',
    method.selfCheck,
    '',
  ].join('\n')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}
