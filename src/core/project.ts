import path from 'node:path'
import { access } from 'node:fs/promises'
import type { ModelConfig, ProjectConfig } from './types.ts'
import { atomicWrite, atomicWriteJson, ensureDir, isMissing, readJson } from './io.ts'
import { conflictError, usageError } from './errors.ts'

export interface ProjectPaths {
  root: string
  metadata: string
  project: string
  modelConfig: string
  checks: string
  stages: string
  drafts: string
  runs: string
  indexDb: string
  canon: string
  outlines: string
  chapters: string
  draftsDir: string
  finalDir: string
  versionsDir: string
  ledger: string
  commits: string
  impacts: string
  mainline: string
  exports: string
  references: string
}

export function projectPaths(root: string): ProjectPaths {
  const metadata = path.join(root, '.weave')
  const chapters = path.join(root, 'chapters')
  const ledger = path.join(root, 'ledger')
  return {
    root,
    metadata,
    project: path.join(metadata, 'project.json'),
    modelConfig: path.join(metadata, 'config.json'),
    checks: path.join(metadata, 'checks'),
    stages: path.join(metadata, 'stages'),
    drafts: path.join(metadata, 'drafts'),
    runs: path.join(metadata, 'runs'),
    indexDb: path.join(metadata, 'index.db'),
    canon: path.join(root, 'canon'),
    outlines: path.join(root, 'outlines'),
    chapters,
    draftsDir: path.join(chapters, 'drafts'),
    finalDir: path.join(chapters, 'final'),
    versionsDir: path.join(chapters, 'versions'),
    ledger,
    commits: path.join(ledger, 'commits'),
    impacts: path.join(ledger, 'impacts'),
    mainline: path.join(ledger, 'mainline.jsonl'),
    exports: path.join(root, 'exports'),
    references: path.join(root, 'references'),
  }
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start)
  while (true) {
    if (await exists(path.join(current, '.weave', 'project.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw usageError('当前目录不在 Weave 项目中；请先执行 `weave init`')
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function loadProject(root: string): Promise<ProjectConfig> {
  const project = await readJson<ProjectConfig>(projectPaths(root).project)
  if (project.schemaVersion !== 3) {
    throw conflictError(`不支持的项目版本：${String(project.schemaVersion)}`)
  }
  return project
}

export async function loadModelConfig(root: string): Promise<ModelConfig> {
  return readJson<ModelConfig>(projectPaths(root).modelConfig)
}

export interface InitOptions {
  title?: string
  language?: string
  targetWords?: number
  chapterWords?: number
  model?: string
  baseUrl?: string
  contextWindow?: number
  maxOutputTokens?: number
  snapshotEvery?: number
  workflowVersion?: 1 | 2
}

export async function initProject(dir: string, options: InitOptions = {}): Promise<{ root: string; project: ProjectConfig; config: ModelConfig }> {
  const root = path.resolve(dir)
  const paths = projectPaths(root)
  if (await exists(paths.project)) {
    throw conflictError(`项目已存在：${root}`)
  }

  const title = options.title?.trim() || path.basename(root)
  const project: ProjectConfig = {
    schemaVersion: 3,
    workflowVersion: options.workflowVersion ?? 2,
    title,
    language: options.language?.trim() || 'zh-CN',
    targetWords: positiveInt(options.targetWords, 1_000_000, 'targetWords'),
    chapterWords: positiveInt(options.chapterWords, 3000, 'chapterWords'),
    createdAt: new Date().toISOString(),
  }
  const config: ModelConfig = {
    model: options.model?.trim() || 'gpt-4o-mini',
    baseUrl: options.baseUrl?.trim() || 'https://api.openai.com/v1',
    contextWindow: positiveInt(options.contextWindow, 32_768, 'contextWindow'),
    maxOutputTokens: positiveInt(options.maxOutputTokens, 4096, 'maxOutputTokens'),
    safetyMarginTokens: 512,
    charsPerToken: 1.6,
    temperature: 0.8,
    timeoutMs: 120_000,
    snapshotEvery: positiveInt(options.snapshotEvery, 10, 'snapshotEvery'),
  }

  for (const dirPath of [
    paths.metadata,
    paths.checks,
    paths.stages,
    paths.drafts,
    paths.runs,
    paths.canon,
    path.join(paths.outlines, 'chapters'),
    paths.draftsDir,
    paths.finalDir,
    paths.versionsDir,
    paths.commits,
    paths.impacts,
    paths.exports,
    paths.references,
  ]) {
    await ensureDir(dirPath)
  }

  await atomicWriteJson(paths.project, project)
  await atomicWriteJson(paths.modelConfig, config)
  await atomicWriteJson(path.join(paths.canon, 'characters.json'), { characters: [] })
  for (const file of ['premise.md', 'style.md', 'prohibitions.md', 'world.md']) {
    const target = path.join(paths.canon, file)
    if (!(await exists(target))) await atomicWrite(target, '')
  }
  await atomicWrite(path.join(paths.metadata, '.gitignore'), 'index.db\nindex.db-journal\n')

  return { root, project, config }
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`${name} 必须是正整数`)
  }
  return value
}
