import path from 'node:path'
import { atomicWriteJson, readJsonIfExists, listFiles, readTextIfExists } from './io.ts'
import { projectPaths } from './project.ts'

export interface StyleConstitution {
  schemaVersion: 1
  pov: 'limited' | 'omniscient' | 'any'
  sentenceLength: { min: number; max: number }
  dialogueRatio: { min: number; max: number }
  /** 标点频率维度：破折号过量是典型 AI 味特征，正则类检查管不到的量。可选，由作者 adopt 后生效。 */
  dashRatio?: { min: number; max: number }
  questionMarkRatio?: { min: number; max: number }
  interiority: 'low' | 'medium' | 'high'
  descriptionDensity: 'low' | 'medium' | 'high'
  endingStrategy: string
  forbiddenPatterns: string[]
}

export interface StyleCandidate {
  schemaVersion: 1
  derivedAt: string
  derivedFrom: string[]
  sampleCount: number
  suggested: {
    sentenceLength: { min: number; max: number }
    dialogueRatio: { min: number; max: number }
    dashRatio: { min: number; max: number }
    questionMarkRatio: { min: number; max: number }
  }
}

export interface AuthorSample {
  id: string
  text: string
  source: string
  tags: string[]
  sceneTypes: string[]
  characters: string[]
  pov?: string
  styleTags: string[]
}

export interface AuthorSampleSelection {
  samples: AuthorSample[]
  selected: Array<{ id: string; score: number; reasons: string[] }>
  reasons: string[]
  estimatedTokens: number
  fallback: boolean
}

const DEFAULT_STYLE: StyleConstitution = {
  schemaVersion: 1,
  pov: 'limited',
  sentenceLength: { min: 8, max: 40 },
  dialogueRatio: { min: 0.05, max: 0.65 },
  interiority: 'medium',
  descriptionDensity: 'medium',
  endingStrategy: '以具体动作或未解问题收束，不用总结句',
  forbiddenPatterns: [],
}

export async function loadStyleConstitution(root: string): Promise<StyleConstitution> {
  const raw = await readJsonIfExists<Partial<StyleConstitution>>(path.join(projectPaths(root).canon, 'style.json'))
  if (!raw) return DEFAULT_STYLE
  return {
    ...DEFAULT_STYLE,
    ...raw,
    schemaVersion: 1,
    sentenceLength: { ...DEFAULT_STYLE.sentenceLength, ...(raw.sentenceLength ?? {}) },
    dialogueRatio: { ...DEFAULT_STYLE.dialogueRatio, ...(raw.dialogueRatio ?? {}) },
    forbiddenPatterns: Array.isArray(raw.forbiddenPatterns) ? raw.forbiddenPatterns : [],
  }
}

export async function loadAuthorSamples(root: string, limit = 3): Promise<AuthorSample[]> {
  const dir = path.join(projectPaths(root).canon, 'samples')
  const names = (await listFiles(dir)).filter(name => name.endsWith('.md') || name.endsWith('.txt'))
  const samples: AuthorSample[] = []
  for (const name of names) {
    const raw = await readTextIfExists(path.join(dir, name))
    if (!raw?.trim()) continue
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
    const metadata = frontmatter?.[1] ?? ''
    const text = frontmatter ? raw.slice(frontmatter[0].length) : raw
    samples.push({
      id: name.replace(/\.(md|txt)$/i, ''),
      text: text.trim(),
      source: name,
      tags: metadataValues(metadata, ['tags', '标签']),
      sceneTypes: metadataValues(metadata, ['sceneTypes', 'scene', '场景', '场景类型']),
      characters: metadataValues(metadata, ['characters', '人物']),
      pov: metadataValues(metadata, ['pov', '视角'])[0],
      styleTags: metadataValues(metadata, ['styleTags', 'style', '风格']),
    })
  }
  return samples.slice(0, limit)
}

export async function selectAuthorSamples(
  root: string,
  contract: import('./types.ts').ChapterContract,
  options: { limit?: number; maxTokens?: number; strategy?: 'scene' | 'legacy' | 'off' } = {},
): Promise<AuthorSampleSelection> {
  const strategy = options.strategy ?? 'scene'
  if (strategy === 'off') return { samples: [], selected: [], reasons: ['作者样本策略已关闭'], estimatedTokens: 0, fallback: false }
  const all = await loadAuthorSamples(root, Number.MAX_SAFE_INTEGER)
  if (all.length === 0) return { samples: [], selected: [], reasons: ['没有作者样本'], estimatedTokens: 0, fallback: false }
  const text = [
    contract.goal,
    contract.obstacle ?? '',
    ...contract.mustHappen,
    contract.readerIntent?.purpose ?? '',
    ...(contract.sceneTypes ?? []),
  ].join(' ')
  const scored = all.map(sample => {
    let score = 0
    const reasons: string[] = []
    for (const type of (contract.sceneTypes ?? []).filter(type => sample.sceneTypes.includes(type))) {
      score += 6
      reasons.push(`场景=${type}`)
    }
    for (const name of contract.characters.filter(name => sample.characters.includes(name))) {
      score += 2
      reasons.push(`人物=${name}`)
    }
    if (sample.pov && sample.pov === contract.pov) {
      score += 4
      reasons.push(`POV=${sample.pov}`)
    }
    for (const tag of [...sample.tags, ...sample.styleTags].filter(tag => text.includes(tag))) {
      score += 1
      reasons.push(`标签=${tag}`)
    }
    return { sample, score, reasons }
  })
  const hasExplicitMatch = strategy === 'scene' && scored.some(item => item.score > 0)
  const ranked = hasExplicitMatch
    ? scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.sample.id.localeCompare(b.sample.id))
    : scored.map(item => ({ ...item, reasons: ['无显式匹配，按文件名回退'] }))
  const limit = Math.max(1, options.limit ?? 3)
  const maxTokens = options.maxTokens ?? 2400
  const samples: AuthorSample[] = []
  const selected: AuthorSampleSelection['selected'] = []
  const reasons: string[] = []
  let estimatedTokens = 0
  for (const item of ranked) {
    if (samples.length >= limit) break
    const tokens = Math.ceil([...item.sample.text].length / 1.6)
    if (estimatedTokens + tokens > maxTokens) {
      reasons.push(`预算省略=${item.sample.id}`)
      continue
    }
    samples.push(item.sample)
    selected.push({ id: item.sample.id, score: item.score, reasons: item.reasons })
    estimatedTokens += tokens
  }
  if (!hasExplicitMatch) reasons.unshift('无显式标签匹配，保留文件名顺序')
  if (samples.length === 0 && estimatedTokens === 0 && ranked.length > 0 && !reasons.some(reason => reason.startsWith('预算省略'))) {
    reasons.push('预算不足，未选入样本')
  }
  return { samples, selected, reasons, estimatedTokens, fallback: !hasExplicitMatch }
}

