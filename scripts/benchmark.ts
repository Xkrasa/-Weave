#!/usr/bin/env node
/**
 * Offline-capable effect benchmark harness.
 *
 * Two modes:
 *   --fake  deterministic scaffold prose from a local OpenAI-compatible server.
 *           Measures plumbing (materials, budgets, retrieval, latency), never literary quality.
 *   --real  runs the same pipeline against the configured model. Required for any
 *           claim about how a chapter reads.
 *
 * Usage:
 *   node scripts/benchmark.ts run --suite craft|longitudinal|all [--seed <id>] [--config baseline]
 *                                 [--ablation retrieval=off] [--strategy prose-first|beat-first] [--mode fake|real]
 *                                 [--base-url <url>] [--model <id>] [--out <dir>]
 *   node scripts/benchmark.ts pairs --a <runDir> --b <runDir> [--out <dir>]
 *   node scripts/benchmark.ts score --pairs <pairs.json> --scores <scores.jsonl>
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts')
const SEED_DIR = path.join(REPO_ROOT, 'bench', 'seeds')

interface SeedCharacter {
  name: string
  status?: 'alive' | 'dead'
  introducedIn?: number
  deathChapter?: number
}

interface SeedChapter {
  chapter: number
  title: string
  pov: string
  time: string
  location: string
  openingState: string
  endingState: string
  goal: string
  obstacle: string
  mustHappen: string[]
  mayHappen?: string[]
  mustNotHappen?: string[]
  characters: string[]
  threads: string[]
  targetWords: number
  previousLink: string
  nextLink: string
  readerIntent?: {
    purpose: string
    payoff: string
    intensity?: 'strong' | 'medium' | 'soft'
    hook?: string
  }
}

interface SeedEvaluation {
  focus: string[]
  materialPolicy: string
  holdout: boolean
}

interface Seed {
  id: string
  kind: 'craft' | 'longitudinal'
  title: string
  genre: string
  audience: string
  platform?: 'fanqie' | 'qidian' | 'generic'
  evaluation?: SeedEvaluation
  promise: string
  premise: string
  world: string
  style: string
  prohibitions?: string[]
  characters: SeedCharacter[]
  chapters: SeedChapter[]
  authorSamples?: Array<{ fileName: string; frontmatter?: string; text: string }>
  /** Synthesized chapters before the measured ones (longitudinal only). */
  priorChapters?: number
  priorBeats?: string[]
  /** Evidence a retrieval-aware chapter should be able to recall. */
  recallExpectations?: Array<{ chapter: number; terms: string[]; why: string }>
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
  elapsedMs: number
}

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const [key, inline] = token.slice(2).split('=', 2)
    if (!key) continue
    if (inline !== undefined) {
      flags[key] = inline
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return { positionals, flags }
}

function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, elapsedMs: Date.now() - startedAt }))
  })
}

function errorText(result: CliResult): string {
  try {
    const payload = parseJson<{ error?: { message?: string } }>(result.stdout)
    if (payload.error?.message) return payload.error.message
  } catch {
    // Fall through to raw output.
  }
  return (result.stderr || result.stdout).trim().slice(0, 500)
}

function parseJson<T>(stdout: string): T {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`no JSON in output: ${stdout.slice(0, 400)}`)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

/** Deterministic scaffold prose: exercises the pipeline, never claims to read well. */
function scaffoldProse(seed: Seed, chapter: SeedChapter, salt: string): string {
  const beats = [
    chapter.openingState,
    chapter.goal ? `她只想要一件事：${chapter.goal}。` : '',
    chapter.obstacle ? `阻挡她的是${chapter.obstacle}。` : '',
    ...chapter.mustHappen.map(item => `然后，${item}。`),
    chapter.mayHappen?.[0] ? `中途${chapter.mayHappen[0]}。` : '',
    chapter.endingState,
  ].filter(Boolean)
  const lines = [`第${chapter.chapter}章 ${chapter.title}`, '', ...beats.map(line => `${line}\n`)]
  const filler = [
    `港口的雾压得很低，${salt}把远处的灯拉成一条细线。`,
    `她没有立刻回答，只把手里的东西按在桌沿，指节发白。`,
    `对方看着她，像在等一个更省事的答案。`,
    `风从门缝里钻进来，纸页翻了一下，又停住。`,
  ]
  let characters = [...lines.join('\n')].length
  let index = 0
  while (characters < Math.max(1200, Math.floor(chapter.targetWords * 0.8))) {
    const sentence = `${filler[index % filler.length]}\n\n`
    lines.push(sentence)
    characters += [...sentence].length
    index += 1
  }
  return `${lines.join('\n').trim()}\n`
}

