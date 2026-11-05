import path from 'node:path'
import { readJsonIfExists, listFiles, readTextIfExists } from './io.ts'
import { projectPaths } from './project.ts'

export interface StyleConstitution {
  schemaVersion: 1
  pov: 'limited' | 'omniscient' | 'any'
  sentenceLength: { min: number; max: number }
  dialogueRatio: { min: number; max: number }
  interiority: 'low' | 'medium' | 'high'
  descriptionDensity: 'low' | 'medium' | 'high'
  endingStrategy: string
  forbiddenPatterns: string[]
}

export interface AuthorSample {
  id: string
  text: string
  source: string
  tags: string[]
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
  const names = (await listFiles(dir)).filter(name => name.endsWith('.md') || name.endsWith('.txt')).slice(0, limit)
  const samples: AuthorSample[] = []
  for (const name of names) {
    const raw = await readTextIfExists(path.join(dir, name))
    if (!raw?.trim()) continue
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
    const tags = (frontmatter?.[1].match(/^(?:tags|标签):\s*(.+)$/im)?.[1] ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    const text = frontmatter ? raw.slice(frontmatter[0].length) : raw
    samples.push({
      id: name.replace(/\.(md|txt)$/i, ''),
      text: text.trim(),
      source: name,
      tags,
    })
  }
  return samples
}

export function styleText(style: StyleConstitution): string {
  return [
    `pov=${style.pov}`,
    `sentenceLength=${style.sentenceLength.min}-${style.sentenceLength.max}`,
    `dialogueRatio=${style.dialogueRatio.min}-${style.dialogueRatio.max}`,
    `interiority=${style.interiority}`,
    `descriptionDensity=${style.descriptionDensity}`,
    `ending=${style.endingStrategy}`,
    style.forbiddenPatterns.length > 0 ? `forbidden=${style.forbiddenPatterns.join('|')}` : '',
  ].filter(Boolean).join('\n')
}
