import type { ChapterContract, ModelConfig, RunUsage } from './types.ts'
import type { EvidenceSpan } from './stage-types.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { draftHash, resolveEvidence, saveStage } from './stages.ts'
import { validationError } from './errors.ts'
import { collectLoopState } from './story-ledger.ts'
import { loadExpressionLintConfig, runExpressionLint } from './expression-lint.ts'
import { readerPromiseFindings } from './reader-promises.ts'

export interface EffectFinding {
  findingId: string
  dimension: string
  severity: 'warning' | 'info'
  description: string
  quote?: string
  evidence?: EvidenceSpan
  source: 'model' | 'lint'
  status: 'open' | 'planned' | 'applied' | 'verified' | 'ignored' | 'waived'
  ruleId?: string
  ruleVersion?: number
  revisionId?: string
  paragraphIds?: string[]
  ignoreReason?: string
  recheckNote?: string
  recheckedAt?: string
}

export interface EffectReviewReport {
  schemaVersion: 1
  chapter: number
  draftHash: string
  createdAt: string
  summary: string
  findings: EffectFinding[]
  model: string
  usage?: RunUsage
  passed: true
}

const SYSTEM_PROMPT = [
  '你是网文阅读效果审稿器。你不负责事实、时间线、POV 或合同门禁。',
  '只输出一个 JSON 对象，不要解释或 Markdown 围栏。',
  'severity 只能是 warning 或 info；任何 blocking 请求都会被降级。',
  '每条具体意见必须给出正文逐字引文；无法给出引文时只写整体建议，quote 留空。',
  '审查维度：读者期待、情绪兑现、场景张力、人物声音、信息释放、环境与描写、章末追读。',
  '不要用统一配额判断爽点；只指出这一章实际失去读者的地方。',
  '环境描写必须服务动作、信息或压力；连续铺陈天气、地形、光线属于问题，即使文笔漂亮也要指出。',
].join('\n')

const DIMENSIONS = '读者期待 | 情绪兑现 | 场景张力 | 人物声音 | 信息释放 | 环境与描写 | 章末追读'

export async function runEffectReview(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<EffectReviewReport> {
  const taskConfig = resolveTaskConfig(config, 'effectReview')
  const model = taskConfig.model
  const lint = await lintFindings(root, chapter, contract, draft)
  const prompt = [
    `第 ${chapter} 章合同：`,
    JSON.stringify(contract, null, 2),
    '',
    ...(contract.readerIntent ? [
      '本章 readerIntent 是软目标：请对照 purpose 与 payoff 判断读者实际获得，引用正文给出 warning/info；未达意图不自动升级为 blocking。',
      '',
    ] : []),
    '正文：',
    draft,
    '',
    '输出结构：',
    JSON.stringify({
      summary: '本章阅读效果总体判断',
      findings: [{
        dimension: DIMENSIONS,
        severity: 'warning | info',
        description: '读者会在哪里失去兴趣，为什么',
        quote: '正文中的逐字引文',
        occurrence: 1,
      }],
    }, null, 2),
  ].join('\n')

  const result = await completeJsonObject({ config: { ...taskConfig, model }, system: SYSTEM_PROMPT, user: prompt, signal })
  await appendUsage(root, { task: 'effectReview', model, usage: result.usage })
  const raw = result.raw
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) throw validationError('效果审查结果缺少 summary')
  const findings: EffectFinding[] = []
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : []
  rawFindings.forEach((item, index) => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null
    if (!entry) return
    const dimension = typeof entry.dimension === 'string' && entry.dimension.trim()
      ? entry.dimension.trim()
      : '阅读效果'
    const description = typeof entry.description === 'string' ? entry.description.trim() : ''
    if (!description) return
    const finding: EffectFinding = {
      findingId: `e${index + 1}`,
      dimension,
      severity: 'warning',
      description,
      source: 'model',
      status: 'open',
    }
    if (typeof entry.quote === 'string' && entry.quote.trim()) {
      try {
        finding.evidence = resolveEvidence(
          draft,
          chapter,
          entry.quote,
          typeof entry.occurrence === 'number' ? entry.occurrence : undefined,
        )
        finding.quote = entry.quote
      } catch {
        // An unverifiable quote can only carry a non-blocking advisory.
        finding.description = `${description}（引文无法定位）`
      }
    }
    findings.push(finding)
  })

  const report: EffectReviewReport = {
    schemaVersion: 1,
    chapter,
    draftHash: draftHash(draft),
    createdAt: new Date().toISOString(),
    summary,
    findings: [...lint, ...findings],
    model,
    usage: result.usage,
    passed: true,
  }
  await saveStage(root, 'effect-review', chapter, report)
  return report
}

