import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ChapterContract, IdeaPromotionTarget } from './types.ts'
import { atomicWrite, atomicWriteJson, ensureDir, fileHash, isMissing, listFiles, readJson, readJsonIfExists, readTextIfExists } from './io.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'
import { hashText } from './hash.ts'
import { lcsMatches } from './lcs.ts'
import { recordIdeaPromotionDecision } from './pending.ts'

export type IdeaStatus = 'inbox' | 'promoted' | 'archived'
export type IdeaPriority = 'high' | 'normal' | 'low'
export type IdeaSpoilerLevel = 'none' | 'hint' | 'reveal'
export type IdeaPromotionState = 'active' | 'stale' | 'none'

export type IdeaScope =
  | { kind: 'chapter'; ref: number }
  | { kind: 'volume'; ref: number }
  | { kind: 'book' }
  | { kind: 'character'; ref: string }
  | { kind: 'world' }
  | { kind: 'mechanic' }

export interface IdeaLinks {
  promiseIds: string[]
  loopIds: string[]
  chapters: number[]
}

export interface IdeaPromotion {
  target: IdeaPromotionTarget
  targetPath: string
  targetHash: string
  promotedAt: string
  approvedBy: 'author'
}

/** Author-facing manual usage mark; never inferred by the system. */
export interface IdeaUsage {
  chapters: number[]
  markedAt: string
  markedBy: 'author'
}

export interface Idea {
  id: string
  schemaVersion: 1
  title: string
  status: IdeaStatus
  tags: string[]
  scope: IdeaScope
  priority: IdeaPriority
  spoilerLevel: IdeaSpoilerLevel
  revealAfterChapter?: number
  links: IdeaLinks
  promotion?: IdeaPromotion
  /** Only set when the author explicitly marked the idea as used. */
  usage?: IdeaUsage
  createdAt: string
  updatedAt: string
}

/** Idea plus derived, never-persisted fields used by list/read surfaces. */
export interface IdeaView extends Idea {
  promotionState: IdeaPromotionState
  /** True when the Markdown body is missing; callers show an empty body. */
  bodyMissing?: boolean
}

export interface IdeaInput {
  title?: string
  body: string
  tags?: string[]
  scope?: IdeaScope | string
  priority?: string
  spoilerLevel?: string
  revealAfterChapter?: number | null
  links?: Partial<IdeaLinks>
}

export interface IdeaPatch {
  title?: string
  body?: string
  tags?: string[]
  scope?: IdeaScope | string
  priority?: string
  spoilerLevel?: string
  revealAfterChapter?: number | null
  links?: Partial<IdeaLinks>
}

export interface IdeaFilter {
  status?: IdeaStatus
  tag?: string
  scopeKind?: IdeaScope['kind']
}

export interface PromotionProposal {
  ideaId: string
  target: IdeaPromotionTarget
  targetPath: string
  currentHash: string
  proposedText: string
  diff: string
  warnings: string[]
}

const IDEA_ID = /^idea-\d{8}-[0-9a-f]{6}$/
const TITLE_LIMIT = 40

export function ideaMetaPath(root: string, id: string): string {
  return path.join(projectPaths(root).ideas, `${assertIdeaId(id)}.json`)
}

export function ideaBodyPath(root: string, id: string): string {
  return path.join(projectPaths(root).ideas, `${assertIdeaId(id)}.md`)
}

export async function captureIdea(root: string, input: IdeaInput): Promise<IdeaView> {
  const body = requireBody(input.body)
  const title = normalizeTitle(input.title) ?? deriveTitle(body)
  const meta = buildMeta({
    title,
    tags: input.tags,
    scope: input.scope,
    priority: input.priority,
    spoilerLevel: input.spoilerLevel,
    revealAfterChapter: input.revealAfterChapter,
    links: input.links,
  })
  const now = new Date().toISOString()
  const idea: Idea = {
    schemaVersion: 1,
    ...meta,
    title,
    status: 'inbox',
    createdAt: now,
    updatedAt: now,
    id: await nextId(root),
  }
  await ensureDir(projectPaths(root).ideas)
  await writePair(root, idea, body)
  return decorate(root, idea)
}

