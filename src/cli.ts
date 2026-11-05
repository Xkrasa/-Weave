#!/usr/bin/env node
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import {
  findProjectRoot,
  initProject,
  loadModelConfig,
  loadProject,
  projectPaths,
} from './core/project.ts'
import {
  contractHash,
  loadContract,
  normalizeContract,
  requirePassingContractCheck,
  saveContract,
  writeContractCheck,
} from './core/contract.ts'
import { writeChapter, amendChapter, finalizeChapter } from './core/writing.ts'
import { createImpactReport, loadImpactReport, resolveImpact } from './core/impact.ts'
import { currentCommit, readMainline } from './core/ledger.ts'
import { doctor, exportBook, projectStatus, rebuildBook, type ExportFormat } from './core/services.ts'
import { WeaveError, usageError, validationError } from './core/errors.ts'
import { ensureProjectMigrated } from './core/migrate.ts'
import type { GenerationEvent } from './core/types.ts'
import { runContentCheck } from './core/content-check.ts'
import { runExtraction } from './core/extraction.ts'
import { runCoverageAudit, runTimelineReport } from './core/audit.ts'
import { runReview } from './core/review.ts'
import { collectLedgerSources, effectiveBeliefs, effectiveFacts } from './core/story-ledger.ts'
import { draftHash, loadStage, readDraft, requireStage, saveStage } from './core/stages.ts'
import type {
  ContentCheckReport,
  CoverageAudit,
  ExtractionReport,
  ReviewReport,
} from './core/stage-types.ts'

interface Parsed {
  positionals: string[]
  flags: Record<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'force', 'all', 'events', 'waive-warnings'])
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
    case 'ledger':
      return commandLedger(root, parsed, json)
    case 'check':
      return commandCheck(root, parsed, json)
    case 'extract':
      return commandExtract(root, parsed, json)
    case 'audit':
      return commandAudit(root, parsed, json)
    case 'review':
      return commandReview(root, parsed, json)
    case 'timeline':
      return commandTimeline(root, parsed, json)
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
    workflowVersion: parseWorkflow(parsed),
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
    console.log(`项目版本：v${status.schemaVersion}；工作流：${status.workflowVersion === 2 ? 'p05' : 'p0'}`)
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

async function commandLedger(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  const id = parsed.positionals[1]
  if (!action || !id) throw usageError('用法：weave ledger event|fact|entity|beliefs <id> [--chapter <n>]')
  const sources = await collectLedgerSources(root)
  if (action === 'event') {
    const found = sources.events.find(item => item.record.eventId === id)
    if (!found) throw validationError(`未找到事件：${id}`)
    if (json) outputJson(found)
    else console.log(JSON.stringify(found, null, 2))
    return 0
  }
  if (action === 'fact') {
    const found = sources.facts.find(item => item.record.factId === id)
    if (!found) throw validationError(`未找到事实：${id}`)
    if (found.record.origin === 'candidate') throw validationError(`事实 ${id} 仍是候选，不能用于查询`)
    if (json) outputJson(found)
    else console.log(JSON.stringify(found, null, 2))
    return 0
  }
  const head = await readMainline(root)
  const latestChapter = Math.max(0, ...Object.keys(head.selectedCommitByChapter).map(Number))
  const chapter = optionalNumber(parsed, 'chapter') ?? latestChapter
  if (chapter <= 0) throw validationError('项目还没有已定稿章节')
  if (action === 'entity') {
    const facts = effectiveFacts(sources.facts.map(item => item.record), chapter)
      .filter(fact => fact.subject === id)
    const commitByFact = new Map(sources.facts.map(item => [item.record.factId, item.commitId]))
    const result = facts.map(fact => ({ ...fact, commitId: commitByFact.get(fact.factId) }))
    if (json) outputJson({ entityId: id, chapter, facts: result })
    else console.log(JSON.stringify({ entityId: id, chapter, facts: result }, null, 2))
    return 0
  }
  if (action === 'beliefs') {
    const beliefs = effectiveBeliefs(sources.beliefs.map(item => item.record), id, chapter)
    const commitByBelief = new Map(sources.beliefs.map(item => [item.record.beliefId, item.commitId]))
    const result = beliefs.map(belief => ({ ...belief, commitId: commitByBelief.get(belief.beliefId) }))
    if (json) outputJson({ characterId: id, chapter, beliefs: result })
    else console.log(JSON.stringify({ characterId: id, chapter, beliefs: result }, null, 2))
    return 0
  }
  throw usageError('用法：weave ledger event|fact|entity|beliefs <id> [--chapter <n>]')
}