class FakeModel {
  private readonly server: Server
  private readonly seed: Seed
  private readonly salt: string
  private readonly requests: Array<Record<string, unknown>> = []
  baseUrl = ''

  constructor(seed: Seed, salt: string) {
    this.seed = seed
    this.salt = salt
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('fake model failed to bind')
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private async handle(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = {}
    }
    this.requests.push(body)
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
    const user = String(messages.find(message => message.role === 'user')?.content ?? '')
    const chapter = this.chapterFromPrompt(user)
    const prose = JSON.stringify(messages).includes('场景节拍规划器')
      ? JSON.stringify({ beats: [{
          goal: chapter.goal,
          obstacle: chapter.obstacle,
          turn: '行动获得新的证据或代价',
          infoRelease: '本章只释放合同允许的信息',
          emotionalLanding: '人物根据新局势作出选择',
          endingState: chapter.endingState,
        }] })
      : scaffoldProse(this.seed, chapter, this.salt)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const pieces = splitForStream(prose)
    for (const piece of pieces) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: {} }],
      usage: {
        prompt_tokens: Math.ceil(user.length / 1.6),
        completion_tokens: Math.ceil(prose.length / 1.6),
        total_tokens: Math.ceil((user.length + prose.length) / 1.6),
      },
    })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  }

  private chapterFromPrompt(prompt: string): SeedChapter {
    for (const chapter of this.seed.chapters) {
      if (prompt.includes(`"chapter": ${chapter.chapter}`)) return chapter
    }
    return this.seed.chapters[this.seed.chapters.length - 1]!
  }
}

function splitForStream(text: string): string[] {
  const pieces: string[] = []
  const size = 240
  const characters = [...text]
  for (let index = 0; index < characters.length; index += size) {
    pieces.push(characters.slice(index, index + size).join(''))
  }
  return pieces
}

async function loadSeeds(suite: string): Promise<Seed[]> {
  const seeds: Seed[] = []
  for (const name of await readdir(SEED_DIR).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const seed = JSON.parse(await readFile(path.join(SEED_DIR, name), 'utf8')) as Seed
    if (suite === 'all' || seed.kind === suite) seeds.push(seed)
  }
  return seeds.sort((a, b) => a.id.localeCompare(b.id))
}

function canonMarkdown(seed: Seed): { premise: string; world: string; style: string; prohibitions: string } {
  const cast = seed.characters
    .map(character => `- ${character.name}（第 ${character.introducedIn ?? 1} 章登场）`)
    .join('\n')
  return {
    premise: [
      `# ${seed.title}`,
      '',
      `题材：${seed.genre}；目标读者：${seed.audience}`,
      '',
      `核心承诺：${seed.promise}`,
      '',
      seed.premise,
      '',
      '## 人物',
      cast,
    ].join('\n'),
    world: seed.world,
    style: seed.style,
    prohibitions: (seed.prohibitions ?? []).join('\n'),
  }
}

function contractJson(chapter: SeedChapter, options: { readerIntentOff?: boolean } = {}): Record<string, unknown> {
  return {
    chapter: chapter.chapter,
    title: chapter.title,
    pov: chapter.pov,
    time: chapter.time,
    location: chapter.location,
    openingState: chapter.openingState,
    endingState: chapter.endingState,
    goal: chapter.goal,
    obstacle: chapter.obstacle,
    mustHappen: chapter.mustHappen,
    mayHappen: chapter.mayHappen ?? [],
    mustNotHappen: chapter.mustNotHappen ?? [],
    characters: chapter.characters,
    threads: chapter.threads,
    targetWords: chapter.targetWords,
    previousLink: chapter.previousLink,
    nextLink: chapter.nextLink,
    ...(chapter.readerIntent && !options.readerIntentOff ? { readerIntent: chapter.readerIntent } : {}),
  }
}

interface ChapterRecord {
  chapter: number
  mode: 'generated' | 'synthesized'
  draftPath: string
  characters: number
  estimatedTokens?: number
  included?: string[]
  omitted?: Array<{ sourceId: string; reason: string }>
  usage?: Record<string, number>
  elapsedMs: number
  exitCode: number
  retried?: boolean
}

