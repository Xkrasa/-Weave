import path from 'node:path'
import { appendFile } from 'node:fs/promises'
import type { RunRecord, RunUsage } from './types.ts'
import { ensureDir, listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { projectPaths } from './project.ts'

export interface UsageBucket {
  runs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface UsageSummary {
  totals: UsageBucket
  byModel: Record<string, UsageBucket>
  byTask: Record<string, UsageBucket>
  missingUsage: number
}

const EMPTY: UsageBucket = { runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }

export interface UsageEntry {
  task: string
  model: string
  usage?: RunUsage
}

/** Stage calls (extraction, review, revision…) are appended here; writing runs live in `.weave/runs`. */
export async function appendUsage(root: string, entry: UsageEntry): Promise<void> {
  const file = path.join(projectPaths(root).metadata, 'usage.jsonl')
  await ensureDir(path.dirname(file))
  await appendFile(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`)
}

export async function usageSummary(root: string): Promise<UsageSummary> {
  const dir = projectPaths(root).runs
  const summary: UsageSummary = {
    totals: { ...EMPTY },
    byModel: {},
    byTask: {},
    missingUsage: 0,
  }
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json')) continue
    const run = await readJsonIfExists<RunRecord>(path.join(dir, name))
    if (!run) continue
    if (!run.usage) {
      summary.missingUsage += 1
      continue
    }
    const bucket = {
      runs: 1,
      promptTokens: run.usage.promptTokens ?? 0,
      completionTokens: run.usage.completionTokens ?? 0,
      totalTokens: run.usage.totalTokens ?? 0,
    }
    summary.totals = add(summary.totals, bucket)
    summary.byModel[run.model] = add(summary.byModel[run.model] ?? { ...EMPTY }, bucket)
    const task = run.task ?? 'writing'
    summary.byTask[task] = add(summary.byTask[task] ?? { ...EMPTY }, bucket)
  }

  const log = await readTextIfExists(path.join(projectPaths(root).metadata, 'usage.jsonl'))
  for (const line of (log ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: { task?: string; model?: string; usage?: RunUsage }
    try {
      entry = JSON.parse(line) as { task?: string; model?: string; usage?: RunUsage }
    } catch {
      continue
    }
    if (!entry.usage) {
      summary.missingUsage += 1
      continue
    }
    const bucket = {
      runs: 1,
      promptTokens: entry.usage.promptTokens ?? 0,
      completionTokens: entry.usage.completionTokens ?? 0,
      totalTokens: entry.usage.totalTokens ?? 0,
    }
    summary.totals = add(summary.totals, bucket)
    const model = entry.model ?? 'unknown'
    summary.byModel[model] = add(summary.byModel[model] ?? { ...EMPTY }, bucket)
    const task = entry.task ?? 'unknown'
    summary.byTask[task] = add(summary.byTask[task] ?? { ...EMPTY }, bucket)
  }
  return summary
}

function add(left: UsageBucket, right: UsageBucket): UsageBucket {
  return {
    runs: left.runs + right.runs,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}