async function commandCheck(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  const draft = await readDraft(root, chapter)
  const report = await runContentCheck(root, chapter, contract, draft)
  await saveStage(root, 'content-check', chapter, report)
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章内容检查：${report.passed ? '通过' : '未通过'}`)
    console.log(`字数：${report.stats.characters}/${report.stats.targetWords}`)
    for (const finding of report.findings) console.log(`- [${finding.severity}] ${finding.code}: ${finding.message}`)
  }
  return report.passed ? 0 : 3
}

async function commandExtract(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const contract = await loadContract(root, chapter)
  await requirePassingContractCheck(root, contract)
  const draft = await readDraft(root, chapter)
  const hash = draftHash(draft)
  await requireStage<ContentCheckReport>(root, 'content-check', chapter, hash)
  const config = await loadModelConfig(root)
  const report = await runExtraction(root, chapter, contract, draft, config, new AbortController().signal)
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章抽取：${report.passed ? '通过' : '未通过'}；记录 ${report.records.length} 条`)
    for (const rejected of report.rejected) console.log(`- 拒绝：${rejected.reason}`)
  }
  return report.passed ? 0 : 3
}

async function commandAudit(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const contract = await loadContract(root, chapter)
  const draft = await readDraft(root, chapter)
  const hash = draftHash(draft)
  const extraction = await requireStage<ExtractionReport>(root, 'extraction', chapter, hash)
  const config = await loadModelConfig(root)
  const report = await runCoverageAudit(
    root, chapter, contract, draft, extraction, config, new AbortController().signal,
  )
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章覆盖审计：${report.passed ? '通过' : '未通过'}`)
    console.log(`合同节点：${report.contract.covered.length}/${report.contract.planned.length}`)
    for (const missed of report.contract.missed) console.log(`- 未覆盖：${missed}`)
    for (const error of report.timeline.errors) console.log(`- 时间线：${error}`)
  }
  return report.passed ? 0 : 3
}

async function commandReview(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const contract = await loadContract(root, chapter)
  const draft = await readDraft(root, chapter)
  const hash = draftHash(draft)
  await requireStage<ContentCheckReport>(root, 'content-check', chapter, hash)
  const extraction = await requireStage<ExtractionReport>(root, 'extraction', chapter, hash)
  const audit = await requireStage<CoverageAudit>(root, 'audit', chapter, hash)
  const waiveWarnings = parsed.flags['waive-warnings'] === true
  const waiveReason = optionalString(parsed, 'waive-reason')?.trim()
  if (waiveWarnings && !waiveReason) {
    throw usageError('--waive-warnings 需要同时提供 --waive-reason')
  }
  const config = await loadModelConfig(root)
  const report = await runReview(
    root, chapter, contract, draft, extraction, audit, config, new AbortController().signal,
  )
  if (waiveWarnings) {
    for (const finding of report.findings) {
      if (finding.severity === 'warning') {
        finding.status = 'waived'
        finding.waiveReason = waiveReason
      }
    }
    await saveStage(root, 'review', chapter, report)
  }
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章审查：${report.passed ? '通过' : '存在阻断问题'}`)
    for (const finding of report.findings) {
      console.log(`- [${finding.severity}] ${finding.dimension}: ${finding.description}`)
    }
  }
  return report.passed ? 0 : 7
}

async function commandTimeline(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const draft = await readDraft(root, chapter)
  const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter)
  if (!extraction) throw validationError(`第 ${chapter} 章缺少抽取报告；请先运行 weave extract`)
  const report = await runTimelineReport(root, chapter, draft, extraction)
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章时间线：${report.passed ? '通过' : '未通过'}`)
    for (const error of report.errors) console.log(`- ${error}`)
    for (const warning of report.warnings) console.log(`- 警告：${warning}`)
  }
  return report.passed ? 0 : 3
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

function parseWorkflow(parsed: Parsed): 1 | 2 | undefined {
  const value = parsed.flags.workflow
  if (value === undefined) return undefined
  if (value === 'p0') return 1
  if (value === 'p05') return 2
  throw usageError('--workflow 必须是 p0 或 p05')
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
  weave init [dir] --title <name> --model <model> --base-url <url> [--snapshot-every <n>] [--workflow p0|p05]
  weave status
  weave contract show|set <chapter> [--file <path>]
  weave contract check <chapter> | --all
  weave ledger event|fact|entity|beliefs <id> [--chapter <n>]
  weave check <chapter>
  weave extract <chapter>
  weave audit <chapter>
  weave review <chapter> [--waive-warnings --waive-reason <text>]
  weave timeline <chapter>
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