interface SeedRun {
  seed: string
  kind: Seed['kind']
  platform?: Seed['platform']
  evaluation?: SeedEvaluation
  draftingStrategy: 'prose-first' | 'beat-first'
  config: string
  ablations: Record<string, string>
  mode: 'fake' | 'real'
  model: string
  projectDir: string
  chapters: ChapterRecord[]
  recall?: Array<{
    chapter: number
    terms: string[]
    why: string
    matched: string[]
    missed: string[]
  }>
  durations: { writeMs: number; totalMs: number; planningMs: number }
  errors: string[]
}

async function writeCanon(dir: string, seed: Seed): Promise<void> {
  const canon = canonMarkdown(seed)
  await writeFile(path.join(dir, 'canon', 'premise.md'), `${canon.premise}\n`)
  await writeFile(path.join(dir, 'canon', 'world.md'), `${canon.world}\n`)
  await writeFile(path.join(dir, 'canon', 'style.md'), `${canon.style}\n`)
  await writeFile(path.join(dir, 'canon', 'prohibitions.md'), `${canon.prohibitions}\n`)
  await writeFile(
    path.join(dir, 'canon', 'characters.json'),
    `${JSON.stringify({
      characters: seed.characters.map(character => ({
        name: character.name,
        status: character.status ?? 'alive',
        introducedIn: character.introducedIn ?? 1,
        ...(character.deathChapter === undefined ? {} : { deathChapter: character.deathChapter }),
      })),
    }, null, 2)}\n`,
  )
  for (const sample of seed.authorSamples ?? []) {
    const target = path.join(dir, 'canon', 'samples', sample.fileName)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `${sample.frontmatter ? `---\n${sample.frontmatter}\n---\n` : ''}${sample.text}\n`)
  }
}

async function writeContract(dir: string, chapter: SeedChapter, options: { readerIntentOff?: boolean } = {}): Promise<void> {
  await writeFile(
    path.join(dir, 'outlines', 'chapters', `${String(chapter.chapter).padStart(3, '0')}.json`),
    `${JSON.stringify(contractJson(chapter, options), null, 2)}\n`,
  )
}

/** Long-form seeds always exercise the same pipeline; scaffolding keeps runs offline and fast. */
function synthesizedPrior(seed: Seed, chapter: number): string {
  const beats = seed.priorBeats ?? [seed.promise]
  const beat = beats[(chapter - 1) % Math.max(1, beats.length)]
  const lines = [`第${chapter}章 前情${chapter}`, '', `${beat}`]
  let characters = [...lines.join('\n')].length
  let index = 0
  const filler = [
    `她把当天的记录折好，塞回铁盒。`,
    `街上的灯一盏一盏亮起来，潮气贴着墙根走。`,
    `有人敲门，又走了。`,
  ]
  while (characters < 1400) {
    const sentence = `${filler[index % filler.length]}\n\n`
    lines.push(sentence)
    characters += [...sentence].length
    index += 1
  }
  return `${lines.join('\n').trim()}\n`
}

function priorContract(seed: Seed, chapter: number): Record<string, unknown> {
  const character = seed.characters[0]!
  return {
    chapter,
    title: `前情${chapter}`,
    pov: character.name,
    time: `第 ${chapter} 天`,
    location: '旧城',
    openingState: '天色将晚',
    endingState: '她把记录收起',
    goal: '记录当天发生的事',
    obstacle: '线索零散',
    mustHappen: ['她把当天的记录写下来'],
    mayHappen: [],
    mustNotHappen: [],
    characters: [character.name],
    threads: ['主线'],
    targetWords: 1400,
    previousLink: chapter === 1 ? '开篇' : '承接前章',
    nextLink: '继续',
  }
}

