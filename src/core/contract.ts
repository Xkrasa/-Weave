import path from 'node:path'
import type { ChapterContract, CharacterRecord, CharacterRegistry, LedgerBelief } from './types.ts'
import { atomicWriteJson, fileHash, listFiles, readJsonIfExists } from './io.ts'
import { objectHash } from './hash.ts'
import { projectPaths } from './project.ts'
import { validationError } from './errors.ts'

export interface ContractCheckError {
  code: string
  field?: string
  message: string
}

export interface ContractCheckRecord {
  contractHash: string
  canonHash: string
  readerPromiseHash?: string
  ok: boolean
  errors: ContractCheckError[]
  checkedAt: string
}

export function chapterFileStem(chapter: number): string {
  return String(chapter).padStart(3, '0')
}

export function contractPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).outlines, 'chapters', `${chapterFileStem(chapter)}.json`)
}

export function checkPath(root: string, chapter: number): string {
  return path.join(projectPaths(root).checks, `${chapterFileStem(chapter)}.json`)
}

export function normalizeContract(input: unknown): ChapterContract {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('章节合同必须是 JSON 对象')
  }
  const raw = input as Record<string, unknown>
  const chapter = Number(raw.chapter)
  const contract: ChapterContract = {
    chapter,
    title: stringField(raw.title),
    pov: stringField(raw.pov),
    time: stringField(raw.time),
    location: stringField(raw.location),
    openingState: stringField(raw.openingState),
    endingState: stringField(raw.endingState),
    goal: stringField(raw.goal),
    mustHappen: stringArray(raw.mustHappen),
    mayHappen: stringArray(raw.mayHappen),
    mustNotHappen: stringArray(raw.mustNotHappen),
    characters: stringArray(raw.characters),
    threads: stringArray(raw.threads),
    targetWords: Number(raw.targetWords),
    previousLink: stringField(raw.previousLink),
    nextLink: stringField(raw.nextLink),
  }
  if (typeof raw.obstacle === 'string' && raw.obstacle.trim()) contract.obstacle = raw.obstacle.trim()
  if (raw.narrativeMode !== undefined && raw.narrativeMode !== 'limited' && raw.narrativeMode !== 'omniscient') {
    throw validationError('narrativeMode 必须是 limited 或 omniscient')
  }
  contract.narrativeMode = raw.narrativeMode === 'omniscient' ? 'omniscient' : 'limited'
  contract.importance = raw.importance === 'key' ? 'key' : 'normal'
  if (Array.isArray(raw.keyFocus)) contract.keyFocus = stringArray(raw.keyFocus)
  if (Array.isArray(raw.visibleKnowledge)) {
    contract.visibleKnowledge = stringArray(raw.visibleKnowledge)
  }
  if (Array.isArray(raw.sceneTypes)) contract.sceneTypes = stringArray(raw.sceneTypes)
  if (Array.isArray(raw.knowledge)) {
    contract.knowledge = raw.knowledge
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const entry = item as Record<string, unknown>
        return { character: stringField(entry.character), fact: stringField(entry.fact) }
      })
  }
  if (raw.readerIntent !== undefined) {
    if (!raw.readerIntent || typeof raw.readerIntent !== 'object' || Array.isArray(raw.readerIntent)) {
      throw validationError('readerIntent 必须是 JSON 对象')
    }
    const intent = raw.readerIntent as Record<string, unknown>
    const purpose = stringField(intent.purpose)
    const payoff = stringField(intent.payoff)
    if (!purpose) throw validationError('readerIntent.purpose 不能为空')
    if (!payoff) throw validationError('readerIntent.payoff 不能为空')
    const intensity = intent.intensity
    if (intensity !== undefined && intensity !== 'strong' && intensity !== 'medium' && intensity !== 'soft') {
      throw validationError('readerIntent.intensity 必须是 strong、medium 或 soft')
    }
    const hook = intent.hook === undefined ? undefined : stringField(intent.hook)
    if (intent.hook !== undefined && !hook) throw validationError('readerIntent.hook 不能为空')
    const promiseIds = intent.promiseIds === undefined ? undefined : stringArray(intent.promiseIds)
    const payoffPromiseIds = intent.payoffPromiseIds === undefined ? undefined : stringArray(intent.payoffPromiseIds)
    contract.readerIntent = {
      purpose,
      payoff,
      ...(intensity ? { intensity } : {}),
      ...(hook ? { hook } : {}),
      ...(promiseIds ? { promiseIds } : {}),
      ...(payoffPromiseIds ? { payoffPromiseIds } : {}),
    }
  }
  if (raw.volume !== undefined) contract.volume = Number(raw.volume)
  return contract
}

