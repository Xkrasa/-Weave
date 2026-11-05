import type { ChapterContract, ModelConfig } from './types.ts'
import type { CoverageAudit, ExtractionReport, ReviewFinding, ReviewReport } from './stage-types.ts'
import { completeText } from './model.ts'
import { draftHash, parseJsonObject, resolveEvidence, saveStage } from './stages.ts'
import { validationError } from './errors.ts'
import { objectHash } from './hash.ts'

const SYSTEM_PROMPT = [
  '你是小说审稿器。只输出一个 JSON 对象，不要输出解释或 Markdown 围栏。',
  '审查必须建立在提供的抽取与审计结果之上，不得编造正文中没有的证据。',
  'blocking 只用于会破坏合同、事实、时间线或人物行为的问题；文风建议使用 warning 或 info。',
  '每条 finding 必须给出正文引文作为证据；无法给出引文时不要报 blocking。',
].join('\n')

export async function runReview(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  extraction: ExtractionReport,
  audit: CoverageAudit,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<ReviewReport> {
  const model = config.reviewModel ?? config.model
  const prompt = [
    `第 ${chapter} 章合同：`,
    JSON.stringify(contract, null, 2),
    '',
    '抽取结果：',
    JSON.stringify({ summary: extraction.summary, records: extraction.records, noEventsReason: extraction.noEventsReason }, null, 2),
    '',
    '覆盖审计：',
    JSON.stringify({
      contract: audit.contract,
      timelineErrors: audit.timeline.errors,
      timelineWarnings: audit.timeline.warnings,
      uncoveredSegments: audit.uncoveredSegments.length,
    }, null, 2),
    '',
    '正文：',
    draft,
    '',
    '输出结构：',
    JSON.stringify({
      summary: '本章总体判断',
      findings: [{
        dimension: '合同兑现 | 设定自洽 | 时间线 | 人物行为 | 叙事衔接',
        severity: 'blocking | warning | info',
        description: '具体问题',
        quote: '正文中的逐字引文',
        occurrence: 1,
      }],
    }, null, 2),
  ].join('\n')

  const result = await completeText({ config: { ...config, model }, system: SYSTEM_PROMPT, user: prompt, signal })
  const raw = parseJsonObject(result.text)
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('审稿结果缺少 summary')
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : []
  const findings: ReviewFinding[] = []
  rawFindings.forEach((item, index) => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (!entry) throw validationError(`第 ${index + 1} 条审稿意见不是对象`)
    const severity = entry.severity === 'blocking' || entry.severity === 'info' ? entry.severity : 'warning'
    const dimension = typeof entry.dimension === 'string' ? entry.dimension.trim() : ''
    const description = typeof entry.description === 'string' ? entry.description.trim() : ''
    if (!dimension || !description) throw validationError(`第 ${index + 1} 条审稿意见缺少 dimension 或 description`)
    const finding: ReviewFinding = {
      findingId: `f${index + 1}`,
      dimension,
      severity,
      description,
      status: 'open',
    }
    if (typeof entry.quote === 'string' && entry.quote.trim()) {
      finding.evidence = resolveEvidence(
        draft,
        chapter,
        entry.quote,
        typeof entry.occurrence === 'number' ? entry.occurrence : undefined,
      )
      finding.quote = entry.quote
    } else if (severity === 'blocking') {
      throw validationError(`第 ${index + 1} 条 blocking 意见缺少正文证据`)
    }
    findings.push(finding)
  })

  const blockingCount = findings.filter(finding => finding.severity === 'blocking').length
  const report: ReviewReport = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    extractionHash: objectHash(extraction),
    auditHash: objectHash(audit),
    summary,
    findings,
    blockingCount,
    model,
    usage: result.usage,
    passed: blockingCount === 0,
  }
  await saveStage(root, 'review', chapter, report)
  return report
}