async function runSeed(
  seed: Seed,
  options: {
    outDir: string
    config: string
    ablations: Record<string, string>
    mode: 'fake' | 'real'
    baseUrl: string
    model: string
    apiKey: string
    timeoutMs?: number
    maxOutputTokens?: number
    renderer?: 'json' | 'mission'
    draftingStrategy: 'prose-first' | 'beat-first'
  },
): Promise<SeedRun> {
  const startedAt = Date.now()
  const projectDir = path.join(options.outDir, seed.id)
  await mkdir(projectDir, { recursive: true })
  const errors: string[] = []
  const record: SeedRun = {
    seed: seed.id,
    kind: seed.kind,
    platform: seed.platform ?? 'generic',
    ...(seed.evaluation ? { evaluation: seed.evaluation } : {}),
    draftingStrategy: options.draftingStrategy,
    config: options.config,
    ablations: options.ablations,
    mode: options.mode,
    model: options.model,
    projectDir,
    chapters: [],
    durations: { writeMs: 0, totalMs: 0, planningMs: 0 },
    errors,
  }

  const init = await runCli(projectDir, [
    'init', '.', '--title', seed.title, '--model', options.model,
    '--base-url', options.baseUrl, '--workflow', 'p0',
    ...(seed.platform ? ['--platform', seed.platform] : []),
  ])
  if (init.code !== 0) {
    errors.push(`init: ${init.stderr || init.stdout}`)
    record.durations.totalMs = Date.now() - startedAt
    return record
  }
  if (options.timeoutMs) {
    const configPath = path.join(projectDir, '.weave', 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    config.timeoutMs = options.timeoutMs
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  await writeCanon(projectDir, seed)
  await mkdir(path.join(projectDir, 'outlines', 'chapters'), { recursive: true })
  await writeFile(
    path.join(projectDir, '.weave', 'bench-config.json'),
    `${JSON.stringify({ config: options.config, ablations: options.ablations }, null, 2)}\n`,
  )

  const priorChapters = seed.kind === 'longitudinal' ? seed.priorChapters ?? 0 : 0
  for (let chapter = 1; chapter <= priorChapters; chapter += 1) {
    await writeFile(
      path.join(projectDir, 'outlines', 'chapters', `${String(chapter).padStart(3, '0')}.json`),
      `${JSON.stringify(priorContract(seed, chapter), null, 2)}\n`,
    )
    const check = await runCli(projectDir, ['contract', 'check', String(chapter), '--json'])
    if (check.code !== 0) errors.push(`prior contract ${chapter}: ${check.stdout}${check.stderr}`)
    await writeFile(
      path.join(projectDir, 'chapters', 'drafts', `${String(chapter).padStart(3, '0')}.md`),
      synthesizedPrior(seed, chapter),
    )
    const finalized = await runCli(projectDir, ['finalize', String(chapter), '--json'])
    if (finalized.code !== 0) errors.push(`prior finalize ${chapter}: ${finalized.stdout}${finalized.stderr}`)
  }

  const env: Record<string, string> = {
    ...(options.apiKey ? { WEAVE_API_KEY: options.apiKey } : {}),
    ...(options.renderer ? { WEAVE_PROMPT_RENDERER: options.renderer } : {}),
  }
  for (const chapter of seed.chapters) {
    await writeContract(projectDir, chapter, { readerIntentOff: options.ablations.readerIntent === 'off' })
    const check = await runCli(projectDir, ['contract', 'check', String(chapter.chapter), '--json'])
    if (check.code !== 0) {
      errors.push(`contract ${chapter.chapter}: ${check.stdout}${check.stderr}`)
      record.chapters.push({
        chapter: chapter.chapter, mode: 'generated', draftPath: '', characters: 0,
        elapsedMs: check.elapsedMs, exitCode: check.code,
      })
      continue
    }
    if (options.draftingStrategy === 'beat-first') {
      const generated = await runCli(projectDir, ['beats', 'generate', String(chapter.chapter), '--json'], env)
      const approved = generated.code === 0
        ? await runCli(projectDir, ['beats', 'approve', String(chapter.chapter), '--benchmark', '--json'], env)
        : null
      record.durations.planningMs += generated.elapsedMs + (approved?.elapsedMs ?? 0)
      if (generated.code !== 0 || approved?.code !== 0) {
        const failed = generated.code !== 0 ? generated : approved!
        errors.push(`beats ${chapter.chapter}: ${errorText(failed)}`)
        record.chapters.push({
          chapter: chapter.chapter, mode: 'generated', draftPath: '', characters: 0,
          elapsedMs: generated.elapsedMs + (approved?.elapsedMs ?? 0), exitCode: failed.code,
        })
        continue
      }
    }
    const writeArgs = ['write', String(chapter.chapter), '--json', '--strategy', options.draftingStrategy]
    if (options.ablations.authorSamples) writeArgs.push('--author-samples', options.ablations.authorSamples)
    let write = await runCli(projectDir, writeArgs, env)
    record.durations.writeMs += write.elapsedMs
    let retried = false
    if (write.code === 5 && options.mode === 'real') {
      // A stalled stream is not transparently retried by the CLI; the harness retries as a fresh run.
      retried = true
      write = await runCli(projectDir, writeArgs, env)
      record.durations.writeMs += write.elapsedMs
    }
    if (write.code !== 0) {
      errors.push(`write ${chapter.chapter}: ${errorText(write)}`)
      record.chapters.push({
        chapter: chapter.chapter, mode: 'generated', draftPath: '', characters: 0,
        elapsedMs: write.elapsedMs, exitCode: write.code, ...(retried ? { retried } : {}),
      })
      continue
    }
    let payload: Record<string, unknown> = {}
    try {
      payload = parseJson<Record<string, unknown>>(write.stdout)
    } catch (error) {
      errors.push(`write ${chapter.chapter} json: ${error instanceof Error ? error.message : String(error)}`)
    }
    const draftPath = path.join(projectDir, 'chapters', 'drafts', `${String(chapter.chapter).padStart(3, '0')}.md`)
    const draft = await readFile(draftPath, 'utf8').catch(() => '')
    const included = Array.isArray(payload.included) ? payload.included as string[] : undefined
    const omitted = Array.isArray(payload.omitted)
      ? payload.omitted as Array<{ sourceId: string; reason: string }>
      : undefined
    record.chapters.push({
      chapter: chapter.chapter,
      mode: 'generated',
      draftPath: path.relative(options.outDir, draftPath).split(path.sep).join('/'),
      characters: [...draft.replace(/\s/g, '')].length,
      estimatedTokens: typeof payload.estimatedTokens === 'number' ? payload.estimatedTokens : undefined,
      included,
      omitted,
      usage: (payload.usage && typeof payload.usage === 'object') ? payload.usage as Record<string, number> : undefined,
      elapsedMs: write.elapsedMs,
      exitCode: write.code,
      ...(retried ? { retried } : {}),
    })
    if (included) {
      for (const expectation of seed.recallExpectations ?? []) {
        if (expectation.chapter !== chapter.chapter) continue
        const matched = expectation.terms.filter(term => included.some(source => source.includes(term)))
        const missed = expectation.terms.filter(term => !matched.includes(term))
        record.recall ??= []
        record.recall.push({ ...expectation, matched, missed })
      }
    }
    const finalized = await runCli(projectDir, ['finalize', String(chapter.chapter), '--json'])
    if (finalized.code !== 0) errors.push(`finalize ${chapter.chapter}: ${finalized.stdout}${finalized.stderr}`)
  }

  record.durations.totalMs = Date.now() - startedAt
  return record
}

async function commandRun(flags: Record<string, string | true>): Promise<number> {
  const suite = flagString(flags, 'suite') ?? 'craft'
  const seedFilter = flagString(flags, 'seed')
  const config = flagString(flags, 'config') ?? 'baseline'
  const mode = (flagString(flags, 'mode') ?? 'fake') as 'fake' | 'real'
  const timeoutMs = flagString(flags, 'timeout-ms') ? Number(flagString(flags, 'timeout-ms')) : undefined
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)) {
    throw new Error('--timeout-ms must be an integer >= 1000')
  }
  const rendererRaw = flagString(flags, 'prompt-renderer')
  if (rendererRaw && rendererRaw !== 'json' && rendererRaw !== 'mission') {
    throw new Error('--prompt-renderer must be json or mission')
  }
  const renderer = rendererRaw as 'json' | 'mission' | undefined
  const strategyRaw = flagString(flags, 'strategy') ?? 'prose-first'
  if (strategyRaw !== 'prose-first' && strategyRaw !== 'beat-first') throw new Error('--strategy must be prose-first or beat-first')
  const draftingStrategy = strategyRaw as 'prose-first' | 'beat-first'
  const maxOutputTokens = flagString(flags, 'max-output') ? Number(flagString(flags, 'max-output')) : undefined
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256)) {
    throw new Error('--max-output must be an integer >= 256')
  }
  const model = flagString(flags, 'model') ?? (mode === 'fake' ? 'fake-bench' : 'gpt-4o-mini')
  const ablations: Record<string, string> = {}
  for (const [key, value] of Object.entries(flags)) {
    if (!key.startsWith('ablation.')) continue
    ablations[key.slice('ablation.'.length)] = String(value)
  }
  if (ablations.readerIntent && ablations.readerIntent !== 'off') {
    throw new Error('--ablation.readerIntent only supports off')
  }
  if (ablations.authorSamples && !['scene', 'legacy', 'off'].includes(ablations.authorSamples)) {
    throw new Error('--ablation.authorSamples must be scene, legacy or off')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.resolve(flagString(flags, 'out') ?? path.join(REPO_ROOT, 'bench', 'runs', `${stamp}-${config}`))
  await mkdir(outDir, { recursive: true })

  let seeds = await loadSeeds(suite)
  if (seedFilter) seeds = seeds.filter(seed => seed.id === seedFilter)
  if (seeds.length === 0) throw new Error(`no seeds matched suite=${suite}${seedFilter ? ` seed=${seedFilter}` : ''}`)

  const fakeModels = new Map<string, FakeModel>()
  let baseUrl = flagString(flags, 'base-url') ?? ''
  const apiKey = process.env.WEAVE_API_KEY ?? ''
  if (mode === 'fake') {
    for (const seed of seeds) {
      const fake = new FakeModel(seed, config)
      await fake.start()
      fakeModels.set(seed.id, fake)
      if (!baseUrl) baseUrl = fake.baseUrl
    }
  }
  if (!baseUrl) throw new Error('real mode requires --base-url or WEAVE_API_KEY + configured endpoint')

  const runs: SeedRun[] = []
  try {
    for (const seed of seeds) {
      const seedBase = mode === 'fake' ? fakeModels.get(seed.id)!.baseUrl : baseUrl
      const run = await runSeed(seed, {
        outDir, config, ablations, mode, baseUrl: seedBase, model, apiKey, timeoutMs, maxOutputTokens, renderer, draftingStrategy,
      })
      runs.push(run)
      await writeFile(path.join(outDir, `${seed.id}.run.json`), `${JSON.stringify(run, null, 2)}\n`)
    }
  } finally {
    for (const fake of fakeModels.values()) await fake.stop()
  }

  const report = buildReport(runs, { suite, config, ablations, mode, model, draftingStrategy })
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(outDir, 'report.md'), renderReport(report))
  console.log(JSON.stringify({
    ok: report.ok,
    mode,
    suite,
    seeds: runs.length,
    chapters: runs.reduce((sum, run) => sum + run.chapters.length, 0),
    outDir,
    note: mode === 'fake' ? 'fake mode measures plumbing only; it cannot support literary claims' : 'real mode: retain raw outputs before judging',
  }, null, 2))
  return report.ok ? 0 : 1
}

