#!/usr/bin/env node
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
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
import {
  approveBeatCandidate,
  generateBeatCandidate,
  readBeatCandidate,
  saveBeatDraft,
  skipBeatCandidate,
  type DraftingStrategy,
  type SceneBeat,
} from './core/beats.ts'
import { findRecoverableRun } from './core/runs.ts'
import { createImpactReport, loadImpactReport, resolveImpact } from './core/impact.ts'
import { currentCommit, readMainline } from './core/ledger.ts'
import {
  doctor,
  exportBook,
  projectStatus,
  rebuildBook,
  type ExportCountMode,
  type ExportFormat,
  type ExportPlatform,
} from './core/services.ts'
import { WeaveError, usageError, validationError } from './core/errors.ts'
import { ensureProjectMigrated } from './core/migrate.ts'
import type { GenerationEvent } from './core/types.ts'
import { runContentCheck } from './core/content-check.ts'
import { runExtraction } from './core/extraction.ts'
import { runCoverageAudit, runTimelineReport } from './core/audit.ts'
import { runReview } from './core/review.ts'
import { runEffectReview } from './core/effect-review.ts'
import { applyWaivers, createWaivers, loadWaivers, revokeWaiver } from './core/waivers.ts'
import {
  ignoreFinding,
  mergeRevision,
  recheckChapter,
  reviseChapter,
  rewriteParagraph,
} from './core/revisions.ts'
import { loadMethods, selectMethods, styleCheck } from './core/methods.ts'
import {
  analyzeDeconstruction,
  approveMethodCandidate,
  listMethodCandidates,
  saveMethodCandidates,
} from './core/method-candidates.ts'
import { loadAuthorSamples, selectAuthorSamples } from './core/style.ts'
import {
  rebuildSearchIndex,
  readSearchChunk,
  searchBook,
  searchIndexHealth,
  type VectorFixture,
} from './core/search.ts'
import { deconstructFile } from './core/deconstruct.ts'
import { startUiServer } from './core/ui-server.ts'
import { evalReport, importEvalPairs, listEvalSessions } from './core/blind-eval.ts'
import {
  abandonReaderPromise,
  approveReaderPromiseBook,
  confirmReaderPromiseCandidate,
  extractReaderPromiseCandidates,
  listReaderPromises,
  recordReaderPayoff,
  saveReaderPromiseDraft,
  type ReaderPromiseBook,
} from './core/reader-promises.ts'
import { approvePlan, listPlans, parsePlanKind } from './core/planning.ts'
import { listPlatformProfiles, loadPlatformProfile } from './core/platform-profiles.ts'
import { compareHotspots, importHotspot, listHotspots, readHotspot, topicCandidates } from './core/hotspots.ts'
import { buildPublishDocument, validatePublishMarkdown } from './core/publish.ts'
import { inspectExternalComponents, runExternalDeslop } from './core/external-components.ts'
import { usageSummary } from './core/usage.ts'
import {
  approvePreference,
  clearPreferences,
  disablePreference,
  listPreferenceCandidates,
  listPreferenceSignals,
  readApprovedPreferences,
  reviewPreferenceCandidates,
} from './core/preferences.ts'
import {
  applyCandidate,
  approveCandidate,
  candidateValidation,
  generateOutlineCandidates,
  outlineReport,
  readCandidate,
} from './core/outline.ts'
import { atomicWriteJson, ensureDir } from './core/io.ts'
import {
  checkKnowledge,
  collectLedgerSources,
  effectiveBeliefs,
  effectiveFacts,
  entityState,
  collectLoopState,
  knowledgeState,
  seriesTimeline,
} from './core/story-ledger.ts'
import { loadCharacters } from './core/contract.ts'
import { assertLedgerProjectionCurrent, type LedgerProjectionName } from './core/ledger-projection.ts'
import { assertProjectionCurrent } from './core/projections.ts'
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

const BOOLEAN_FLAGS = new Set(['json', 'help', 'force', 'all', 'events', 'waive-warnings', 'all-warnings', 'save', 'rerank', 'open', 'key', 'analyze', 'methods'])
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
      return commandStatus(root, parsed, json)
    case 'contract':
      return commandContract(root, parsed, json)
    case 'waive':
      return commandWaive(root, parsed, json)
    case 'waivers':
      return commandWaivers(root, parsed, json)
    case 'search':
      return commandSearch(root, parsed, json)
    case 'chunk':
      return commandChunk(root, parsed, json)
    case 'index':
      return commandIndex(root, parsed, json)
    case 'deconstruct':
      return commandDeconstruct(root, parsed, json)
    case 'plan':
      return commandPlan(root, parsed, json)
    case 'promise':
      return commandPromise(root, parsed, json)
    case 'platform':
      return commandPlatform(root, parsed, json)
    case 'hotspot':
      return commandHotspot(root, parsed, json)
    case 'publish':
      return commandPublish(root, parsed, json)
    case 'external':
      return commandExternal(root, parsed, json)
    case 'outline':
      return commandOutline(root, parsed, json)
    case 'ui':
      return commandUi(root, parsed, json)
    case 'rewrite':
      return commandRewrite(root, parsed, json)
    case 'method':
      return commandMethod(root, parsed, json)
    case 'style':
      return commandStyle(root, parsed, json)
    case 'loops':
      return commandLoops(root, parsed, json)
    case 'state':
      return commandState(root, parsed, json)
    case 'knowledge':
      return commandKnowledge(root, parsed, json)
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
    case 'effect-review':
      return commandEffectReview(root, parsed, json)
    case 'revise':
      return commandRevise(root, parsed, json)
    case 'merge':
      return commandMerge(root, parsed, json)
    case 'recheck':
      return commandRecheck(root, parsed, json)
    case 'ignore':
      return commandIgnore(root, parsed, json)
    case 'timeline':
      return commandTimeline(root, parsed, json)
    case 'beats':
      return commandBeats(root, parsed, json)
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
    case 'usage':
      return commandUsage(root, json)
    case 'preference':
      return commandPreference(root, parsed, json)
    case 'eval':
      return commandEval(root, parsed, json)
    default:
      throw usageError(`未知命令：${command}`)
  }
}