export async function loadContract(root: string, chapter: number): Promise<ChapterContract> {
  const target = contractPath(root, chapter)
  const raw = await readJsonIfExists<unknown>(target)
  if (raw === null) throw validationError(`第 ${chapter} 章合同不存在：${target}`)
  const contract = normalizeContract(raw)
  if (contract.chapter !== chapter) {
    throw validationError(`合同章号不一致：文件为第 ${chapter} 章，内容为第 ${contract.chapter} 章`)
  }
  return contract
}

export async function saveContract(root: string, contract: ChapterContract): Promise<string> {
  const target = contractPath(root, contract.chapter)
  await atomicWriteJson(target, contract)
  return target
}

export async function loadCharacters(root: string): Promise<CharacterRegistry> {
  const target = path.join(projectPaths(root).canon, 'characters.json')
  return (await readJsonIfExists<CharacterRegistry>(target)) ?? { characters: [] }
}

export function validateContract(
  contract: ChapterContract,
  registry: CharacterRegistry,
  beliefs: LedgerBelief[] = [],
): ContractCheckError[] {
  const errors: ContractCheckError[] = []
  const requiredStrings: Array<[keyof ChapterContract, string]> = [
    ['title', 'title'],
    ['pov', 'pov'],
    ['time', 'time'],
    ['location', 'location'],
    ['openingState', 'openingState'],
    ['endingState', 'endingState'],
    ['goal', 'goal'],
    ['obstacle', 'obstacle'],
    ['previousLink', 'previousLink'],
    ['nextLink', 'nextLink'],
  ]

  if (!Number.isSafeInteger(contract.chapter) || contract.chapter <= 0) {
    errors.push({ code: 'INVALID_CHAPTER', field: 'chapter', message: 'chapter 必须是正整数' })
  }
  if (contract.volume !== undefined && (!Number.isSafeInteger(contract.volume) || contract.volume <= 0)) {
    errors.push({ code: 'INVALID_VOLUME', field: 'volume', message: '卷号必须是正整数' })
  }
  if (!Number.isSafeInteger(contract.targetWords) || contract.targetWords <= 0) {
    errors.push({ code: 'INVALID_TARGET_WORDS', field: 'targetWords', message: 'targetWords 必须是正整数' })
  }
  if (contract.narrativeMode === 'omniscient' && (contract.visibleKnowledge ?? []).length === 0) {
    errors.push({
      code: 'OMNISCIENT_WITHOUT_VISIBLE_KNOWLEDGE',
      field: 'visibleKnowledge',
      message: '全知视角必须显式列出 visibleKnowledge',
    })
  }
  for (const [field] of requiredStrings) {
    const value = contract[field]
    if (typeof value !== 'string' || !value.trim()) {
      errors.push({ code: 'MISSING_FIELD', field, message: `${field} 不能为空` })
    }
  }
  if (contract.mustHappen.length === 0) {
    errors.push({ code: 'MISSING_MUST_HAPPEN', field: 'mustHappen', message: 'mustHappen 至少需要一项' })
  }
  if (contract.characters.length === 0) {
    errors.push({ code: 'MISSING_CHARACTERS', field: 'characters', message: 'characters 至少需要一项' })
  }
  for (const focus of contract.keyFocus ?? []) {
    if (!['opening', 'choice', 'climax', 'ending'].includes(focus)) {
      errors.push({
        code: 'INVALID_KEY_FOCUS',
        field: 'keyFocus',
        message: `未知的关键段落焦点：${focus}（可选 opening/choice/climax/ending）`,
      })
    }
  }

  const registryByName = new Map(registry.characters.map(character => [character.name, character]))
  for (const name of contract.characters) {
    const character = registryByName.get(name)
    if (!character) {
      errors.push({ code: 'UNKNOWN_CHARACTER', field: 'characters', message: `人物“${name}”不在 canon/characters.json 中` })
      continue
    }
    checkCharacterAvailability(character, contract.chapter, name, errors)
  }
  const pov = registryByName.get(contract.pov)
  if (!pov) {
    errors.push({ code: 'UNKNOWN_POV', field: 'pov', message: `视角人物“${contract.pov}”不在人物表中` })
  } else {
    checkCharacterAvailability(pov, contract.chapter, contract.pov, errors)
  }

  for (const use of contract.knowledge ?? []) {
    const character = registryByName.get(use.character)
    if (!character) {
      errors.push({ code: 'UNKNOWN_KNOWLEDGE_CHARACTER', field: 'knowledge', message: `信息边界引用了未知人物“${use.character}”` })
      continue
    }
    const known = (character.knows ?? []).find(item => item.fact === use.fact)
    const learned = beliefs.some(belief =>
      belief.characterId === use.character
      && (belief.attitude === 'knows' || belief.attitude === 'believes')
      && belief.proposition.replace(/\s+/g, '') === use.fact.replace(/\s+/g, '')
      && belief.validFromChapter <= contract.chapter
      && (belief.validToChapter === null || belief.validToChapter > contract.chapter),
    )
    if (!known && !learned) {
      errors.push({
        code: 'UNKNOWN_KNOWLEDGE',
        field: 'knowledge',
        message: `人物“${use.character}”尚未获知“${use.fact}”`,
      })
    } else if (known && known.fromChapter > contract.chapter) {
      errors.push({
        code: 'FUTURE_KNOWLEDGE',
        field: 'knowledge',
        message: `人物“${use.character}”要到第 ${known.fromChapter} 章才知道“${use.fact}”`,
      })
    }
  }

  return errors
}