interface BenchReport {
  ok: boolean
  suite: string
  config: string
  ablations: Record<string, string>
  mode: 'fake' | 'real'
  model: string
  draftingStrategy: 'prose-first' | 'beat-first'
  createdAt: string
  note: string
  totals: { seeds: number; chapters: number; writeMs: number; totalMs: number; planningMs: number; characters: number }
  recall: { expectations: number; matchedTerms: number; missedTerms: number }
  seeds: Array<{
    seed: string
    kind: Seed['kind']
    platform?: Seed['platform']
    evaluation?: SeedEvaluation
    chapters: number
    writeMs: number
    totalMs: number
    planningMs: number
    characters: number
    estimatedTokens: number
    omitted: number
    errors: number
    retried: number
    recallMissed: string[]
  }>
  errors: Array<{ seed: string; error: string }>
}

function buildReport(
  runs: SeedRun[],
  meta: { suite: string; config: string; ablations: Record<string, string>; mode: 'fake' | 'real'; model: string; draftingStrategy: 'prose-first' | 'beat-first' },
): BenchReport {
  const errors = runs.flatMap(run => run.errors.map(error => ({ seed: run.seed, error })))
  const recall = runs.flatMap(run => run.recall ?? [])
  const expectations = recall.length
  const matchedTerms = recall.reduce((sum, item) => sum + item.matched.length, 0)
  const missedTerms = recall.reduce((sum, item) => sum + item.missed.length, 0)
  return {
    ok: errors.length === 0,
    suite: meta.suite,
    config: meta.config,
    ablations: meta.ablations,
    mode: meta.mode,
    model: meta.model,
    draftingStrategy: meta.draftingStrategy,
    createdAt: new Date().toISOString(),
    note: meta.mode === 'fake'
      ? 'Fake mode: deterministic scaffold prose. Measures plumbing only, never literary quality.'
      : 'Real mode: compare anonymized pairs; do not accept LLM self-scores as the only evidence.',
    totals: {
      seeds: runs.length,
      chapters: runs.reduce((sum, run) => sum + run.chapters.length, 0),
      writeMs: runs.reduce((sum, run) => sum + run.durations.writeMs, 0),
      totalMs: runs.reduce((sum, run) => sum + run.durations.totalMs, 0),
      planningMs: runs.reduce((sum, run) => sum + run.durations.planningMs, 0),
      characters: runs.reduce((sum, run) => sum + run.chapters.reduce((inner, item) => inner + item.characters, 0), 0),
    },
    recall: { expectations, matchedTerms, missedTerms },
    seeds: runs.map(run => ({
      seed: run.seed,
      kind: run.kind,
      platform: run.platform ?? 'generic',
      ...(run.evaluation ? { evaluation: run.evaluation } : {}),
      chapters: run.chapters.length,
      writeMs: run.durations.writeMs,
      totalMs: run.durations.totalMs,
      planningMs: run.durations.planningMs,
      characters: run.chapters.reduce((sum, item) => sum + item.characters, 0),
      estimatedTokens: run.chapters.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0),
      omitted: run.chapters.reduce((sum, item) => sum + (item.omitted?.length ?? 0), 0),
      errors: run.errors.length,
      retried: run.chapters.filter(item => item.retried).length,
      recallMissed: (run.recall ?? []).flatMap(item => item.missed),
    })),
    errors,
  }
}

