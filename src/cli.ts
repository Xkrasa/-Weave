#!/usr/bin/env node
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { findProjectRoot, initProject, projectPaths } from './core/project.ts'
import { normalizeContract, saveContract, loadContract, writeContractCheck, contractHash } from './core/contract.ts'
import { writeChapter, amendChapter, finalizeChapter } from './core/writing.ts'
import { createImpactReport, loadImpactReport, resolveImpact } from './core/impact.ts'
import { currentCommit } from './core/ledger.ts'
import { doctor, exportBook, projectStatus, rebuildBook, type ExportFormat } from './core/services.ts'
import { WeaveError, usageError, validationError } from './core/errors.ts'
import { ensureProjectMigrated } from './core/migrate.ts'
import type { GenerationEvent } from './core/types.ts'

interface Parsed {
  positionals: string[]
  flags: Record<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'force', 'all', 'events'])
let eventStreamStarted = false

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  const [command, ...positionals] = parsed.positionals
  parsed.positionals = positionals
  if (!command || command === 'help' || parsed.flags.help === true) {
    printHelp()
    return 0
  }

  const json = parsed.flags.json === true
  if (command === 'init') return commandInit(parsed, json)

  const root = parsed.flags.root ? path.resolve(String(parsed.flags.root)) : await findProjectRoot()
  const migration = await ensureProjectMigrated(root)
  if (migration.migrated && !json) {
    console.error(`项目已从 v${migration.from} 迁移到 v${migration.to}；备份：${migration.backupDir}`)
  }

  switch (command) {
    case 'status':
      return commandStatus(root, json)
    case 'contract':
      return commandContract(root, parsed, json)
    case 'write':
      return commandWrite(root, parsed, json)
    case 'amend':
      return commandAmend(root, parsed, json)
    case 'finalize':
      return commandFinalize(root, parsed, json)
    case 'impact':
      return commandImpact(root, parsed, json)
    case 'resolve-impact':
      return commandResolveImpact(root, parsed, json)
    case 'rebuild':
      return commandRebuild(root, parsed, json)
    case 'export':
      return commandExport(root, parsed, json)
    case 'doctor':
      return commandDoctor(root, json)
    default:
      throw usageError(`未知命令：${command}`)
  }
}

async function commandInit(parsed: Parsed, json: boolean): Promise<number> {
  const dir = path.resolve(parsed.positionals[0] ?? '.')
  const result = await initProject(dir, {
    title: optionalString(parsed, 'title'),
    language: optionalString(parsed, 'language'),
    targetWords: optionalNumber(parsed, 'target-words'),
    chapterWords: optionalNumber(parsed, 'chapter-words'),
    model: optionalString(parsed, 'model'),
    baseUrl: optionalString(parsed, 'base-url'),
    contextWindow: optionalNumber(parsed, 'context-window'),
    maxOutputTokens: optionalNumber(parsed, 'max-output'),
    snapshotEvery: optionalNumber(parsed, 'snapshot-every'),
  })
  if (json) {
    outputJson({ ok: true, root: result.root, project: result.project, config: result.config })
  } else {
    console.log(`已创建 Weave 项目：${result.root}`)
    console.log(`标题：${result.project.title}`)
    console.log(`模型：${result.config.model}（${result.config.baseUrl}）`)
  }
  return 0
}

async function commandStatus(root: string, json: boolean): Promise<number> {
  const status = await projectStatus(root)
  if (json) outputJson({ ok: true, ...status })
  else {
    console.log(`${status.title}（${status.language}）`)
    console.log(`主线版本：${status.mainlineRevision}`)
    console.log(`已定稿：${status.chapters.length} 章；草稿：${status.drafts.length} 章`)
    for (const chapter of status.chapters) {
      console.log(`  第${chapter.chapter}章 ${chapter.title} rev-${chapter.revision} ${chapter.commitId.slice(0, 19)}…`)
    }
    console.log(`投影：${status.projection ? `${status.projection.status} @ ${status.projection.appliedThrough}` : '未建立'}`)
    console.log(`未处理影响：${status.pendingImpacts}`)
  }
  return 0
}