function checkCharacterAvailability(
  character: CharacterRecord,
  chapter: number,
  name: string,
  errors: ContractCheckError[],
): void {
  if (character.introducedIn > chapter) {
    errors.push({
      code: 'NOT_INTRODUCED',
      field: 'characters',
      message: `人物“${name}”计划到第 ${character.introducedIn} 章才登场`,
    })
  }
  if (character.status === 'dead') {
    if (character.deathChapter === undefined) {
      errors.push({
        code: 'DEATH_CHAPTER_MISSING',
        field: 'characters',
        message: `人物“${name}”已标记死亡，但缺少 deathChapter`,
      })
    } else if (chapter > character.deathChapter) {
      errors.push({
        code: 'DEAD_CHARACTER',
        field: 'characters',
        message: `人物“${name}”已于第 ${character.deathChapter} 章死亡，不能出现在第 ${chapter} 章`,
      })
    }
  }
}

export function contractHash(contract: ChapterContract): string {
  return objectHash(contract)
}

export async function canonSnapshotHash(root: string): Promise<string> {
  const dir = projectPaths(root).canon
  const files = await listFiles(dir)
  const entries: Array<[string, string]> = []
  for (const name of files) {
    entries.push([name, await fileHash(path.join(dir, name))])
  }
  return objectHash(entries)
}

export async function writeContractCheck(root: string, contract: ChapterContract): Promise<ContractCheckRecord> {
  const registry = await loadCharacters(root)
  const { collectLedger } = await import('./story-ledger.ts')
  const ledger = await collectLedger(root, contract.chapter)
  const errors = validateContract(contract, registry, ledger.beliefs)
  const { validateReaderPromiseReferences, readerPromiseCheckHash } = await import('./reader-promises.ts')
  errors.push(...await validateReaderPromiseReferences(root, contract))
  const record: ContractCheckRecord = {
    contractHash: contractHash(contract),
    canonHash: await canonSnapshotHash(root),
    readerPromiseHash: await readerPromiseCheckHash(root),
    ok: errors.length === 0,
    errors,
    checkedAt: new Date().toISOString(),
  }
  await atomicWriteJson(checkPath(root, contract.chapter), record)
  return record
}

export async function requirePassingContractCheck(root: string, contract: ChapterContract): Promise<void> {
  const record = await readJsonIfExists<ContractCheckRecord>(checkPath(root, contract.chapter))
  const currentHash = contractHash(contract)
  if (!record) {
    throw validationError(`第 ${contract.chapter} 章合同尚未通过检查；请先执行 weave contract check ${contract.chapter}`)
  }
  if (record.contractHash !== currentHash) {
    throw validationError(`第 ${contract.chapter} 章合同在检查后已修改；请重新执行 weave contract check ${contract.chapter}`)
  }
  if (record.canonHash !== (await canonSnapshotHash(root))) {
    throw validationError(`设定在合同检查后已修改；请重新执行 weave contract check ${contract.chapter}`)
  }
  const { readerPromiseCheckHash, readReaderPromiseBook } = await import('./reader-promises.ts')
  const currentPromiseHash = await readerPromiseCheckHash(root)
  if (record.readerPromiseHash !== undefined && record.readerPromiseHash !== currentPromiseHash) {
    throw validationError(`ReaderPromise 在合同检查后已批准、修改或废弃；请重新执行 weave contract check ${contract.chapter}`)
  }
  if (record.readerPromiseHash === undefined && (await readReaderPromiseBook(root)).status !== 'missing') {
    throw validationError(`ReaderPromise 在旧合同检查后才引入；请重新执行 weave contract check ${contract.chapter}`)
  }
  if (!record.ok) {
    throw validationError(`第 ${contract.chapter} 章合同检查未通过`, record.errors)
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}