function renderReport(report: BenchReport): string {
  const lines = [
    `# Weave benchmark — ${report.suite} / ${report.config}`,
    '',
    `- mode: **${report.mode}** · model: \`${report.model}\``,
    `- draftingStrategy: ${report.draftingStrategy}`,
    `- ablations: ${Object.keys(report.ablations).length === 0 ? 'none' : JSON.stringify(report.ablations)}`,
    `- created: ${report.createdAt}`,
    `- note: ${report.note}`,
    '',
    '## Totals',
    '',
    `- seeds: ${report.totals.seeds} · chapters: ${report.totals.chapters}`,
    `- generated characters: ${report.totals.characters}`,
    `- write time: ${report.totals.writeMs} ms · planning: ${report.totals.planningMs} ms · total: ${report.totals.totalMs} ms`,
    `- recall terms matched/missed: ${report.recall.matchedTerms}/${report.recall.missedTerms}`,
    '',
    '## Seeds',
    '',
    '| seed | platform | kind | chapters | chars | tokens | write ms | errors | retried |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.seeds.map(seed => `| ${seed.seed} | ${seed.platform ?? 'generic'} | ${seed.kind} | ${seed.chapters} | ${seed.characters} | ${seed.estimatedTokens} | ${seed.writeMs} | ${seed.errors} | ${seed.retried} |`),
    '',
  ]
  for (const seed of report.seeds.filter(item => item.evaluation)) {
    lines.push(
      `## Evaluation — ${seed.seed}`,
      '',
      `- platform: ${seed.platform ?? 'generic'} · holdout: ${seed.evaluation!.holdout}`,
      `- focus: ${seed.evaluation!.focus.join(' / ')}`,
      `- materials: ${seed.evaluation!.materialPolicy}`,
      '',
    )
  }
  if (report.errors.length > 0) {
    lines.push('## Errors', '', ...report.errors.map(error => `- ${error.seed}: ${error.error}`), '')
  }
  lines.push('## Next', '',
    report.mode === 'fake'
      ? '- Run `--mode real` with a configured model, then build pairs and collect blind scores.'
      : '- Build anonymized pairs (`benchmark pairs`), collect blind scores (`--scores`), then report win rate.',
    '',
  )
  return `${lines.join('\n')}\n`
}