export async function listIdeas(root: string, filter: IdeaFilter = {}): Promise<IdeaView[]> {
  const dir = projectPaths(root).ideas
  const files = await listFiles(dir)
  const views: IdeaView[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const idea = await readIdeaMeta(path.join(dir, file))
    if (filter.status) {
      if (idea.status !== filter.status) continue
    } else if (idea.status === 'archived') {
      // Archived ideas are opt-in: they only appear when the caller asks for them.
      continue
    }
    if (filter.tag && !idea.tags.includes(filter.tag)) continue
    if (filter.scopeKind && idea.scope.kind !== filter.scopeKind) continue
    views.push(await decorate(root, idea))
  }
  return views.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

export async function readIdea(root: string, id: string): Promise<{ meta: IdeaView; body: string }> {
  const idea = await loadIdea(root, id)
  const stored = await readIdeaBody(root, id)
  return {
    meta: await decorate(root, idea.meta, stored.missing),
    body: stored.missing ? '' : stored.text,
  }
}

export async function updateIdea(root: string, id: string, patch: IdeaPatch): Promise<IdeaView> {
  const current = await loadIdea(root, id)
  const stored = await readIdeaBody(root, id)
  const body = patch.body === undefined ? null : requireBody(patch.body)
  const title = patch.title === undefined
    ? current.meta.title
    : normalizeTitle(patch.title) ?? deriveTitle(body ?? stored.text)

  const next: Idea = {
    ...current.meta,
    ...patchData(patch),
    title,
    status: current.meta.status,
    id: current.meta.id,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  }
  if (patch.revealAfterChapter === null) delete next.revealAfterChapter
  if (patch.body !== undefined) {
    await atomicWrite(ideaBodyPath(root, id), withTrailingNewline(body ?? ''))
  }
  await atomicWriteJson(ideaMetaPath(root, id), next)
  return decorate(root, next)
}

export async function archiveIdea(root: string, id: string): Promise<IdeaView> {
  const current = await loadIdea(root, id)
  if (current.meta.status === 'archived') return readIdea(root, id).then(result => result.meta)
  const next: Idea = {
    ...current.meta,
    status: 'archived',
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteJson(ideaMetaPath(root, id), next)
  return decorate(root, next)
}

/** Author-only "used" mark; the map never infers usage on its own. */
export async function markIdeaUsed(root: string, id: string, chapters: number[]): Promise<IdeaView> {
  const current = await loadIdea(root, id)
  const normalized = chapters.length === 0
    ? []
    : [...new Set(chapters.map(Number))].sort((left, right) => left - right)
  if (normalized.some(chapter => !Number.isSafeInteger(chapter) || chapter <= 0)) {
    throw validationError('usage.chapters 必须是正整数数组')
  }
  const next: Idea = {
    ...current.meta,
    usage: { chapters: normalized, markedAt: new Date().toISOString(), markedBy: 'author' },
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteJson(ideaMetaPath(root, id), next)
  return decorate(root, next)
}

export async function clearIdeaUsage(root: string, id: string): Promise<IdeaView> {
  const current = await loadIdea(root, id)
  const next: Idea = { ...current.meta, updatedAt: new Date().toISOString() }
  delete next.usage
  await atomicWriteJson(ideaMetaPath(root, id), next)
  return decorate(root, next)
}

/** Stores promotion metadata on the idea; callers own the target file lifecycle. */
export async function recordPromotion(root: string, id: string, promotion: IdeaPromotion): Promise<IdeaView> {
  const current = await loadIdea(root, id)
  const next: Idea = {
    ...current.meta,
    status: 'promoted',
    promotion,
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteJson(ideaMetaPath(root, id), next)
  return decorate(root, next)
}

export async function promotionState(root: string, idea: Idea): Promise<IdeaPromotionState> {
  if (!idea.promotion) return 'none'
  const target = path.resolve(root, idea.promotion.targetPath)
  const actual = await fileHash(target).catch(error => {
    if (isMissing(error)) return null
    throw error
  })
  return actual === idea.promotion.targetHash ? 'active' : 'stale'
}

export async function loadIdea(root: string, id: string): Promise<{ meta: Idea; body: string }> {
  const file = ideaMetaPath(root, id)
  const meta = await readIdeaMeta(file).catch(error => {
    if (isMissing(error)) throw validationError(`找不到想法：${id}`)
    throw error
  })
  const stored = await readIdeaBody(root, id)
  return { meta, body: stored.missing ? '' : stored.text }
}

function buildMeta(input: Omit<IdeaInput, 'body'>): Omit<Idea, 'id' | 'status' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'title'> {
  return {
    tags: normalizeTags(input.tags),
    scope: normalizeScope(input.scope),
    priority: normalizePriority(input.priority),
    spoilerLevel: normalizeSpoiler(input.spoilerLevel),
    ...normalizeReveal(input.revealAfterChapter),
    links: normalizeLinks(input.links),
  }
}

function patchData(patch: IdeaPatch): Partial<Idea> {
  const data: Partial<Idea> = {}
  if (patch.tags !== undefined) data.tags = normalizeTags(patch.tags)
  if (patch.scope !== undefined) data.scope = normalizeScope(patch.scope)
  if (patch.priority !== undefined) data.priority = normalizePriority(patch.priority)
  if (patch.spoilerLevel !== undefined) data.spoilerLevel = normalizeSpoiler(patch.spoilerLevel)
  if (patch.revealAfterChapter !== undefined) {
    const reveal = normalizeReveal(patch.revealAfterChapter)
    if (reveal.revealAfterChapter !== undefined) data.revealAfterChapter = reveal.revealAfterChapter
  }
  if (patch.links !== undefined) data.links = normalizeLinks(patch.links)
  return data
}

function normalizeReveal(value: number | null | undefined): { revealAfterChapter?: number } {
  if (value === null || value === undefined) return {}
  if (!Number.isSafeInteger(value) || value <= 0) throw validationError('revealAfterChapter 必须是正整数')
  return { revealAfterChapter: value }
}

function normalizeTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const title = value.trim()
  if (!title) throw validationError('想法标题不能为空')
  return truncate([...title].slice(0, TITLE_LIMIT).join(''))
}

function deriveTitle(body: string): string {
  const line = body.split(/\r?\n/).map(item => item.trim()).find(Boolean)
  const cleaned = (line ?? '').replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s*/, '').trim()
  return truncate([...cleaned].slice(0, TITLE_LIMIT).join('')) || '未命名想法'
}

function truncate(value: string): string {
  return [...value].slice(0, TITLE_LIMIT).join('')
}

function requireBody(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError('想法正文不能为空')
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd()
}

function normalizeTags(value: string[] | undefined): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw validationError('tags 必须是字符串数组')
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
}

function normalizePriority(value: string | undefined): IdeaPriority {
  if (value === undefined) return 'normal'
  if (!['high', 'normal', 'low'].includes(value)) throw validationError('priority 只能是 high、normal 或 low')
  return value as IdeaPriority
}

function normalizeSpoiler(value: string | undefined): IdeaSpoilerLevel {
  if (value === undefined) return 'none'
  if (!['none', 'hint', 'reveal'].includes(value)) throw validationError('spoilerLevel 只能是 none、hint 或 reveal')
  return value as IdeaSpoilerLevel
}

function normalizeScope(value: IdeaScope | string | undefined): IdeaScope {
  if (value === undefined) return { kind: 'book' }
  if (typeof value === 'string') return parseScope(value)
  if (!value || typeof value !== 'object' || !('kind' in value)) throw validationError('scope 必须是对象')
  switch (value.kind) {
    case 'chapter':
    case 'volume':
      if (!Number.isSafeInteger(value.ref) || value.ref <= 0) throw validationError(`scope ${value.kind} 的 ref 必须是正整数`)
      return { kind: value.kind, ref: value.ref }
    case 'character':
      if (typeof value.ref !== 'string' || !value.ref.trim()) throw validationError('scope character 的 ref 不能为空')
      return { kind: 'character', ref: value.ref.trim() }
    case 'book':
    case 'world':
    case 'mechanic':
      return { kind: value.kind }
    default:
      throw validationError(`未知 scope：${String((value as { kind?: string }).kind)}`)
  }
}

/**
 * Scope admission used by context assembly and the soft review check. Book-scoped ideas are
 * opt-in; chapter/volume/character scopes only match when the chapter actually qualifies.
 */
export function ideaScopeMatches(
  idea: Pick<Idea, 'scope'>,
  contract: Pick<ChapterContract, 'chapter' | 'volume' | 'characters'>,
  options: { includeBookIdeas?: boolean } = {},
): boolean {
  const scope = idea.scope
  if (scope.kind === 'chapter') return scope.ref === contract.chapter
  if (scope.kind === 'volume') return contract.volume !== undefined && scope.ref === contract.volume
  if (scope.kind === 'character') return contract.characters.includes(scope.ref)
  if (scope.kind === 'book') return options.includeBookIdeas === true
  // World/mechanic ideas are global, but still capped and ranked like every other idea.
  return true
}

/**
 * First `mustNotHappen` entry whose text an idea's title or body mentions verbatim.
 * Shared by context assembly (drops the material) and review (raises a soft warning).
 */
export function findForbiddenIdeaMention(
  contract: Pick<ChapterContract, 'mustNotHappen'>,
  idea: Pick<Idea, 'title'>,
  body: string,
): string | null {
  for (const item of contract.mustNotHappen ?? []) {
    const needle = item.trim()
    if (needle && (body.includes(needle) || idea.title.includes(needle))) return needle
  }
  return null
}

/** One place that enumerates the scope union for display: human label (`第 3 章`) or CLI ref (`chapter:3`). */
export function formatIdeaScope(scope: IdeaScope, style: 'label' | 'ref' = 'label'): string {
  switch (scope.kind) {
    case 'chapter':
      return style === 'label' ? `第 ${scope.ref} 章` : `chapter:${scope.ref}`
    case 'volume':
      return style === 'label' ? `第 ${scope.ref} 卷` : `volume:${scope.ref}`
    case 'character':
      return style === 'label' ? `人物：${scope.ref}` : `character:${scope.ref}`
    case 'book':
      return style === 'label' ? '全书' : 'book'
    case 'world':
      return style === 'label' ? '世界观' : 'world'
    case 'mechanic':
      return style === 'label' ? '机制' : 'mechanic'
  }
}

export function parseScope(value: string): IdeaScope {
  const [kind, rawRef] = value.split(':', 2)
  switch (kind) {
    case 'chapter':
    case 'volume': {
      const ref = Number(rawRef)
      if (!Number.isSafeInteger(ref) || ref <= 0) throw validationError(`scope ${kind} 需要正整数，例如 ${kind}:3`)
      return { kind, ref }
    }
    case 'character':
      if (!rawRef?.trim()) throw validationError('scope character 需要人物名，例如 character:林岚')
      return { kind: 'character', ref: rawRef.trim() }
    case 'book':
    case 'world':
    case 'mechanic':
      return { kind }
    default:
      throw validationError('scope 只能是 chapter:N、volume:N、book、character:名字、world 或 mechanic')
  }
}

function normalizeLinks(value: Partial<IdeaLinks> | undefined): IdeaLinks {
  if (value === undefined) return { promiseIds: [], loopIds: [], chapters: [] }
  const strings = (input: unknown, name: string): string[] => {
    if (input === undefined) return []
    if (!Array.isArray(input)) throw validationError(`links.${name} 必须是字符串数组`)
    return [...new Set(input.map(item => String(item).trim()).filter(Boolean))]
  }
  const chapters = (input: unknown): number[] => {
    if (input === undefined) return []
    if (!Array.isArray(input)) throw validationError('links.chapters 必须是正整数数组')
    const values = input.map(Number)
    if (values.some(item => !Number.isSafeInteger(item) || item <= 0)) throw validationError('links.chapters 必须是正整数数组')
    return [...new Set(values)].sort((left, right) => left - right)
  }
  return {
    promiseIds: strings(value.promiseIds, 'promiseIds'),
    loopIds: strings(value.loopIds, 'loopIds'),
    chapters: chapters(value.chapters),
  }
}

function assertIdeaId(id: string): string {
  if (!IDEA_ID.test(id)) throw validationError(`无效的想法 id：${id}`)
  return id
}

async function nextId(root: string): Promise<string> {
  const dir = projectPaths(root).ideas
  const stamp = new Date()
  const yyyymmdd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`
  const existing = new Set((await listFiles(dir)).map(file => file.replace(/\.(json|md)$/, '')))
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `idea-${yyyymmdd}-${randomBytes(3).toString('hex')}`
    if (!existing.has(id)) return id
  }
  throw conflictError('无法分配新的想法 id；请稍后重试')
}

async function writePair(root: string, idea: Idea, body: string): Promise<void> {
  await atomicWrite(ideaBodyPath(root, idea.id), withTrailingNewline(body))
  await atomicWriteJson(ideaMetaPath(root, idea.id), idea)
}

function withTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`
}

async function readIdeaMeta(file: string): Promise<Idea> {
  const meta = await readJson<Idea>(file)
  if (meta.schemaVersion !== 1) throw validationError(`不支持的想法版本：${String(meta.schemaVersion)}`)
  return meta
}

async function readIdeaBody(root: string, id: string): Promise<{ text: string; missing: boolean }> {
  const text = await readTextIfExists(ideaBodyPath(root, id))
  return text === null ? { text: '', missing: true } : { text, missing: false }
}

async function decorate(root: string, idea: Idea, bodyMissing = false): Promise<IdeaView> {
  return {
    ...idea,
    promotionState: await promotionState(root, idea),
    ...(bodyMissing ? { bodyMissing: true } : {}),
  }
}

// ---- Promotion --------------------------------------------------------------

const PROMOTION_PREFIX: Record<IdeaPromotionTarget, (root: string, ideaId: string, idea: Idea) => string> = {
  plan: (root, ideaId) => path.join(projectPaths(root).plans, 'idea-promotions', `${ideaId}.md`),
  contract: (root, ideaId, idea) => idea.scope.kind === 'chapter'
    ? path.join(projectPaths(root).outlines, 'chapters', `${String(idea.scope.ref).padStart(3, '0')}.idea-${ideaId}.json`)
    : path.join(projectPaths(root).outlines, 'ideas', `${ideaId}.json`),
  outline: (root, ideaId) => path.join(projectPaths(root).outlines, 'ideas', `${ideaId}.md`),
  canon: (root, ideaId) => path.join(projectPaths(root).canon, `${ideaId}.candidate.md`),
  promise: (root, ideaId) => path.join(projectPaths(root).plans, 'idea-promotions', `${ideaId}.promise.json`),
}

export function proposalPath(root: string, ideaId: string): string {
  return path.join(projectPaths(root).ideaProposals, `${assertIdeaId(ideaId)}.json`)
}

export async function loadPromotionProposal(root: string, ideaId: string): Promise<PromotionProposal | null> {
  return readJsonIfExists<PromotionProposal>(proposalPath(root, ideaId))
}

/**
 * Reads the idea and target, then produces a candidate. No target file is written here:
 * callers show the diff and only `applyPromotion` persists the candidate.
 */
export async function promoteIdea(
  root: string,
  ideaId: string,
  target: IdeaPromotionTarget,
  options: { targetPath?: string } = {},
): Promise<PromotionProposal> {
  if (!['plan', 'contract', 'outline', 'canon', 'promise'].includes(target)) {
    throw validationError('晋升目标只能是 plan、contract、outline、canon 或 promise')
  }
  const { meta, body } = await loadIdea(root, ideaId)
  const targetAbsolute = options.targetPath
    ? path.resolve(root, options.targetPath)
    : PROMOTION_PREFIX[target](root, meta.id, meta)
  assertSafeTarget(root, target, targetAbsolute)
  const existing = await readTextIfExists(targetAbsolute)
  const proposedText = candidateText(meta, body, target)
  return {
    ideaId: meta.id,
    target,
    targetPath: relativeTarget(root, targetAbsolute),
    currentHash: hashText(existing ?? ''),
    proposedText,
    diff: lineDiff(existing ?? '', proposedText),
    warnings: promotionWarnings(meta, target),
  }
}

/** Persists the proposal preview so `weave idea apply` can re-check the target hash. */
export async function savePromotionProposal(root: string, proposal: PromotionProposal): Promise<string> {
  await ensureDir(projectPaths(root).ideaProposals)
  const file = proposalPath(root, proposal.ideaId)
  await atomicWriteJson(file, proposal)
  return file
}

export async function applyPromotion(
  root: string,
  ideaId: string,
  proposal: PromotionProposal,
): Promise<IdeaView> {
  if (proposal.ideaId !== ideaId) throw validationError('晋升提案与想法 id 不一致')
  const targetAbsolute = path.resolve(root, proposal.targetPath)
  assertSafeTarget(root, proposal.target, targetAbsolute)
  const actual = await fileHash(targetAbsolute).catch(error => {
    if (isMissing(error)) return null
    throw error
  })
  if ((actual ?? hashText('')) !== proposal.currentHash) {
    throw conflictError('晋升目标已变化，请重新生成 diff 后再应用')
  }
  await atomicWrite(targetAbsolute, proposal.proposedText)
  const targetHash = await fileHash(targetAbsolute)
  const idea = await recordPromotion(root, ideaId, {
    target: proposal.target,
    targetPath: proposal.targetPath,
    targetHash,
    promotedAt: new Date().toISOString(),
    approvedBy: 'author',
  })
  await recordIdeaPromotionDecision(root, {
    ideaId,
    targetPath: proposal.targetPath,
    choice: 'promote',
    reason: `author applied ${proposal.target} candidate`,
  })
  return idea
}


export async function listStaleIdeas(root: string): Promise<IdeaView[]> {
  return (await listIdeas(root, { status: 'promoted' })).filter(idea => idea.promotionState === 'stale')
}

function candidateText(idea: Idea, body: string, target: IdeaPromotionTarget): string {
  if (target === 'contract') {
    return `${JSON.stringify({
      kind: 'idea-contract-patch',
      schemaVersion: 1,
      ideaId: idea.id,
      title: idea.title,
      scope: idea.scope,
      suggested: {
        chapter: idea.scope.kind === 'chapter' ? idea.scope.ref : null,
        mayHappen: [idea.title],
        threads: idea.tags,
      },
      body: body.trim(),
      note: '候选 patch：不会自动写入正式合同；请在合同编辑器确认后再保存。',
    }, null, 2)}\n`
  }
  if (target === 'promise') {
    return `${JSON.stringify({
      kind: 'reader-promise-candidate',
      schemaVersion: 1,
      promiseId: `promise-${idea.id}`,
      title: idea.title,
      scope: idea.scope,
      tags: idea.tags,
      body: body.trim(),
      sourceIdea: idea.id,
      status: 'candidate',
      note: '候选 promise：批准仍走现有 promise/planning 流程。',
    }, null, 2)}\n`
  }
  const formal = target === 'canon' ? '设定' : target === 'plan' ? '计划' : '章纲'
  const header = [
    `# 作者想法：${idea.title}`,
    '',
    `- 来源：ideas/${idea.id}.md`,
    `- 范围：${formatIdeaScope(idea.scope)}`,
    `- 标签：${idea.tags.length ? idea.tags.join('、') : '无'}`,
    `- 状态：晋升候选，尚未批准；确认后再合并到正式${formal}。`,
    '',
  ].join('\n')
  return `${header}${body.trim()}\n`
}

function promotionWarnings(idea: Idea, target: IdeaPromotionTarget): string[] {
  const warnings: string[] = []
  if (target === 'contract' && idea.scope.kind !== 'chapter') {
    warnings.push('该想法没有绑定章号；合同候选需要作者手动指定章节。')
  }
  if (target === 'canon') {
    warnings.push('只生成 .candidate.md；正式 canon 不会自动修改。')
  }
  if (target !== 'canon') {
    warnings.push('晋升只写候选文件，批准仍走现有流程；不会写 ledger/。')
  }
  if (idea.status === 'promoted') {
    warnings.push('该想法已晋升过；重新晋升会产生新的候选，不会覆盖旧目标。')
  }
  if (idea.spoilerLevel === 'reveal') {
    warnings.push(`该想法含剧透（第 ${idea.revealAfterChapter ?? '?'} 章后开放）；进入上下文时仍按披露规则扣留。`)
  }
  return warnings
}

function relativeTarget(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function assertSafeTarget(root: string, target: IdeaPromotionTarget, absolute: string): void {
  const paths = projectPaths(root)
  if (isWithin(absolute, paths.ledger)) throw validationError('任何晋升目标都不允许写 ledger/')
  if (target === 'canon') {
    if (!isWithin(absolute, paths.canon) || !absolute.endsWith('.candidate.md')) {
      throw validationError('canon 晋升只能写 canon/*.candidate.md，不能直接改正式设定')
    }
    return
  }
  if (target === 'contract') {
    const chapters = path.join(paths.outlines, 'chapters')
    const ideas = path.join(paths.outlines, 'ideas')
    if (!isWithin(absolute, chapters) && !isWithin(absolute, ideas)) {
      throw validationError('合同晋升只能写 outlines/chapters/ 或 outlines/ideas/ 下的候选文件')
    }
    if (isWithin(absolute, chapters) && !path.basename(absolute).includes('.idea-')) {
      throw validationError('合同候选文件名必须包含 .idea-，避免覆盖正式合同')
    }
    return
  }
  if (target === 'outline') {
    if (!isWithin(absolute, path.join(paths.outlines, 'ideas'))) {
      throw validationError('章纲晋升只能写 outlines/ideas/ 下的候选文件')
    }
    return
  }
  if (!isWithin(absolute, path.join(paths.plans, 'idea-promotions'))) {
    throw validationError('计划/promise 晋升只能写 plans/idea-promotions/ 下的候选文件')
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function lineDiff(before: string, after: string): string {
  const left = before.split('\n')
  const right = after.split('\n')
  const lines: string[] = []
  let b = 0
  let a = 0
  for (const match of [...lcsMatches(left, right), { before: left.length, after: right.length }]) {
    for (const line of left.slice(b, match.before)) lines.push(`-${line}`)
    for (const line of right.slice(a, match.after)) lines.push(`+${line}`)
    if (match.before < left.length) lines.push(` ${left[match.before]}`)
    b = match.before + 1
    a = match.after + 1
  }
  return lines.join('\n')
}