async function commandInit(parsed: Parsed, json: boolean): Promise<number> {
  const dir = path.resolve(parsed.positionals[0] ?? '.')
  const platform = optionalString(parsed, 'platform')
  if (platform && !['fanqie', 'qidian', 'generic'].includes(platform)) throw usageError('--platform 只能是 fanqie、qidian 或 generic')
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
    platform: platform as 'fanqie' | 'qidian' | 'generic' | undefined,
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

async function commandStatus(root: string, parsed: Parsed, json: boolean): Promise<number> {
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
    console.log(`内容投影：${status.projection ? `${status.projection.status} @ ${status.projection.appliedThrough}` : '未建立'}`)
    console.log(`账本投影：${status.ledgerProjection ? `${status.ledgerProjection.status} @ ${status.ledgerProjection.appliedThrough}` : '未建立'}`)
    console.log(`未处理影响：${status.pendingImpacts}`)
    console.log(`检索索引：${status.searchIndex.status} @ ${status.searchIndex.mainlineRevision ?? '无'}`)
    console.log(`长期记忆：${status.memory.current ? 'current' : 'stale'} @ 第 ${status.memory.throughChapter} 章`)
    if (status.disclosure) {
      const list = status.disclosure.withheld
        .map(item => `${item.sourceId}（第 ${item.revealChapter} 章起开放）`)
        .join('、')
      console.log(`第 ${status.disclosure.chapter} 章未开放条目：${list}`)
      if (parsed.flags['show-withheld'] === true) {
        for (const item of status.disclosure.withheld) {
          console.log(`  ${item.sourceId} 预览：${item.excerpt}…`)
        }
      }
    }
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

async function commandWaive(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const reason = requiredString(parsed, 'reason')
  const scopeRaw = String(parsed.flags.scope ?? 'chapter')
  if (!['chapter', 'entity', 'storyline', 'project'].includes(scopeRaw)) {
    throw usageError('--scope 必须是 chapter、entity、storyline 或 project')
  }
  const scope = scopeRaw as 'chapter' | 'entity' | 'storyline' | 'project'
  if ((scope === 'entity' || scope === 'storyline') && !optionalString(parsed, 'scope-ref')) {
    throw usageError('entity/storyline 范围需要 --scope-ref')
  }
  const findingId = optionalString(parsed, 'finding')
  const allWarnings = parsed.flags['all-warnings'] === true
  if (!findingId && !allWarnings) throw usageError('请提供 --finding <id> 或 --all-warnings')
  const created = await createWaivers(
    root,
    chapter,
    findingId ? [findingId] : [],
    {
      reason,
      scope,
      scopeRef: optionalString(parsed, 'scope-ref'),
      untilChapter: optionalNumber(parsed, 'until'),
      allWarnings,
    },
  )
  if (json) outputJson({ ok: true, waivers: created })
  else console.log(`已创建/复用 ${created.length} 条豁免`)
  return 0
}

async function commandWaivers(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'list'
  if (action === 'list') {
    const waivers = await loadWaivers(root)
    if (json) outputJson({ waivers })
    else console.log(JSON.stringify({ waivers }, null, 2))
    return 0
  }
  if (action === 'revoke') {
    const waiverId = parsed.positionals[1]
    if (!waiverId) throw usageError('用法：weave waivers revoke <waiverId>')
    const waiver = await revokeWaiver(root, waiverId)
    if (json) outputJson(waiver)
    else console.log(`已撤销豁免 ${waiver.waiverId}`)
    return 0
  }
  throw usageError('用法：weave waivers list|revoke <waiverId>')
}

async function commandSearch(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const query = parsed.positionals[0]
  if (!query) throw usageError('用法：weave search <query> [--chapter <n>] [--entity <id>] [--limit <n>]')
  const vectorFile = optionalString(parsed, 'vectors')
  let vectors: VectorFixture | undefined
  if (vectorFile) {
    try {
      const raw = JSON.parse(await readFile(path.resolve(vectorFile), 'utf8')) as VectorFixture
      if (!Array.isArray(raw.query) || !raw.query.every(value => typeof value === 'number' && Number.isFinite(value))
        || !raw.chunks || typeof raw.chunks !== 'object'
        || Object.values(raw.chunks).some(value =>
          !Array.isArray(value)
          || value.length !== raw.query.length
          || !value.every(item => typeof item === 'number' && Number.isFinite(item)))
        || (raw.weight !== undefined && (!Number.isFinite(raw.weight) || raw.weight < 0))) {
        throw new Error('vectors 文件格式错误')
      }
      vectors = raw
    } catch (error) {
      throw usageError(`无法读取 vectors 文件：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const limit = optionalNumber(parsed, 'limit')
  if (limit !== undefined && limit <= 0) throw usageError('--limit 必须是正整数')
  const result = await searchBook(root, query, {
    chapter: optionalNumber(parsed, 'chapter'),
    entity: optionalString(parsed, 'entity'),
    storyline: optionalString(parsed, 'storyline'),
    time: optionalString(parsed, 'time'),
    location: optionalString(parsed, 'location'),
    limit,
    vectors,
    rerank: parsed.flags.rerank === true,
  })
  if (json) outputJson(result)
  else {
    for (const item of result.results) {
      console.log(`[${item.chapter}:${item.paragraph}] ${item.text.slice(0, 120)}`)
    }
  }
  return 0
}

async function commandChunk(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chunkId = parsed.positionals[0]
  if (!chunkId) throw usageError('用法：weave chunk <chunkId>')
  const chunk = await readSearchChunk(root, chunkId)
  if (!chunk) throw validationError(`未找到检索块：${chunkId}`)
  if (json) outputJson(chunk)
  else console.log(chunk.parentText)
  return 0
}

async function commandIndex(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  if (action === 'status') {
    const result = await searchIndexHealth(root)
    if (json) outputJson(result)
    else console.log(JSON.stringify(result, null, 2))
    return 0
  }
  if (action !== 'rebuild') throw usageError('用法：weave index rebuild|status')
  const result = await rebuildSearchIndex(root)
  if (json) outputJson({ ok: true, ...result })
  else console.log(`索引已重建：${result.chunks} 个段落，${result.terms} 个词项`)
  return 0
}

async function commandPlan(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'status'
  if (action === 'status') {
    const entries = await listPlans(root)
    if (json) outputJson({ plans: entries })
    else {
      for (const entry of entries) {
        console.log(`${entry.kind}\t${entry.status}\t${entry.path}${entry.approvedAt ? `\t${entry.approvedAt}` : ''}`)
      }
    }
    return 0
  }
  if (action === 'approve') {
    const kind = parsePlanKind(parsed.positionals[1])
    const volume = optionalNumber(parsed, 'volume')
    const entry = await approvePlan(root, kind, volume)
    if (json) outputJson(entry)
    else console.log(`已批准 ${entry.kind} 规划：${entry.path}`)
    return 0
  }
  throw usageError('用法：weave plan status|approve <story|volume|character-arcs|rolling> [--volume <n>]')
}

async function commandPromise(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'list'
  switch (action) {
    case 'set': {
      const file = requiredString(parsed, 'file')
      const raw = JSON.parse(await readFile(path.resolve(file), 'utf8')) as unknown
      const content = (Array.isArray(raw) ? { promises: raw } : raw) as ReaderPromiseBook
      const status = await saveReaderPromiseDraft(root, content)
      if (json) outputJson({ ok: true, status })
      else console.log('已保存 ReaderPromise 草案；请检查并执行 weave promise approve')
      return 0
    }
    case 'approve': {
      const status = await approveReaderPromiseBook(root)
      if (json) outputJson({ ok: true, status })
      else console.log('已批准 ReaderPromise')
      return 0
    }
    case 'list':
    case 'show': {
      const result = await listReaderPromises(root)
      if (action === 'show') {
        const promiseId = parsed.positionals[1]
        if (!promiseId) throw usageError('用法：weave promise show <promiseId>')
        const state = result.promises.find(item => item.promise.promiseId === promiseId)
        if (!state) throw validationError(`未找到已批准的 ReaderPromise：${promiseId}`)
        if (json) outputJson({ ok: true, bookStatus: result.bookStatus, promise: state })
        else console.log(JSON.stringify(state, null, 2))
        return 0
      }
      if (json) outputJson({ ok: true, ...result })
      else {
        console.log(`ReaderPromise 文件状态：${result.bookStatus}`)
        for (const state of result.promises) {
          console.log(`${state.promise.promiseId}\t${state.effectiveStatus}\t推进 ${state.advanceCount} 章\t${state.promise.description}`)
        }
      }
      return 0
    }
    case 'payoff': {
      const promiseId = parsed.positionals[1]
      if (!promiseId) throw usageError('用法：weave promise payoff <promiseId> --chapter <n> --quote <text> [--occurrence <n>]')
      const chapter = optionalNumber(parsed, 'chapter')
      if (chapter === undefined) throw usageError('缺少 --chapter')
      const observation = await recordReaderPayoff(root, {
        promiseId,
        chapter,
        quote: requiredString(parsed, 'quote'),
        occurrence: optionalNumber(parsed, 'occurrence'),
      })
      if (json) outputJson({ ok: true, observation })
      else console.log(`已确认 ${promiseId} 在第 ${chapter} 章的兑现证据`)
      return 0
    }
    case 'extract': {
      const chapter = parseChapter(parsed.positionals[1])
      const candidates = await extractReaderPromiseCandidates(root, chapter, await loadModelConfig(root), new AbortController().signal)
      if (json) outputJson({ ok: true, candidates })
      else console.log(`已保存 ${candidates.length} 条候选；逐条确认前不会改变承诺状态`)
      return 0
    }
    case 'confirm': {
      const candidateId = parsed.positionals[1]
      if (!candidateId) throw usageError('用法：weave promise confirm <candidateId>')
      const observation = await confirmReaderPromiseCandidate(root, candidateId)
      if (json) outputJson({ ok: true, observation })
      else console.log(`已确认候选 ${candidateId}`)
      return 0
    }
    case 'abandon': {
      const promiseId = parsed.positionals[1]
      if (!promiseId) throw usageError('用法：weave promise abandon <promiseId> --reason <text>')
      await abandonReaderPromise(root, promiseId, requiredString(parsed, 'reason'))
      if (json) outputJson({ ok: true, promiseId, status: 'abandoned' })
      else console.log(`已废弃 ${promiseId}`)
      return 0
    }
    default:
      throw usageError('用法：weave promise set|approve|list|show|payoff|extract|confirm|abandon')
  }
}

async function commandPlatform(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'list'
  if (action === 'list') {
    const profiles = await listPlatformProfiles(root)
    if (json) outputJson({ profiles })
    else for (const profile of profiles) console.log(profile)
    return 0
  }
  if (action === 'show') {
    const profile = await loadPlatformProfile(root, parsed.positionals[1] ?? 'fanqie')
    if (json) outputJson(profile)
    else console.log(JSON.stringify(profile, null, 2))
    return 0
  }
  throw usageError('用法：weave platform list|show <fanqie>')
}

async function commandHotspot(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  switch (action) {
    case 'import': {
      const file = parsed.positionals[1]
      if (!file) throw usageError('用法：weave hotspot import <file> --captured-at <date> --ranking <name> [--metric <name>] [--channel <name>] [--id <id>]')
      const snapshot = await importHotspot(root, file, {
        capturedAt: requiredString(parsed, 'captured-at'),
        ranking: requiredString(parsed, 'ranking'),
        channel: optionalString(parsed, 'channel'),
        metricName: optionalString(parsed, 'metric'),
        sampling: optionalString(parsed, 'sampling'),
        snapshotId: optionalString(parsed, 'id'),
        ...(optionalString(parsed, 'filter') ? { filters: { custom: parsed.flags.filter as string } } : {}),
      })
      if (json) outputJson({ ok: true, snapshot })
      else console.log(`已导入热点快照 ${snapshot.snapshotId}：${snapshot.entries.length} 条；数据质量警告 ${snapshot.dataQuality.warnings.length} 条`)
      return 0
    }
    case 'list': {
      const snapshots = await listHotspots(root)
      if (json) outputJson({ snapshots })
      else for (const snapshot of snapshots) console.log(`${snapshot.snapshotId}\t${snapshot.capturedAt}\t${snapshot.scope.ranking}\t${snapshot.entryCount} 条`)
      return 0
    }
    case 'show': {
      const snapshotId = parsed.positionals[1]
      if (!snapshotId) throw usageError('用法：weave hotspot show <snapshotId>')
      const snapshot = await readHotspot(root, snapshotId)
      if (json) outputJson(snapshot)
      else console.log(JSON.stringify(snapshot, null, 2))
      return 0
    }
    case 'compare': {
      const previous = parsed.positionals[1]
      const current = parsed.positionals[2]
      if (!previous || !current) throw usageError('用法：weave hotspot compare <previousId> <currentId>')
      const report = await compareHotspots(root, previous, current)
      if (json) outputJson(report)
      else console.log(JSON.stringify(report, null, 2))
      return 0
    }
    case 'candidates': {
      const snapshotId = parsed.positionals[1]
      if (!snapshotId) throw usageError('用法：weave hotspot candidates <snapshotId>')
      const candidates = await topicCandidates(root, snapshotId)
      if (json) outputJson({ candidates })
      else for (const candidate of candidates) console.log(`${candidate.value}\t${candidate.sampleCount} 本\t${candidate.note}`)
      return 0
    }
    default:
      throw usageError('用法：weave hotspot import|list|show|compare|candidates')
  }
}

async function commandPublish(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  if (action === 'build') {
    const result = await buildPublishDocument(root)
    if (json) outputJson({ ok: result.validation.fail.length === 0, ...result })
    else {
      console.log(`发布资料候选：${result.path}`)
      for (const warning of result.validation.warn) console.log(`- ${warning}`)
      for (const failure of result.validation.fail) console.error(`- ${failure}`)
    }
    return result.validation.fail.length === 0 ? 0 : 3
  }
  if (action === 'validate') {
    const file = parsed.positionals[1]
    if (!file) throw usageError('用法：weave publish validate <file>')
    const validation = await validatePublishMarkdown(root, file)
    if (json) outputJson({ ok: validation.fail.length === 0, ...validation })
    else {
      for (const warning of validation.warn) console.log(`- ${warning}`)
      for (const failure of validation.fail) console.error(`- ${failure}`)
    }
    return validation.fail.length === 0 ? 0 : 3
  }
  throw usageError('用法：weave publish build|validate <file>')
}

async function commandExternal(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  const componentRoot = path.resolve(optionalString(parsed, 'component-root') ?? 'test/fixtures/oh-story')
  if (action === 'inspect') {
    const candidates = await inspectExternalComponents(componentRoot)
    if (json) outputJson({ candidates })
    else for (const candidate of candidates) console.log(`${candidate.component}\t${candidate.present ? 'present' : 'missing'}\t${candidate.decision}`)
    return 0
  }
  if (action === 'test-deslop') {
    const input = parsed.positionals[1]
    if (!input) throw usageError('用法：weave external test-deslop <fixture> [--component-root <dir>] [--disabled]')
    const result = await runExternalDeslop(componentRoot, path.resolve(root, input), { disabled: parsed.flags.disabled === true })
    if (json) outputJson(result)
    else {
      console.log(`状态：${result.status}；finding：${result.findings.length}；fixture 未修改：${result.fixtureHashBefore === result.fixtureHashAfter}`)
      for (const finding of result.findings) console.log(`- [${finding.severity}] ${finding.description}`)
    }
    return 0
  }
  throw usageError('用法：weave external inspect [--component-root <dir>]|test-deslop <fixture> [--component-root <dir>] [--disabled]')
}

async function commandOutline(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'status'
  if (action === 'status') {
    const report = await outlineReport(root)
    if (json) outputJson(report)
    else {
      for (const candidate of report.candidates) {
        console.log(`第${candidate.chapter}章	${candidate.status}	${candidate.contentHash.slice(0, 16)}`)
      }
      if (report.candidates.length === 0) console.log('还没有章纲候选')
    }
    return 0
  }
  if (action === 'generate') {
    const fromChapter = parseChapter(parsed.positionals[1])
    const count = optionalNumber(parsed, 'count') ?? 3
    const config = await loadModelConfig(root)
    const candidates = await generateOutlineCandidates(root, {
      fromChapter,
      count,
      config,
      signal: new AbortController().signal,
    })
    if (json) outputJson({ candidates })
    else {
      console.log(`已生成 ${candidates.length} 份章纲候选：`)
      for (const candidate of candidates) {
        console.log(`  第${candidate.chapter}章 ${candidate.contract.title}`)
      }
      console.log('候选不会自动生效；编辑后执行 weave outline apply <chapter>，检查并 approve。')
    }
    return 0
  }
  const chapter = parseChapter(parsed.positionals[1])
  if (action === 'show') {
    const candidate = await readCandidate(root, chapter)
    if (!candidate) throw validationError(`第 ${chapter} 章没有章纲候选`)
    if (json) outputJson(candidate)
    else console.log(JSON.stringify(candidate.contract, null, 2))
    return 0
  }
  if (action === 'check') {
    const result = await candidateValidation(root, chapter)
    if (json) outputJson(result)
    else if (result.ok) console.log(`第 ${chapter} 章候选检查通过`)
    else for (const error of result.errors) console.error(`- ${error.code}: ${error.message}`)
    return result.ok ? 0 : 3
  }
  if (action === 'apply') {
    const candidate = await applyCandidate(root, chapter)
    if (json) outputJson({ ok: true, chapter, contentHash: candidate.contentHash })
    else console.log(`已写入第 ${chapter} 章候选合同；请执行 contract check 后再 approve`)
    return 0
  }
  if (action === 'approve') {
    const approved = await approveCandidate(root, chapter)
    if (json) outputJson(approved)
    else console.log(`已批准第 ${chapter} 章合同（${approved.contentHash.slice(0, 16)}）`)
    return 0
  }
  throw usageError('用法：weave outline status|generate <from>|show <chapter>|check <chapter>|apply <chapter>|approve <chapter>')
}

async function commandUi(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const port = optionalNumber(parsed, 'port') ?? 0
  if (port < 0 || port > 65535) throw usageError('--port 必须在 0–65535 之间')
  const ui = await startUiServer(root, { port })
  if (json) outputJson({ ok: true, url: ui.url, port: ui.port })
  else {
    console.log(`Weave 工作台已启动：${ui.url}`)
    console.log('按 Ctrl+C 停止。')
  }
  if (parsed.flags.open === true) openBrowser(ui.url)
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      ui.close().then(resolve).catch(reject)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    ui.server.once('close', resolve)
  })
  return 0
}

async function resolveResumeRun(root: string, chapter: number, parsed: Parsed): Promise<string | undefined> {
  const fromRun = parsed.flags['from-run']
  if (typeof fromRun === 'string') return fromRun
  const resume = parsed.flags.resume
  if (resume === undefined) return undefined
  if (typeof resume === 'string') return resume
  const recoverable = await findRecoverableRun(root, chapter)
  if (!recoverable) throw validationError(`第 ${chapter} 章没有可恢复的运行；请直接重新生成`)
  return recoverable.runId
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  const child = spawn(command[0] as string, command[1] as string[], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function commandDeconstruct(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const file = parsed.positionals[0]
  if (!file) throw usageError('用法：weave deconstruct <file> [--split-pattern <regex>] [--save]')
  const source = path.resolve(file)
  let report = await deconstructFile(source, {
    splitPattern: optionalString(parsed, 'split-pattern'),
  })
  let analysis: Awaited<ReturnType<typeof analyzeDeconstruction>> | undefined
  let candidates: Awaited<ReturnType<typeof saveMethodCandidates>> = []
  if (parsed.flags.analyze === true) {
    const config = await loadModelConfig(root)
    analysis = await analyzeDeconstruction(root, report, config, new AbortController().signal)
    if (parsed.flags.methods === true && analysis.methods.length > 0) {
      candidates = await saveMethodCandidates(root, analysis.methods, report.source)
    }
  }
  if (parsed.flags.save === true) {
    const dir = path.join(projectPaths(root).references, 'deconstruct')
    await ensureDir(dir)
    const target = path.join(dir, `${path.basename(source, path.extname(source))}.json`)
    await atomicWriteJson(target, report)
    report.savedPath = target
  }
  if (json) outputJson({ ...report, ...(analysis ? { analysis } : {}), ...(candidates.length > 0 ? { methodCandidates: candidates } : {}) })
  else {
    console.log(`拆书报告：${report.source}，${report.totals.chapters} 章`)
    for (const chapter of report.chapters) {
      console.log(`- ${chapter.index}. ${chapter.title}（${chapter.characters} 字，${chapter.structureTags.join('、')}）`)
    }
    if (report.savedPath) console.log(`已保存：${report.savedPath}`)
    if (analysis) {
      console.log(`结构分析：${analysis.summary}`)
      for (const pattern of analysis.patterns) console.log(`- 模式：${pattern}`)
    }
    for (const candidate of candidates) console.log(`- 方法卡候选：${candidate.id}（待批准）`)
  }
  return 0
}

async function commandRewrite(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const paragraphId = requiredString(parsed, 'paragraph')
  const goal = requiredString(parsed, 'goal')
  const config = await loadModelConfig(root)
  const candidate = await rewriteParagraph(
    root,
    chapter,
    paragraphId,
    goal,
    config,
    new AbortController().signal,
  )
  if (json) outputJson({ ok: true, exitCode: 0, revisionId: candidate.revisionId, candidate })
  else console.log(`已生成局部改写候选：${candidate.revisionId}`)
  return 0
}

async function commandMethod(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'list'
  if (action === 'list') {
    const modules = await loadMethods(root)
    if (json) outputJson({ modules })
    else for (const module of modules) console.log(`${module.id}\tv${module.version}\t${module.tags.join(',')}`)
    return 0
  }
  if (action === 'show') {
    const id = parsed.positionals[1]
    if (!id) throw usageError('用法：weave method show <id>')
    const module = (await loadMethods(root)).find(item => item.id === id)
    if (!module) throw validationError(`未找到方法模块：${id}`)
    if (json) outputJson(module)
    else {
      console.log(`# ${module.id}\n`)
      console.log(`Signal:\n${module.signal}\n`)
      console.log(`Diagnosis:\n${module.diagnosis}\n`)
      console.log(`Process:\n${module.process}\n`)
      console.log(`Output:\n${module.output}\n`)
      console.log(`Self Check:\n${module.selfCheck}`)
    }
    return 0
  }
  if (action === 'candidates') {
    const candidates = await listMethodCandidates(root)
    if (json) outputJson({ candidates })
    else for (const candidate of candidates) console.log(`${candidate.id}	${candidate.status}	${candidate.source}`)
    return 0
  }
  if (action === 'approve') {
    const id = parsed.positionals[1]
    if (!id) throw usageError('用法：weave method approve <id>')
    const target = await approveMethodCandidate(root, id)
    if (json) outputJson({ ok: true, id, path: target })
    else console.log(`已批准方法卡 ${id}：${target}`)
    return 0
  }
  if (action === 'history') {
    const chapter = parseChapter(parsed.positionals[1])
    const runsDir = projectPaths(root).runs
    const records: Array<{ runId: string; methodSelection: unknown }> = []
    for (const name of await readdir(runsDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as {
          chapter?: number
          runId?: string
          methodSelection?: unknown
        }
        if (record.chapter === chapter && record.methodSelection) {
          records.push({ runId: String(record.runId ?? name), methodSelection: record.methodSelection })
        }
      } catch {
        // Ignore incomplete run records.
      }
    }
    if (json) outputJson({ chapter, records })
    else for (const record of records) console.log(`${record.runId}\t${JSON.stringify(record.methodSelection)}`)
    return 0
  }
  if (action === 'route') {
    const chapter = parseChapter(parsed.positionals[1])
    const platform = String(parsed.flags.platform ?? 'long-form')
    if (!['long-form', 'short-form', 'generic', 'qidian', 'fanqie'].includes(platform)) {
      throw usageError('--platform 必须是 long-form、short-form、generic、qidian 或 fanqie')
    }
    const selection = await selectMethods(root, chapter, {
      maxTokens: optionalNumber(parsed, 'max-tokens'),
      purpose: 'write',
      platform: platform as 'long-form' | 'short-form' | 'generic' | 'qidian' | 'fanqie',
    })
    if (json) outputJson(selection)
    else {
      for (const item of selection.modules) console.log(`${item.id}\t${item.reason}`)
      console.log(`estimatedTokens=${selection.estimatedTokens}`)
    }
    return 0
  }
  throw usageError('用法：weave method list|show <id>|candidates|approve <id>|route <chapter>')
}

async function commandStyle(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  if (action === 'samples') {
    const chapter = optionalNumber(parsed, 'chapter')
    if (chapter !== undefined) {
      const contract = await loadContract(root, chapter)
      const selection = await selectAuthorSamples(root, contract)
      if (json) outputJson({ selection })
      else {
        for (const sample of selection.samples) console.log(`${sample.id}\t${sample.source}`)
        for (const reason of selection.reasons) console.log(reason)
      }
      return 0
    }
    const samples = await loadAuthorSamples(root)
    if (json) outputJson({ samples })
    else for (const sample of samples) console.log(`${sample.id}\t${sample.source}`)
    return 0
  }
  if (action !== 'check') throw usageError('用法：weave style check <chapter>|samples')
  const chapter = parseChapter(parsed.positionals[1])
  const report = await styleCheck(root, chapter)
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章风格检查：${report.passed ? '通过' : '未通过'}`)
    for (const finding of report.findings) console.log(`- [${finding.severity}] ${finding.code}: ${finding.message}`)
  }
  return report.passed ? 0 : 3
}

async function commandLoops(root: string, parsed: Parsed, json: boolean): Promise<number> {
  await assertLedgerProjectionCurrent(root, ['open-loop'])
  const state = await collectLoopState(root)
  const action = parsed.positionals[0] ?? 'list'
  if (action === 'list') {
    if (json) outputJson(state)
    else console.log(JSON.stringify(state, null, 2))
    return state.errors.length > 0 ? 3 : 0
  }
  if (action === 'show') {
    const loopId = parsed.positionals[1]
    if (!loopId) throw usageError('用法：weave loops show <loopId>')
    const loop = state.loops.find(item => item.loopId === loopId)
    if (!loop) throw validationError(`未找到伏笔：${loopId}`)
    if (json) outputJson(loop)
    else console.log(JSON.stringify(loop, null, 2))
    return 0
  }
  throw usageError('用法：weave loops list|show <loopId>')
}

async function commandState(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const entityId = parsed.positionals[0]
  if (!entityId) throw usageError('用法：weave state <entityId> [--chapter <n>]')
  await assertLedgerProjectionCurrent(root, ['entity-state'])
  const head = await readMainline(root)
  const latest = Math.max(0, ...Object.keys(head.selectedCommitByChapter).map(Number))
  const chapter = optionalNumber(parsed, 'chapter') ?? latest
  if (chapter <= 0) throw validationError('项目还没有已定稿章节')
  const state = await entityState(root, entityId, chapter)
  if (json) outputJson(state)
  else console.log(JSON.stringify(state, null, 2))
  return 0
}

async function commandKnowledge(root: string, parsed: Parsed, json: boolean): Promise<number> {
  await assertLedgerProjectionCurrent(root, ['belief'])
  if (parsed.positionals[0] === 'check') {
    const chapter = parseChapter(parsed.positionals[1])
    const contract = await loadContract(root, chapter)
    const registry = await loadCharacters(root)
    const result = await checkKnowledge(root, chapter, contract, registry)
    if (json) outputJson(result)
    else {
      console.log(result.ok ? `第 ${chapter} 章信息边界检查通过` : `第 ${chapter} 章信息边界检查失败`)
      for (const error of result.errors) console.log(`- ${error.reason}`)
    }
    return result.ok ? 0 : 3
  }
  const characterId = parsed.positionals[0]
  if (!characterId) throw usageError('用法：weave knowledge <characterId>|check <chapter> [--chapter <n>]')
  const head = await readMainline(root)
  const latest = Math.max(0, ...Object.keys(head.selectedCommitByChapter).map(Number))
  const chapter = optionalNumber(parsed, 'chapter') ?? latest
  if (chapter <= 0) throw validationError('项目还没有已定稿章节')
  const state = await knowledgeState(root, characterId, chapter)
  if (json) outputJson(state)
  else console.log(JSON.stringify(state, null, 2))
  return 0
}

async function commandLedger(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  const id = parsed.positionals[1]
  if (!action || !id) throw usageError('用法：weave ledger event|fact|entity|beliefs <id> [--chapter <n>]')
  await assertLedgerProjectionCurrent(root, ['entity-state', 'belief', 'series-timeline'])
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
    for (const item of report.quantityBreaks) {
      console.log(`- 数值总账：${item.subject} 的 ${item.unit}（第 ${item.chapter} 章）上章 ${item.previousBalance} + ${item.delta} 应为 ${item.expectedBalance}，正文写 ${item.statedBalance}`)
    }
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
  await assertProjectionCurrent(root)
  await assertLedgerProjectionCurrent(root)
  const waiveWarnings = parsed.flags['waive-warnings'] === true
  const waiveReason = optionalString(parsed, 'waive-reason')?.trim()
  if (waiveWarnings && !waiveReason) {
    throw usageError('--waive-warnings 需要同时提供 --waive-reason')
  }
  const config = await loadModelConfig(root)
  let report = await runReview(
    root, chapter, contract, draft, extraction, audit, config, new AbortController().signal,
  )
  report = await applyWaivers(root, chapter, report)
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

async function commandEffectReview(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const contract = await loadContract(root, chapter)
  const draft = await readDraft(root, chapter)
  const config = await loadModelConfig(root)
  const report = await runEffectReview(root, chapter, contract, draft, config, new AbortController().signal)
  if (json) outputJson(report)
  else {
    console.log(`第 ${chapter} 章阅读效果审查（仅建议，不阻断定稿）`)
    console.log(report.summary)
    for (const finding of report.findings) {
      console.log(`- [${finding.severity}] ${finding.dimension}: ${finding.description}`)
    }
  }
  return 0
}

async function commandRevise(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const rawFindings = optionalString(parsed, 'findings')
  const findingIds = (rawFindings ?? '').split(',').map(item => item.trim()).filter(Boolean)
  if (findingIds.length === 0) throw usageError('请提供 --findings <id,...>')
  const config = await loadModelConfig(root)
  const result = await reviseChapter(root, chapter, findingIds, config, new AbortController().signal)
  if (json) outputJson({
    ok: true,
    exitCode: 0,
    revisionId: result.candidate.revisionId,
    plan: result.plan,
    candidate: result.candidate,
  })
  else {
    console.log(`已生成第 ${chapter} 章修订候选：${result.candidate.revisionId}`)
    console.log(`处理 finding：${result.plan.findings.map(item => item.findingId).join('、')}`)
    console.log(`原稿：${result.plan.draftHash}`)
  }
  return 0
}

async function commandMerge(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const revisionId = requiredString(parsed, 'revision')
  const strategy = optionalString(parsed, 'strategy')
  if (strategy !== undefined && strategy !== 'auto') throw usageError('--strategy 目前只支持 auto')
  const choices: Record<string, 'base' | 'revision' | 'manual'> = {}
  const rawChoices = optionalString(parsed, 'choices')
  if (rawChoices) {
    for (const item of rawChoices.split(',')) {
      const [paragraphId, value] = item.split('=')
      if (!paragraphId || (value !== 'base' && value !== 'revision' && value !== 'manual')) {
        throw usageError('--choices 格式应为 p001=base|revision|manual,p002=...')
      }
      choices[paragraphId] = value
    }
  }
  const report = await mergeRevision(root, chapter, revisionId, choices)
  if (json) outputJson({ ok: report.status === 'merged', exitCode: report.status === 'merged' ? 0 : 3, report })
  else if (report.status === 'merged') console.log(`已合并修订 ${revisionId} 到草稿`)
  else {
    console.error(`修订 ${revisionId} 存在 ${report.hunks.filter(item => item.status === 'conflict').length} 个冲突`)
    for (const hunk of report.hunks.filter(item => item.status === 'conflict')) {
      console.error(`- ${hunk.paragraphId}`)
    }
  }
  return report.status === 'merged' ? 0 : 3
}

async function commandRecheck(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const config = await loadModelConfig(root)
  const report = await recheckChapter(root, chapter, config, new AbortController().signal)
  if (json) outputJson({ ...report, exitCode: report.passed ? 0 : 7 })
  else {
    console.log(`第 ${chapter} 章复检：${report.passed ? '通过' : '仍有阻断'}`)
    for (const finding of report.findings) {
      console.log(`- ${finding.findingId} [${finding.severity}] ${finding.status}: ${finding.description}`)
    }
  }
  return report.passed ? 0 : 7
}

async function commandIgnore(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const findingId = requiredString(parsed, 'finding')
  const reason = requiredString(parsed, 'reason')
  const finding = await ignoreFinding(root, chapter, findingId, reason)
  if (json) outputJson(finding)
  else console.log(`已忽略 ${finding.findingId}：${finding.ignoreReason}`)
  return 0
}

async function commandTimeline(root: string, parsed: Parsed, json: boolean): Promise<number> {
  await assertLedgerProjectionCurrent(root, ['series-timeline'])
  if (parsed.positionals[0] === 'series') {
    const registry = await loadCharacters(root)
    const report = await seriesTimeline(root, registry)
    if (json) outputJson(report)
    else {
      console.log(`系列时间线：${report.passed ? '通过' : '未通过'}`)
      for (const error of report.errors) console.log(`- ${error}`)
      for (const warning of report.warnings) console.log(`- 警告：${warning}`)
    }
    return report.passed ? 0 : 3
  }
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

async function commandBeats(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  const chapter = parseChapter(parsed.positionals[1])
  switch (action) {
    case 'generate': {
      const candidate = await generateBeatCandidate(root, chapter, await loadModelConfig(root), new AbortController().signal)
      if (json) outputJson(candidate)
      else console.log(`已生成第 ${chapter} 章节拍草案；请编辑并执行 weave beats approve ${chapter}`)
      return 0
    }
    case 'set': {
      const file = requiredString(parsed, 'file')
      const raw = JSON.parse(await readFile(path.resolve(file), 'utf8')) as unknown
      const beats = (Array.isArray(raw) ? raw : (raw as { beats?: unknown }).beats) as SceneBeat[]
      const candidate = await saveBeatDraft(root, chapter, beats)
      if (json) outputJson(candidate)
      else console.log(`已保存第 ${chapter} 章节拍草案；请执行 weave beats approve ${chapter}`)
      return 0
    }
    case 'show': {
      const view = await readBeatCandidate(root, chapter)
      if (json) outputJson(view)
      else console.log(JSON.stringify(view, null, 2))
      return 0
    }
    case 'approve': {
      const candidate = await approveBeatCandidate(root, chapter)
      if (json) outputJson(candidate)
      else console.log(`已批准第 ${chapter} 章节拍（${candidate.approvedBy}）`)
      return 0
    }
    case 'skip': {
      const candidate = await skipBeatCandidate(root, chapter)
      if (json) outputJson(candidate)
      else console.log(`已跳过第 ${chapter} 章节拍；默认 prose-first 可继续使用`)
      return 0
    }
    default:
      throw usageError('用法：weave beats generate|set|show|approve|skip <chapter> [--file <path>]')
  }
}

async function commandWrite(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const chapter = parseChapter(parsed.positionals[0])
  const events = parsed.flags.events === true
  const strategy = String(parsed.flags.strategy ?? 'prose-first')
  if (strategy !== 'prose-first' && strategy !== 'beat-first') throw usageError('--strategy 只能是 prose-first 或 beat-first')
  const draftingStrategy = strategy as DraftingStrategy
  const authorSamplesValue = String(parsed.flags['author-samples'] ?? 'scene')
  if (!['scene', 'legacy', 'off'].includes(authorSamplesValue)) throw usageError('--author-samples 只能是 scene、legacy 或 off')
  const authorSamples = authorSamplesValue as 'scene' | 'legacy' | 'off'
  const resumeFromRunId = await resolveResumeRun(root, chapter, parsed)
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
      resumeFromRunId,
      draftingStrategy,
      authorSamples,
      benchmark: parsed.flags.benchmark === true,
      key: parsed.flags.key === true,
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
        layers: result.layers,
        renderer: result.renderer,
        draftingStrategy: result.draftingStrategy,
        beatContentHash: result.beatContentHash,
        sampleSelection: result.sampleSelection,
        estimatedTokens: result.estimatedTokens,
        included: result.included,
        omitted: result.omitted,
        withheld: result.withheld,
        degraded: result.degraded,
        usage: result.run.usage ?? {},
        attempts: result.run.attempts ?? [],
        recovery: result.run.recovery,
        keyCandidates: result.keyCandidates,
      })
    } else {
      console.log(`\n\n已生成第 ${chapter} 章草稿：${result.draftPath}`)
      console.log(`运行：${result.run.runId}；估算输入 token：${result.estimatedTokens}`)
      if (result.omitted.length > 0) {
        console.log(`省略材料：${result.omitted.map(item => `${item.sourceId}(${item.reason})`).join('、')}`)
      }
      if (result.withheld.length > 0) {
        console.log(`未披露材料（披露未到，非省略）：${result.withheld.map(item => item.sourceId).join('、')}`)
      }
      if (result.degraded.length > 0) {
        console.log(`降级材料：${result.degraded.map(item => `${item.sourceId}(${item.reason})`).join('、')}`)
      }
      for (const group of result.keyCandidates) {
        console.log(`关键段落候选（${group.focus} / ${group.paragraphId}）：${group.revisionIds.join('、')}`)
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
      ledgerProjectionFailed: result.ledgerProjectionFailed,
      searchIndexFailed: result.searchIndexFailed,
      memoryFailed: result.memoryFailed,
      impact: result.impact,
      draftEdited: result.draftEdited,
    })
  } else {
    console.log(`已定稿第 ${chapter} 章：rev-${result.commit.revision}`)
    console.log(`提交：${result.commit.commitId}`)
    if (result.draftEdited) console.log('注意：草稿在生成后被手工修改，本次定稿使用了修改后的内容')
    if (result.projectionFailed) console.error('警告：投影更新失败，请执行 weave rebuild')
    if (result.ledgerProjectionFailed) console.error('警告：账本投影更新失败，请执行 weave rebuild --projection ledger')
    if (result.searchIndexFailed) console.error('警告：检索索引同步失败，请执行 weave rebuild --projection search')
    if (result.memoryFailed) console.error('警告：长期记忆摘要更新失败；下次写作会按主线重新生成')
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
  const requested = String(parsed.flags.projection ?? 'all')
  const allowed = new Set([
    'all', 'content', 'ledger', 'search', 'ledger-index', 'entity-state', 'belief', 'open-loop', 'series-timeline',
  ])
  if (!allowed.has(requested)) {
    throw usageError('--projection 必须是 all、content、ledger、search、ledger-index、entity-state、belief、open-loop 或 series-timeline')
  }
  const projection = requested as 'all' | 'content' | 'ledger' | 'search' | LedgerProjectionName
  const result = await rebuildBook(root, {
    force: parsed.flags.force === true,
    projection,
    fromChapter: optionalNumber(parsed, 'from'),
  })
  if (json) outputJson({ ok: true, ...result })
  else {
    console.log(`已重建投影：覆盖到第 ${result.chapters} 章`)
    if (result.projection) console.log(`内容投影：${result.projection.status} @ ${result.projection.appliedThrough}`)
    if (result.ledgerProjection) console.log(`账本投影：${result.ledgerProjection.status} @ ${result.ledgerProjection.appliedThrough}`)
    if (result.index) console.log(`检索索引：${result.index.chunks} 段，${result.index.terms} 词项`)
  }
  return 0
}

async function commandExport(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const raw = String(parsed.flags.format ?? 'merged')
  if (raw !== 'merged' && raw !== 'split' && raw !== 'txt') {
    throw usageError('--format 必须是 merged、split 或 txt')
  }
  const platformRaw = String(parsed.flags.platform ?? 'generic')
  if (platformRaw !== 'generic' && platformRaw !== 'qidian' && platformRaw !== 'fanqie' && platformRaw !== 'custom') {
    throw usageError('--platform 必须是 generic、qidian、fanqie 或 custom')
  }
  const countModeRaw = String(parsed.flags['count-mode'] ?? 'all')
  if (countModeRaw !== 'cjk' && countModeRaw !== 'all') {
    throw usageError('--count-mode 必须是 cjk 或 all')
  }
  if (parsed.flags['count-mode'] !== undefined && platformRaw !== 'custom') {
    throw usageError('--count-mode 只能与 --platform custom 一起使用')
  }
  const result = await exportBook(
    root,
    raw as ExportFormat,
    platformRaw as ExportPlatform,
    countModeRaw as ExportCountMode,
  )
  if (json) outputJson({ ok: true, ...result })
  else {
    console.log(`已导出 ${result.format}（${result.platform}，${result.characters} 字）：`)
    for (const file of result.files) console.log(`  ${file}`)
  }
  return 0
}

async function commandEval(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0]
  switch (action) {
    case 'import': {
      const dir = parsed.positionals[1]
      if (!dir) throw usageError('用法：weave eval import <pairsDir> [--id <sessionId>] [--title <text>]')
      const summary = await importEvalPairs(root, dir, {
        sessionId: optionalString(parsed, 'id'),
        title: optionalString(parsed, 'title'),
      })
      if (json) outputJson({ ok: true, session: summary })
      else console.log(`已导入盲评会话 ${summary.sessionId}：${summary.total} 对；在 weave ui 顶栏「盲评」中阅读`)
      return 0
    }
    case 'list': {
      const sessions = await listEvalSessions(root)
      if (json) outputJson({ ok: true, sessions })
      else if (sessions.length === 0) console.log('还没有盲评会话；用 weave eval import <pairsDir> 导入')
      else for (const item of sessions) console.log(`${item.sessionId}  ${item.scored}/${item.total}  ${item.title}`)
      return 0
    }
    case 'report': {
      const id = parsed.positionals[1]
      if (!id) throw usageError('用法：weave eval report <sessionId> [--force]')
      const report = await evalReport(root, id, { force: parsed.flags.force === true })
      if (json) outputJson({ ok: true, report })
      else console.log(JSON.stringify(report, null, 2))
      return 0
    }
    default:
      throw usageError('用法：weave eval import <pairsDir>|list|report <sessionId> [--force]')
  }
}

async function commandPreference(root: string, parsed: Parsed, json: boolean): Promise<number> {
  const action = parsed.positionals[0] ?? 'status'
  if (action === 'status') {
    const [signals, candidates, approved] = await Promise.all([
      listPreferenceSignals(root),
      listPreferenceCandidates(root),
      readApprovedPreferences(root),
    ])
    const payload = { signals, candidates, approved }
    if (json) outputJson(payload)
    else {
      console.log(`信号：${signals.length}；候选：${candidates.length}；已批准：${approved.length}`)
      for (const item of approved) console.log(`- ${item.id}: ${item.rule}`)
    }
    return 0
  }
  if (action === 'review') {
    const candidates = await reviewPreferenceCandidates(root)
    if (json) outputJson({ candidates })
    else for (const item of candidates) console.log(`${item.id}	${item.status}	${item.evidenceCount} 次	${item.rule}`)
    return 0
  }
  const id = parsed.positionals[1]
  if (action === 'approve') {
    if (!id) throw usageError('用法：weave preference approve <id>')
    const approved = await approvePreference(root, id)
    if (json) outputJson(approved)
    else console.log(`已批准偏好 ${approved.id}`)
    return 0
  }
  if (action === 'disable') {
    if (!id) throw usageError('用法：weave preference disable <id>')
    await disablePreference(root, id)
    if (json) outputJson({ ok: true, id })
    else console.log(`已停用偏好 ${id}`)
    return 0
  }
  if (action === 'clear') {
    await clearPreferences(root)
    if (json) outputJson({ ok: true })
    else console.log('已清除偏好候选与已批准偏好')
    return 0
  }
  throw usageError('用法：weave preference status|review|approve <id>|disable <id>|clear')
}

async function commandUsage(root: string, json: boolean): Promise<number> {
  const summary = await usageSummary(root)
  if (json) outputJson(summary)
  else {
    console.log(`运行：${summary.totals.runs} 次；token：${summary.totals.totalTokens}`)
    console.log(`输入 ${summary.totals.promptTokens} / 输出 ${summary.totals.completionTokens}`)
    for (const [model, bucket] of Object.entries(summary.byModel)) {
      console.log(`  ${model}: ${bucket.runs} 次，${bucket.totalTokens} token`)
    }
    for (const [task, bucket] of Object.entries(summary.byTask)) {
      console.log(`  ${task}: ${bucket.runs} 次，${bucket.totalTokens} token`)
    }
    if (summary.missingUsage > 0) console.log(`另有 ${summary.missingUsage} 次运行没有 usage 记录`)
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
  weave init [dir] --title <name> --model <model> --base-url <url> [--snapshot-every <n>] [--workflow p0|p05] [--platform fanqie|qidian|generic]
  weave status
  weave contract show|set <chapter> [--file <path>]
  weave contract check <chapter> | --all
  weave ledger event|fact|entity|beliefs <id> [--chapter <n>]
  weave state <entityId> [--chapter <n>]
  weave knowledge <characterId> [--chapter <n>]
  weave knowledge check <chapter>
  weave rewrite <chapter> --paragraph <id> --goal <text>
  weave plan status|approve <story|volume|character-arcs|rolling> [--volume <n>]
  weave promise set --file <path> | approve | list | show <promiseId>
  weave promise payoff <promiseId> --chapter <n> --quote <text> [--occurrence <n>]
  weave promise extract <chapter> | confirm <candidateId> | abandon <promiseId> --reason <text>
  weave platform list|show <fanqie>
  weave hotspot import <file> --captured-at <date> --ranking <name> [--metric <name>] [--channel <name>] [--id <id>]
  weave hotspot list|show <snapshotId>|compare <previousId> <currentId>|candidates <snapshotId>
  weave publish build|validate <file>
  weave external inspect [--component-root <dir>] | test-deslop <fixture> [--component-root <dir>] [--disabled]
  weave outline status|generate <from> [--count <n>]|show|check|apply|approve <chapter>
  weave method list|show <id>|candidates|approve <id>|route <chapter> [--platform long-form|short-form|generic|qidian|fanqie] [--max-tokens <n>]
  weave method history <chapter>
  weave style check <chapter>|samples
  weave search <query> [--chapter <n>] [--entity <id>] [--location <name>] [--storyline <id>] [--time <label>] [--vectors <file>] [--rerank] [--limit <n>]
  weave chunk <chunkId>
  weave index rebuild|status
  weave deconstruct <file> [--split-pattern <regex>] [--save] [--analyze [--methods]]
  weave ui [--port <n>] [--open]
  weave loops list|show <loopId>
  weave timeline series
  weave check <chapter>
  weave extract <chapter>
  weave audit <chapter>
  weave review <chapter> [--waive-warnings --waive-reason <text>]
  weave effect-review <chapter>
  weave revise <chapter> --findings <id,...>
  weave merge <chapter> --revision <id> [--choices p001=base|revision|manual]
  weave recheck <chapter>
  weave ignore <chapter> --finding <id> --reason <text>
  weave waive <chapter> --finding <id>|--all-warnings --reason <text> [--scope ...] [--until <n>]
  weave waivers list|revoke <waiverId>
  weave timeline <chapter>
  weave beats generate|set|show|approve|skip <chapter> [--file <path>] [--benchmark]
  weave write <chapter> [--json|--events] [--key] [--strategy prose-first|beat-first] [--author-samples scene|legacy|off] [--benchmark] [--cancel-after-ms <n>] [--resume [runId] | --from-run <runId>]
  weave amend <chapter> [--force]
  weave finalize <chapter>
  weave impact <chapter>
  weave resolve-impact <chapter> --target <n> --decision accept|revise|defer
  weave resolve-impact <chapter> --all --decision accept
  weave rebuild [--projection all|content|ledger|search] [--from <chapter>] [--force]
  weave export --format merged|split|txt [--platform generic|qidian|fanqie|custom] [--count-mode cjk|all]
  weave preference status|review|approve <id>|disable <id>|clear
  weave eval import <pairsDir> [--id <sessionId>] [--title <text>]
  weave eval list | report <sessionId> [--force]
  weave usage
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