/** Final prose is authoritative; drafts are cleared after finalize. */
async function chapterText(runDir: string, seed: string, chapter: number): Promise<string> {
  const stem = String(chapter).padStart(3, '0')
  const final = await readFile(path.join(runDir, seed, 'chapters', 'final', `${stem}.md`), 'utf8').catch(() => null)
  return final ?? ''
}

async function commandPairs(flags: Record<string, string | true>): Promise<number> {
  const a = flagString(flags, 'a')
  const b = flagString(flags, 'b')
  if (!a || !b) throw new Error('usage: benchmark pairs --a <runDir> --b <runDir> [--out <dir>]')
  const outDir = path.resolve(flagString(flags, 'out') ?? path.join(path.dirname(path.resolve(a)), 'pairs'))
  await mkdir(outDir, { recursive: true })
  const seeds = await readdir(a)
  const pairs: Array<Record<string, unknown>> = []
  const mapping: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const name of seeds) {
    if (!name.endsWith('.run.json')) continue
    const runA = JSON.parse(await readFile(path.join(a, name), 'utf8')) as SeedRun
    const runB = await readFile(path.join(b, name), 'utf8')
      .then(text => JSON.parse(text) as SeedRun)
      .catch(() => null)
    if (!runB) continue
    for (const chapterA of runA.chapters) {
      const chapterB = runB.chapters.find(item => item.chapter === chapterA.chapter)
      if (!chapterB) continue
      const swapped = randomInt(2) === 1
      const left = swapped ? chapterB : chapterA
      const right = swapped ? chapterA : chapterB
      const pairId = `${runA.seed}-ch${chapterA.chapter}`
      const leftText = await chapterText(a, runA.seed, chapterA.chapter)
      const rightText = await chapterText(b, runB.seed, chapterA.chapter)
      // Failed, missing or truncated chapters are not scoreable prose.
      const MIN_PAIR_CHARS = 200
      if (leftText.trim().length < MIN_PAIR_CHARS || rightText.trim().length < MIN_PAIR_CHARS) {
        skipped += 1
        continue
      }
      pairs.push({
        pairId,
        seed: runA.seed,
        chapter: chapterA.chapter,
        left: leftText,
        right: rightText,
      })
      mapping.push({ pairId, left: swapped ? 'b' : 'a', right: swapped ? 'a' : 'b' })
    }
  }
  await writeFile(path.join(outDir, 'pairs.json'), `${JSON.stringify(pairs, null, 2)}\n`)
  await writeFile(path.join(outDir, 'mapping.json'), `${JSON.stringify({ a, b, entries: mapping }, null, 2)}\n`)
  await writeFile(
    path.join(outDir, 'scores.template.jsonl'),
    `${mapping.map(entry => JSON.stringify({ pairId: entry.pairId, winner: 'left|right|tie', reader: '', note: '' })).join('\n')}\n`,
  )
  await writeFile(
    path.join(outDir, 'README.md'),
    [
      '# 盲评说明',
      '',
      '1. 打开 `pairs.json`，只看 `left` / `right`，不要看 `mapping.json`。',
      '2. 对每一对选择更愿意继续读的一版，写入 `scores.jsonl`（照抄 `scores.template.jsonl` 的格式）。',
      '3. 主要指标是“愿意继续读”；字数、剧情推进只作辅助。',
      '4. 收集完成后运行：',
      '',
      '```bash',
      'node scripts/benchmark.ts score --pairs <pairs.json> --scores <scores.jsonl>',
      '```',
      '',
      '`mapping.json` 在评分完成前不要打开；它记录左右分别属于哪次运行。',
      '',
    ].join('\n'),
  )
  console.log(JSON.stringify({ ok: true, pairs: pairs.length, skipped, outDir, note: 'mapping stays sealed until scores are collected' }, null, 2))
  return 0
}

