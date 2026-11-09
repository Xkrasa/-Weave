import path from 'node:path'
import { readdir } from 'node:fs/promises'
import type { ModelConfig, ProjectConfig } from './types.ts'
import { atomicWrite, atomicWriteJson, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { initProject, projectPaths } from './project.ts'
import { validationError, conflictError } from './errors.ts'

export interface ModelPreset {
  id: string
  label: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  provider?: 'openai-compatible' | 'google' | 'anthropic'
  note?: string
}

/** Built-in presets are only suggestions; a book may keep any custom endpoint. */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo 2.6 Pro（小米）',
    model: 'mimo-v2.6-pro',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKeyEnv: 'Mimo_API_KEY',
    note: '中文设定服从度高，适合漫剧向脱水文风',
  },
  {
    id: 'mimo-v2.6-flash',
    label: 'MiMo 2.6 Flash（小米）',
    model: 'mimo-v2.6-flash',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKeyEnv: 'Mimo_API_KEY',
    note: '更快更便宜，适合粗稿',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash（Google）',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'Google_API_KEY',
    provider: 'google',
    note: '走官方 OpenAI 兼容层',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash（Google）',
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'Google_API_KEY',
    provider: 'google',
    note: '新模型，服务端高峰期常返回 503',
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3（本机网关）',
    model: 'glm-5.3',
    baseUrl: 'http://127.0.0.1:7863/v1',
    apiKeyEnv: 'WEAVE_API_KEY',
    note: '需要本机网关在线',
  },
]

export interface LibraryBook {
  path: string
  name: string
  title: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  drafted: number
  finalized: number
  current: boolean
}

export async function listBooks(libraryRoot: string, currentRoot: string): Promise<LibraryBook[]> {
  const entries = await readdir(libraryRoot, { withFileTypes: true }).catch(() => [])
  const books: LibraryBook[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = path.join(libraryRoot, entry.name)
    const paths = projectPaths(root)
    const project = await readJsonIfExists<ProjectConfig>(paths.project)
    if (!project) continue
    const config = await readJsonIfExists<ModelConfig>(paths.modelConfig)
    books.push({
      path: root,
      name: entry.name,
      title: project.title,
      model: config?.model ?? '',
      baseUrl: config?.baseUrl ?? '',
      apiKeyEnv: config?.apiKeyEnv ?? 'WEAVE_API_KEY',
      drafted: (await listFiles(paths.draftsDir)).filter(name => name.endsWith('.md')).length,
      finalized: (await listFiles(paths.finalDir)).filter(name => name.endsWith('.md')).length,
      current: path.resolve(root) === path.resolve(currentRoot),
    })
  }
  return books.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
}

const BOOK_NAME = /^[A-Za-z0-9_-]{1,40}$/

export async function createBook(
  libraryRoot: string,
  input: { name?: string; title: string; model: string; baseUrl: string; apiKeyEnv?: string; provider?: ModelPreset['provider'] },
): Promise<string> {
  const title = input.title.trim()
  if (!title) throw validationError('书名不能为空')
  const name = (input.name?.trim() || slug(title)).trim()
  if (!BOOK_NAME.test(name)) throw validationError('书目录名只能用字母、数字、下划线或短横线')
  const root = path.join(libraryRoot, name)
  await initProject(root, {
    title,
    model: input.model,
    baseUrl: input.baseUrl,
    workflowVersion: 2,
    platform: 'fanqie',
  })
  if (input.apiKeyEnv || input.provider) {
    await applyModel(root, {
      model: input.model,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
      provider: input.provider,
    })
  }
  return root
}

function slug(title: string): string {
  const ascii = title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return ascii || `book-${Date.now().toString(36)}`
}

export async function readModel(root: string): Promise<{
  model: string
  baseUrl: string
  apiKeyEnv: string
  provider?: string
  presets: ModelPreset[]
}> {
  const config = await readJsonIfExists<ModelConfig>(projectPaths(root).modelConfig)
  if (!config) throw conflictError('项目缺少模型配置')
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv ?? 'WEAVE_API_KEY',
    ...(config.provider ? { provider: config.provider } : {}),
    presets: MODEL_PRESETS,
  }
}