async function commandContract(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  if (action === 'check' && parsed.flags.all === true) {
    return checkAllContracts(root, json)
  }
  const chapter = parseChapter(parsed.positionals[1])
  switch (action) {
    case 'set': {
      const file = requiredString(parsed, 'file')
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(path.resolve(file), 'utf8')) as unknown
      } catch (error) {
        throw validationError(`无法读取或解析合同 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
      const contract = normalizeContract(raw)
      if (chapter !== contract.chapter) {
        throw validationError(`命令行章号 ${chapter} 与合同章号 ${contract.chapter} 不一致`)
      }
      const target = await saveContract(root, contract)
      if (json) outputJson({ ok: true, chapter, contract, path: target, hash: contractHash(contract) })
      else console.log(`已保存第 ${chapter} 章合同：${target}`)
      return 0
    }
    case 'show': {
      const contract = await loadContract(root, chapter)
      if (json) outputJson({ ok: true, contract })
      else console.log(JSON.stringify(contract, null, 2))
      return 0
    }
    case 'check': {
      const contract = await loadContract(root, chapter)
      const record = await writeContractCheck(root, contract)
      if (json) outputJson({ ...record, ok: record.ok })
      else if (record.ok) console.log(`第 ${chapter} 章合同检查通过`)
      else for (const error of record.errors) console.error(`- ${error.code}: ${error.message}`)
      return record.ok ? 0 : 3
    }
    default:
      throw usageError('用法：weave contract show|set|check <chapter> [--file <path>]')
  }
}

async function checkAllContracts(root: string, json: boolean): Promise<number> {
  const dir = path.join(projectPaths(root).outlines, 'chapters')
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
  if (names.length === 0) throw validationError('没有可检查的章节合同')
  const failures: Array<{ chapter: number; errors: unknown }> = []
  for (const name of names) {
    const chapter = Number(name.replace(/\.json$/, ''))
    try {
      const contract = await loadContract(root, chapter)
      const record = await writeContractCheck(root, contract)
      if (!record.ok) failures.push({ chapter, errors: record.errors })
    } catch (error) {
      failures.push({ chapter, errors: error instanceof Error ? error.message : String(error) })
    }
  }
  const ok = failures.length === 0
  if (json) outputJson({ ok, checked: names.length, failures })
  else if (ok) console.log(`已检查 ${names.length} 份合同，全部通过`)
  else {
    console.error(`已检查 ${names.length} 份合同，${failures.length} 份未通过`)
    for (const failure of failures) console.error(`- 第 ${failure.chapter} 章：${JSON.stringify(failure.errors)}`)
  }
  return ok ? 0 : 3
}

async function commandWrite(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const events = parsed.flags.events === true
  if (events && json) throw usageError('--events 与 --json 不能同时使用')
  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.once('SIGINT', onSigint)
  if (process.platform === 'win32') process.once('SIGBREAK', onSigint)
  const cancelAfter = optionalNumber(parsed, 'cancel-after-ms')
  const cancelTimer = cancelAfter === undefined
    ? undefined
    : setTimeout(() => controller.abort(), Math.max(1, cancelAfter))
  try {
    const result = await writeChapter(root, chapter, {
      signal: controller.signal,
      onDelta: json || events ? undefined : text => process.stdout.write(text),
      onEvent: events
        ? (event: GenerationEvent) => {
            eventStreamStarted = true
            console.log(JSON.stringify(event))
          }
        : undefined,
    })
    if (events) return 0
    if (json) {
      outputJson({
        ok: true,
        chapter,
        runId: result.run.runId,
        draft: result.draftPath,
        contextHash: result.contextHash,
        estimatedTokens: result.estimatedTokens,
        included: result.included,
        omitted: result.omitted,
        usage: result.run.usage ?? {},
      })
    } else {
      console.log(`\n\n已生成第 ${chapter} 章草稿：${result.draftPath}`)
      console.log(`运行：${result.run.runId}；估算输入 token：${result.estimatedTokens}`)
      if (result.omitted.length > 0) {
        console.log(`省略材料：${result.omitted.map(item => `${item.sourceId}(${item.reason})`).join('、')}`)
      }
    }
    return 0
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer)
    process.removeListener('SIGINT', onSigint)
    if (process.platform === 'win32') process.removeListener('SIGBREAK', onSigint)
  }
}

async function commandAmend(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const meta = await amendChapter(root, chapter, parsed.flags.force === true)
  if (json) outputJson({ ok: true, chapter, meta })
  else console.log(`已从当前定稿创建第 ${chapter} 章修订草稿；原版本保持不变`)
  return 0
}

async function commandFinalize(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const result = await finalizeChapter(root, chapter)
  if (json) {
    outputJson({
      ok: true,
      chapter,
      commit: result.commit,
      mainlineRevision: result.mainlineRevision,
      projection: result.projection,
      projectionFailed: result.projectionFailed,
      impact: result.impact,
      draftEdited: result.draftEdited,
    })
  } else {
    console.log(`已定稿第 ${chapter} 章：rev-${result.commit.revision}`)
    console.log(`提交：${result.commit.commitId}`)
    if (result.draftEdited) console.log('注意：草稿在生成后被手工修改，本次定稿使用了修改后的内容')
    if (result.projectionFailed) console.error('警告：投影更新失败，请执行 weave rebuild')
    if (result.impact) {
      console.log(`影响面：${result.impact.items.length} 个后续章节待复查`)
      for (const item of result.impact.items) {
        console.log(`  第${item.targetChapter}章 [${item.level}] ${item.reason}`)
      }
    }
  }
  return 0
}

async function commandImpact(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const existing = await loadImpactReport(root, chapter)
  const commit = await currentCommit(root, chapter)
  if (!commit) throw validationError(`第 ${chapter} 章尚未定稿，无法分析影响面`)
  const report = existing ?? (await createImpactReport(root, chapter, commit))
  if (json) outputJson({ ok: true, report })
  else {
    console.log(`第 ${chapter} 章影响面（源 rev-${report.sourceRevision}）`)
    if (report.items.length === 0) console.log('没有后续已定稿章节')
    for (const item of report.items) {
      console.log(`  第${item.targetChapter}章 [${item.level}/${item.status}] ${item.reason}`)
    }
  }
  return 0
}

async function commandResolveImpact(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const decision = String(parsed.flags.decision ?? '')
  if (decision !== 'accept' && decision !== 'revise' && decision !== 'defer') {
    throw usageError('--decision 必须是 accept、revise 或 defer')
  }
  const target = optionalNumber(parsed, 'target')
  const report = await resolveImpact(root, chapter, {
    target,
    all: parsed.flags.all === true,
    decision,
  })
  const revised: number[] = []
  const skipped: Array<{ chapter: number; reason: string }> = []
  if (decision === 'revise') {
    for (const item of report.items.filter(entry => entry.status === 'revision-planned')) {
      try {
        await amendChapter(root, item.targetChapter)
        revised.push(item.targetChapter)
      } catch (error) {
        skipped.push({
          chapter: item.targetChapter,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  if (json) outputJson({ ok: true, report, revised, skipped })
  else {
    console.log(`已更新第 ${chapter} 章影响面处理结果`)
    if (revised.length > 0) console.log(`已创建修订草稿：第 ${revised.join('、')} 章`)
    for (const item of skipped) console.log(`第 ${item.chapter} 章未创建草稿：${item.reason}`)
  }
  return 0
}

async function commandRebuild(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const result = await rebuildBook(root, parsed.flags.force === true)
  if (json) outputJson({ ok: true, ...result })
  else console.log(`已重建投影：主线版本 ${result.projection.mainlineRevision}，覆盖到第 ${result.chapters} 章`)
  return 0
}

async function commandExport(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const raw = String(parsed.flags.format ?? 'merged')
  if (raw !== 'merged' && raw !== 'split' && raw !== 'txt') {
    throw usageError('--format 必须是 merged、split 或 txt')
  }
  const result = await exportBook(root, raw as ExportFormat)
  if (json) outputJson({ ok: true, ...result })
  else {
    console.log(`已导出 ${result.format}：`)
    for (const file of result.files) console.log(`  ${file}`)
  }
  return 0
}

async function commandDoctor(root: string, json: boolean): Promise<number> {
  const result = await doctor(root)
  if (json) outputJson({ ...result, ok: result.ok })
  else {
    console.log(result.ok ? `体检通过（${result.checkedCommits} 个提交）` : '体检失败：')
    for (const error of result.errors) console.error(`- ${error}`)
    for (const warning of result.warnings) console.warn(`- 警告：${warning}`)
  }
  return result.ok ? 0 : 4
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=', 2)
      if (!rawKey) throw usageError(`无效参数：${token}`)
      if (inline !== undefined) {
        flags[rawKey] = inline
        continue
      }
      if (BOOLEAN_FLAGS.has(rawKey)) {
        flags[rawKey] = true
        continue
      }
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[rawKey] = next
        index += 1
      } else {
        flags[rawKey] = true
      }
    } else {
      positionals.push(token)
    }
  }
  return { positionals, flags }
}

function parseChapter(value: string | undefined): number {
  const chapter = Number(value)
  if (!Number.isSafeInteger(chapter) || chapter <= 0) {
    throw usageError('请提供正整数章节号')
  }
  return chapter
}

function requiredString(parsed: Parsed, key: string): string {
  const value = parsed.flags[key]
  if (typeof value !== 'string' || !value.trim()) throw usageError(`缺少 --${key}`)
  return value
}

function optionalString(parsed: Parsed, key: string): string | undefined {
  const value = parsed.flags[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(parsed: Parsed, key: string): number | undefined {
  const value = parsed.flags[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw usageError(`--${key} 需要一个数字`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw usageError(`--${key} 需要一个整数`)
  return number
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function printHelp(): void {
  console.log(`Weave 0.1.0

用法：
  weave init [dir] --title <name> --model <model> --base-url <url> [--snapshot-every <n>]
  weave status
  weave contract show|set <chapter> [--file <path>]
  weave contract check <chapter> | --all
  weave write <chapter> [--json|--events] [--cancel-after-ms <n>]
  weave amend <chapter> [--force]
  weave finalize <chapter>
  weave impact <chapter>
  weave resolve-impact <chapter> --target <n> --decision accept|revise|defer
  weave resolve-impact <chapter> --all --decision accept
  weave rebuild [--force]
  weave export --format merged|split|txt
  weave doctor

全局：
  --json          输出机器可读 JSON
  --events        输出 NDJSON 生成事件流
  --root <dir>    指定项目根目录

环境变量：
  WEAVE_API_KEY   OpenAI 兼容接口密钥；不写入项目文件`)
}

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(error => {
    const json = process.argv.includes('--json')
    if (eventStreamStarted) {
      process.exitCode = error instanceof WeaveError ? error.exitCode : 6
      return
    }
    if (error instanceof WeaveError) {
      if (json) {
        outputJson({
          ok: false,
          error: { code: error.code, message: error.message, details: error.details ?? null },
        })
      } else {
        console.error(`错误：${error.message}`)
        if (error.details) console.error(JSON.stringify(error.details, null, 2))
      }
      process.exitCode = error.exitCode
      return
    }
    if (json) {
      outputJson({ ok: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } })
    } else {
      console.error(error)
    }
    process.exitCode = 6
  })
