import path from 'node:path'
import type { ChapterContract } from './types.ts'
import type { ContentCheckReport, ContentFinding } from './stage-types.ts'
import { readTextIfExists } from './io.ts'
import { finalPath, readMainline } from './ledger.ts'
import { projectPaths } from './project.ts'
import { draftHash } from './stages.ts'

const PLACEHOLDER_RE = /TODO|待补|待定|本章将|以下正文|写作说明|提示词残留/i

export async function runContentCheck(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
): Promise<ContentCheckReport> {
  const findings: ContentFinding[] = []
  const characters = [...draft.replace(/\s/g, '')].length
  const deviation = contract.targetWords > 0 ? characters / contract.targetWords : 0

  if (!draft.trim()) {
    findings.push({ severity: 'blocking', code: 'EMPTY_DRAFT', message: '正文为空' })
  }
  const placeholder = draft.match(PLACEHOLDER_RE)
  if (placeholder) {
    findings.push({
      severity: 'blocking',
      code: 'PLACEHOLDER',
      message: `正文包含占位符或说明性文字：${placeholder[0]}`,
      quote: placeholder[0],
    })
  }
  if (deviation < 0.6) {
    findings.push({
      severity: 'warning',
      code: 'WORD_COUNT_LOW',
      message: `正文 ${characters} 字，低于目标 ${contract.targetWords} 字的 60%`,
    })
  } else if (deviation > 1.6) {
    findings.push({
      severity: 'warning',
      code: 'WORD_COUNT_HIGH',
      message: `正文 ${characters} 字，超过目标 ${contract.targetWords} 字的 160%`,
    })
  }

  for (const forbidden of contract.mustNotHappen) {
    if (forbidden.trim() && draft.includes(forbidden.trim())) {
      findings.push({
        severity: 'blocking',
        code: 'CONTRACT_FORBIDDEN',
        message: `正文出现合同禁止内容：${forbidden}`,
        quote: forbidden,
      })
    }
  }

  const prohibitions = await readTextIfExists(path.join(projectPaths(root).canon, 'prohibitions.md'))
  for (const raw of (prohibitions ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*]\s*/, '').trim()
    if (!line || line.startsWith('#') || line.length < 2) continue
    if (draft.includes(line)) {
      findings.push({
        severity: 'blocking',
        code: 'CANON_PROHIBITED',
        message: `正文命中项目禁区：${line}`,
        quote: line,
      })
    }
  }

  const tail = draft.trim()
  if (tail.length > 10 && !/[。！？…～—”」』）)】]$/.test(tail)) {
    findings.push({
      severity: 'blocking',
      code: 'TRUNCATED_ENDING',
      message: '正文在句中断开（结尾没有终止标点）；可能是输出被截断',
      quote: [...tail].slice(-12).join(''),
    })
  }

  const duplicateHits = await countDuplicateSentences(root, chapter, draft)
  if (duplicateHits > 0) {
    findings.push({
      severity: 'warning',
      code: 'DUPLICATE_SENTENCE',
      message: `与最近章节存在 ${duplicateHits} 处完全相同的长句`,
    })
  }

  for (const planned of contract.mustHappen) {
    if (!planned.trim()) continue
    if (!draft.includes(planned) && !draft.includes(planned.slice(0, Math.max(4, Math.floor(planned.length / 2))))) {
      findings.push({
        severity: 'info',
        code: 'CONTRACT_NODE_UNVERIFIED',
        message: `合同节点可能未在正文中表面兑现，交由抽取审计确认：${planned}`,
      })
    }
  }

  return {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    findings,
    stats: { characters, targetWords: contract.targetWords, deviation, duplicateHits },
    passed: !findings.some(finding => finding.severity === 'blocking'),
  }
}

async function countDuplicateSentences(root: string, chapter: number, draft: string): Promise<number> {
  const head = await readMainline(root)
  const previous = Object.keys(head.selectedCommitByChapter)
    .map(Number)
    .filter(number => number < chapter)
    .sort((a, b) => b - a)
    .slice(0, 3)
  if (previous.length === 0) return 0
  const priorText = (
    await Promise.all(previous.map(number => readTextIfExists(finalPath(root, number))))
  ).filter((text): text is string => Boolean(text)).join('\n')
  const prior = new Set(sentences(priorText))
  if (prior.size === 0) return 0
  return sentences(draft).filter(sentence => prior.has(sentence)).length
}

function sentences(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map(item => item.replace(/\s/g, ''))
    .filter(item => item.length >= 12)
}