async function commandScore(flags: Record<string, string | true>): Promise<number> {
  const pairsFile = flagString(flags, 'pairs')
  const scoresFile = flagString(flags, 'scores')
  if (!pairsFile || !scoresFile) throw new Error('usage: benchmark score --pairs <pairs.json> --scores <scores.jsonl>')
  const dir = path.dirname(path.resolve(pairsFile))
  const mapping = JSON.parse(await readFile(path.join(dir, 'mapping.json'), 'utf8')) as {
    entries: Array<{ pairId: string; left: string; right: string }>
  }
  const raw = await readFile(path.resolve(scoresFile), 'utf8')
  const scores = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as {
    pairId: string
    winner: 'left' | 'right' | 'tie'
    reader?: string
    note?: string
  })
  const byId = new Map(mapping.entries.map(entry => [entry.pairId, entry]))
  const tally = { a: 0, b: 0, tie: 0, unknown: 0 }
  // `weave eval` appends re-judgements; only the latest score per (pair, reader) counts.
  const latest = new Map<string, (typeof scores)[number]>()
  for (const score of scores) latest.set(`${score.pairId}\u0000${score.reader ?? ''}`, score)
  for (const score of latest.values()) {
    const entry = byId.get(score.pairId)
    if (!entry) { tally.unknown += 1; continue }
    if (score.winner === 'tie') { tally.tie += 1; continue }
    const side = score.winner === 'left' ? entry.left : entry.right
    if (side === 'a') tally.a += 1
    else tally.b += 1
  }
  const decided = tally.a + tally.b
  const result = {
    ok: decided > 0 || tally.tie > 0,
    pairsScored: scores.length,
    configA: mapping.entries.length > 0 ? 'a' : 'unknown',
    wins: tally,
    winRateA: decided === 0 ? null : Number((tally.a / decided).toFixed(3)),
    note: decided === 0 ? 'no decisive pairs; run more comparisons before concluding' : 'keep holdout pairs out of tuning',
  }
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

async function main(): Promise<void> {
  const [command = 'run', ...rest] = process.argv.slice(2)
  const { flags } = parseFlags(rest)
  if (command === 'run') {
    process.exitCode = await commandRun(flags)
    return
  }
  if (command === 'pairs') {
    process.exitCode = await commandPairs(flags)
    return
  }
  if (command === 'score') {
    process.exitCode = await commandScore(flags)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})

export {}