const ENV_DUMP_WORDS = [
  '海风', '潮水', '雾气', '天空', '天色', '云层', '月光', '灯光', '路灯',
  '夜色', '黄昏', '清晨', '铁锈', '海面', '阴影', '细雨', '寒风', '水汽',
]

/**
 * Only checks the data model can actually support: overdue loops, mid-chapter environment blocks,
 * and an explicit summary ending. It never infers "satisfaction density" from loop counts.
 */
async function lintFindings(
  root: string,
  chapter: number,
  contract: ChapterContract,
  draft: string,
): Promise<EffectFinding[]> {
  const findings: EffectFinding[] = []
  const tail = [...draft.trim()].slice(-160).join('')
  const summaryMatch = /总之[，,]|终于明白|意识到人生|感慨万千|这一切都值得/.exec(tail)
  if (summaryMatch) {
    const finding: EffectFinding = {
      findingId: `e-lint-${findings.length + 1}`,
      dimension: '章末追读',
      severity: 'warning',
      description: `章末出现总结式收束（${summaryMatch[0]}），可能削弱下一章的追读问题`,
      quote: summaryMatch[0],
      source: 'lint',
      status: 'open',
    }
    try {
      finding.evidence = resolveEvidence(draft, chapter, summaryMatch[0])
    } catch {
      // ignore if unresolvable
    }
    findings.push(finding)
  }

  const paragraphs = draft.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  for (let index = 1; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!
    if ([...paragraph].length < 45) continue
    if (/[“"「『]/.test(paragraph)) continue
    if (contract.characters.some(name => name && paragraph.includes(name))) continue
    const envHits = ENV_DUMP_WORDS.filter(word => paragraph.includes(word)).length
    if (envHits >= 4) {
      const finding: EffectFinding = {
        findingId: `e-lint-${findings.length + 1}`,
        dimension: '环境与描写',
        severity: 'warning',
        description: `第 ${index + 1} 段连续铺陈环境意象而无人物动作或对话推进，建议压缩或融入人物行动`,
        quote: paragraph,
        source: 'lint',
        status: 'open',
      }
      try {
        finding.evidence = resolveEvidence(draft, chapter, paragraph)
      } catch {
        // ignore
      }
      findings.push(finding)
    }
  }

  const expressionConfig = await loadExpressionLintConfig(root)
  for (const match of runExpressionLint(contract, draft, expressionConfig)) {
    const finding: EffectFinding = {
      findingId: `e-lint-${findings.length + 1}`,
      dimension: '表达模板',
      severity: match.severity,
      description: match.description,
      quote: match.quote,
      source: 'lint',
      status: 'open',
      ruleId: match.ruleId,
      ruleVersion: match.ruleVersion,
    }
    try {
      finding.evidence = resolveEvidence(draft, chapter, match.quote, match.occurrence)
    } catch {
      // A missing quote must not become a hard failure; keep the advisory without evidence.
    }
    findings.push(finding)
  }

  for (const match of await readerPromiseFindings(root, chapter)) {
    findings.push({
      findingId: `e-lint-${findings.length + 1}`,
      dimension: '读者期待',
      severity: match.severity,
      description: match.description,
      source: 'lint',
      status: 'open',
      ruleId: match.ruleId,
      ruleVersion: match.ruleVersion,
    })
  }

  const loops = await collectLoopState(root, chapter).catch(() => null)
  if (!loops) return findings
  for (const loop of loops.loops) {
    if (loop.status === 'paid_off' || loop.status === 'abandoned') continue
    if (loop.targetToChapter === undefined || loop.targetToChapter >= chapter) continue
    findings.push({
      findingId: `e-lint-${findings.length + 1}`,
      dimension: '读者期待',
      severity: 'warning',
      description: `伏笔「${loop.summary}」原计划在第 ${loop.targetToChapter} 章前回收，至今仍为 ${loop.status}`,
      source: 'lint',
      status: 'open',
    })
  }
  return findings
}
