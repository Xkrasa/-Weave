import path from 'node:path'
import type { StageKind, EvidenceSpan } from './stage-types.ts'
import { atomicWriteJson, ensureDir, readJsonIfExists, readTextIfExists, normalizeText } from './io.ts'
import { hashText } from './hash.ts'
import { projectPaths } from './project.ts'
import { draftPath } from './ledger.ts'
import { chapterFileStem } from './contract.ts'
import { conflictError, validationError } from './errors.ts'

export function stagePath(root: string, kind: StageKind, chapter: number): string {
  return path.join(projectPaths(root).stages, kind, `${chapterFileStem(chapter)}.json`)
}

export async function saveStage<T>(root: string, kind: StageKind, chapter: number, report: T): Promise<string> {
  const target = stagePath(root, kind, chapter)
  await ensureDir(path.dirname(target))
  await atomicWriteJson(target, report)
  return target
}

export async function loadStage<T>(root: string, kind: StageKind, chapter: number): Promise<T | null> {
  return readJsonIfExists<T>(stagePath(root, kind, chapter))
}

export async function readDraft(root: string, chapter: number): Promise<string> {
  const raw = await readTextIfExists(draftPath(root, chapter))
  if (raw === null) throw conflictError(`第 ${chapter} 章没有草稿`)
  const draft = normalizeText(raw)
  if (!draft.trim()) throw validationError(`第 ${chapter} 章草稿为空`)
  return draft
}

export function draftHash(draft: string): string {
  return hashText(draft)
}

export async function requireStage<T extends { draftHash: string; passed: boolean }>(
  root: string,
  kind: StageKind,
  chapter: number,
  currentDraftHash: string,
): Promise<T> {
  const report = await loadStage<T>(root, kind, chapter)
  if (!report) throw validationError(`第 ${chapter} 章缺少 ${kind} 报告；请先运行对应命令`)
  if (report.draftHash !== currentDraftHash) {
    throw conflictError(`第 ${chapter} 章 ${kind} 报告绑定的草稿已变化；请重跑该阶段`)
  }
  if (!report.passed) {
    throw validationError(`第 ${chapter} 章 ${kind} 未通过；请先修复`)
  }
  return report
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw validationError('模型没有返回 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch (error) {
    throw validationError(`模型返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function resolveEvidence(
  draft: string,
  chapter: number,
  quote: string,
  occurrence?: number,
): EvidenceSpan {
  const text = normalizeText(quote)
  if (!text.trim()) throw validationError('证据引文为空')
  const positions = occurrencesOf(draft, text)
  if (positions.length === 0) throw validationError(`证据引文不在草稿中：${text.slice(0, 40)}`)
  const occurrenceNumber = occurrence ?? (positions.length === 1 ? 1 : 0)
  if (occurrenceNumber < 1 || occurrenceNumber > positions.length) {
    throw validationError(`证据引文出现 ${positions.length} 次，occurrence=${occurrence ?? '未提供'} 无法唯一确定`)
  }
  const start = positions[occurrenceNumber - 1]!
  const byteStart = Buffer.byteLength(draft.slice(0, start), 'utf8')
  const byteEnd = byteStart + Buffer.byteLength(text, 'utf8')
  return {
    sourceId: `draft:${chapter}`,
    sourceContentHash: draftHash(draft),
    byteStart,
    byteEnd,
    quote: text,
    excerptHash: hashText(text),
    occurrence: occurrenceNumber,
  }
}

export function textAtSpan(draft: string, span: EvidenceSpan): string {
  const bytes = Buffer.from(draft, 'utf8')
  return bytes.subarray(span.byteStart, span.byteEnd).toString('utf8')
}

function occurrencesOf(text: string, needle: string): number[] {
  const positions: number[] = []
  let index = text.indexOf(needle)
  while (index >= 0) {
    positions.push(index)
    index = text.indexOf(needle, index + Math.max(1, needle.length))
  }
  return positions
}