function metadataValues(metadata: string, names: string[]): string[] {
  const pattern = new RegExp(`^(?:${names.join('|')}):\\s*(.+)$`, 'im')
  const value = pattern.exec(metadata)?.[1] ?? ''
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

function quantileRange(values: number[], round: (value: number) => number): { min: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return { min: round(percentile(sorted, 0.25)), max: round(percentile(sorted, 0.75)) }
}

/**
 * 从作者定稿反推风格区间建议：取各样本章节的统计量，P25–P75 分位而非均值，
 * 异常章（如刻意写战斗）只抬高分位边界、不会整体带偏。推导值只落候选文件，
 * 作者 `weave style adopt` 后才写 canon——AI 推导值不得自动成为作者口径。
 */
export function deriveStyleRange(samples: Array<{ id: string; text: string }>): StyleCandidate | null {
  const usable = samples.filter(sample => [...sample.text.trim()].length >= 100)
  if (usable.length === 0) return null
  const avgLengths: number[] = []
  const dialogue: number[] = []
  const dash: number[] = []
  const question: number[] = []
  for (const sample of usable) {
    const text = sample.text
    const sentences = text.split(/[。！？!?]/).map(item => item.trim()).filter(Boolean)
    if (sentences.length > 0) {
      avgLengths.push(sentences.reduce((sum, item) => sum + [...item].length, 0) / sentences.length)
    }
    const chars = [...text].length
    const dialogueText = (text.match(/“[^”]*”|"[^"]*"/g) ?? []).join('')
    dialogue.push([...dialogueText].length / chars)
    dash.push((text.match(/——|—/g) ?? []).length / chars)
    question.push((text.match(/？|\?/g) ?? []).length / chars)
  }
  return {
    schemaVersion: 1,
    derivedAt: new Date().toISOString(),
    derivedFrom: usable.map(sample => sample.id),
    sampleCount: usable.length,
    suggested: {
      sentenceLength: quantileRange(avgLengths, value => Math.max(1, Math.round(value))),
      dialogueRatio: quantileRange(dialogue, value => Number(value.toFixed(3))),
      dashRatio: quantileRange(dash, value => Number(value.toFixed(4))),
      questionMarkRatio: quantileRange(question, value => Number(value.toFixed(4))),
    },
  }
}

export async function saveStyleCandidate(root: string, candidate: StyleCandidate): Promise<string> {
  const target = path.join(projectPaths(root).metadata, 'style-candidate.json')
  await atomicWriteJson(target, candidate)
  return target
}

export async function loadStyleCandidate(root: string): Promise<StyleCandidate | null> {
  return readJsonIfExists<StyleCandidate>(path.join(projectPaths(root).metadata, 'style-candidate.json'))
}

/** 作者明示采纳：候选区间并入 canon/style.json，其余作者口径字段不动。 */
export async function adoptStyleCandidate(root: string): Promise<StyleConstitution> {
  const candidate = await loadStyleCandidate(root)
  if (!candidate) throw new Error('没有可采纳的风格候选；请先执行 weave style derive')
  const current = await loadStyleConstitution(root)
  const adopted: StyleConstitution = {
    ...current,
    sentenceLength: candidate.suggested.sentenceLength,
    dialogueRatio: candidate.suggested.dialogueRatio,
    dashRatio: candidate.suggested.dashRatio,
    questionMarkRatio: candidate.suggested.questionMarkRatio,
  }
  await atomicWriteJson(path.join(projectPaths(root).canon, 'style.json'), adopted)
  return adopted
}

export function styleText(style: StyleConstitution): string {
  return [
    `pov=${style.pov}`,
    `sentenceLength=${style.sentenceLength.min}-${style.sentenceLength.max}`,
    `dialogueRatio=${style.dialogueRatio.min}-${style.dialogueRatio.max}`,
    style.dashRatio ? `dashRatio=${style.dashRatio.min}-${style.dashRatio.max}` : '',
    style.questionMarkRatio ? `questionMarkRatio=${style.questionMarkRatio.min}-${style.questionMarkRatio.max}` : '',
    `interiority=${style.interiority}`,
    `descriptionDensity=${style.descriptionDensity}`,
    `ending=${style.endingStrategy}`,
    style.forbiddenPatterns.length > 0 ? `forbidden=${style.forbiddenPatterns.join('|')}` : '',
  ].filter(Boolean).join('\n')
}