export async function applyModel(
  root: string,
  patch: { model?: string; baseUrl?: string; apiKeyEnv?: string; provider?: ModelPreset['provider'] },
): Promise<ModelConfig> {
  const target = projectPaths(root).modelConfig
  const config = await readJsonIfExists<ModelConfig>(target)
  if (!config) throw conflictError('项目缺少模型配置')
  if (patch.model !== undefined) {
    if (!patch.model.trim()) throw validationError('模型名不能为空')
    config.model = patch.model.trim()
  }
  if (patch.baseUrl !== undefined) {
    if (!patch.baseUrl.trim()) throw validationError('Base URL 不能为空')
    config.baseUrl = patch.baseUrl.trim()
  }
  if (patch.apiKeyEnv !== undefined) config.apiKeyEnv = patch.apiKeyEnv.trim() || undefined
  if (patch.provider !== undefined) config.provider = patch.provider
  await atomicWriteJson(target, config)
  return config
}

export interface SetupDraft {
  title: string
  premise: string
  world: string
  protagonist: string
  voice: string
  prohibitions: string
}

export interface SetupState {
  needsSetup: boolean
  draft: SetupDraft
  bookPath: string
}

/** A book needs setup while its canon still holds the empty skeleton from `init`. */
export async function readSetup(root: string): Promise<SetupState> {
  const paths = projectPaths(root)
  const project = await readJsonIfExists<ProjectConfig>(paths.project)
  if (!project) throw conflictError('项目缺少 project.json')
  const premise = (await readTextIfExists(path.join(paths.canon, 'premise.md'))) ?? ''
  const world = (await readTextIfExists(path.join(paths.canon, 'world.md'))) ?? ''
  const style = (await readTextIfExists(path.join(paths.canon, 'style.md'))) ?? ''
  const prohibitions = (await readTextIfExists(path.join(paths.canon, 'prohibitions.md'))) ?? ''
  const characters = await readJsonIfExists<{ characters?: Array<{ name?: string; role?: string }> }>(
    path.join(paths.canon, 'characters.json'),
  )
  const protagonist = characters?.characters?.[0]?.name ?? ''
  return {
    needsSetup: premise.trim().length === 0 && world.trim().length === 0,
    draft: {
      title: project.title,
      premise: premise.trim(),
      world: world.trim(),
      protagonist,
      voice: style.trim(),
      prohibitions: prohibitions.trim(),
    },
    bookPath: root,
  }
}

export async function applySetup(root: string, draft: Partial<SetupDraft>): Promise<void> {
  const paths = projectPaths(root)
  const project = await readJsonIfExists<ProjectConfig>(paths.project)
  if (!project) throw conflictError('项目缺少 project.json')

  const title = draft.title?.trim()
  if (title) {
    project.title = title
    await atomicWriteJson(paths.project, project)
  }
  const files: Array<[string, string | undefined]> = [
    ['premise.md', draft.premise],
    ['world.md', draft.world],
    ['style.md', draft.voice],
    ['prohibitions.md', draft.prohibitions],
  ]
  for (const [name, value] of files) {
    if (value === undefined) continue
    await atomicWrite(path.join(paths.canon, name), value.trim() ? `${value.trim()}\n` : '')
  }
  const protagonist = draft.protagonist?.trim()
  if (protagonist) {
    const target = path.join(paths.canon, 'characters.json')
    const registry = (await readJsonIfExists<{ characters?: Array<Record<string, unknown>> }>(target)) ?? { characters: [] }
    const list = Array.isArray(registry.characters) ? registry.characters : []
    if (!list.some(item => item.name === protagonist)) {
      list.unshift({ name: protagonist, status: 'alive', introducedIn: 1 })
    }
    await atomicWriteJson(target, { ...registry, characters: list })
  }
}
