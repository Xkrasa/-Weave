import type { ChapterContract, Material, MaterialDecision, ModelConfig } from './types.ts'
import { objectHash } from './hash.ts'

const SYSTEM_PROMPT = [
  '你是中文长篇小说写作引擎。',
  '只输出本章正文，不解释任务，不输出写作说明、标题或 Markdown 围栏。',
  '严格遵守提供的章节合同、已确认设定和人物信息边界。',
  '不得让角色使用其尚未获知的信息，不得擅自改变故事走向或新增关键设定。',
  '用具体动作、选择与后果推进场景，避免空泛总结和模板化抒情。',
].join('\n')

export interface AssembledContext {
  system: string
  user: string
  contextHash: string
  included: Material[]
  omitted: Array<{ sourceId: string; reason: 'budget' | 'unknown-provenance' }>
  estimatedTokens: number
}

export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil([...text].length / charsPerToken)
}

export function assembleContext(
  contract: ChapterContract,
  materials: Material[],
  config: ModelConfig,
): { decision: MaterialDecision; context: AssembledContext | null } {
  const contractText = JSON.stringify(contract, null, 2)
  const framing = `${SYSTEM_PROMPT}\n章节合同：\n${contractText}\n材料：\n`
  const fixedTokens =
    estimateTokens(SYSTEM_PROMPT, config.charsPerToken) +
    estimateTokens(contractText, config.charsPerToken) +
    32
  const capacityTokens =
    config.contextWindow - config.maxOutputTokens - config.safetyMarginTokens - fixedTokens

  const usable: Material[] = []
  const omitted: Array<{ sourceId: string; reason: 'budget' | 'unknown-provenance' }> = []
  for (const item of materials) {
    if (item.provenance === 'unknown') {
      omitted.push({ sourceId: item.sourceId, reason: 'unknown-provenance' })
      continue
    }
    usable.push(item)
  }

  const unknownRequired = materials.find(item => item.required && item.provenance === 'unknown')
  const required = usable.filter(item => item.required)
  const optional = usable
    .filter(item => !item.required)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  const requiredTokens = required.reduce((sum, item) => sum + estimateTokens(item.text, config.charsPerToken), 0)

  if (unknownRequired) {
    return {
      decision: {
        decision: 'capacity-conflict',
        blockingSourceId: unknownRequired.sourceId,
        omissions: omitted,
        requiredTokens,
        capacityTokens,
        message: '必需材料来源未知，不能作为权威上下文；请补充来源信息',
      },
      context: null,
    }
  }

  if (requiredTokens > capacityTokens) {
    const oversized = required.find(item => estimateTokens(item.text, config.charsPerToken) > capacityTokens)
    return {
      decision: {
        decision: 'capacity-conflict',
        blockingSourceId: oversized?.sourceId ?? required[0]?.sourceId ?? 'contract',
        omissions: omitted,
        requiredTokens,
        capacityTokens,
        message: '必要材料超过所选模型的可用上下文；请缩小本章范围、拆章或选择更大上下文的模型',
      },
      context: null,
    }
  }

  const included = [...required]
  let used = requiredTokens
  for (const item of optional) {
    const tokens = estimateTokens(item.text, config.charsPerToken)
    if (used + tokens <= capacityTokens) {
      included.push(item)
      used += tokens
    } else {
      omitted.push({ sourceId: item.sourceId, reason: 'budget' })
    }
  }

  const ordered = included.sort((a, b) => categoryRank(a) - categoryRank(b))
  const sections = ordered.map(item => `【${item.label}｜${item.category}/${item.provenance}】\n${item.text}`)
  const user = `章节合同：\n${contractText}\n\n${sections.join('\n\n')}\n\n请写出第 ${contract.chapter} 章《${contract.title}》正文：`
  const system = SYSTEM_PROMPT
  const usedTokens = fixedTokens + used
  return {
    decision: {
      decision: 'ready',
      included,
      omitted,
      requiredTokens,
      capacityTokens,
    },
    context: {
      system,
      user,
      contextHash: objectHash({ system, user, sources: ordered.map(item => [item.sourceId, item.contentHash]) }),
      included: ordered,
      omitted,
      estimatedTokens: usedTokens,
    },
  }
}

function categoryRank(item: Material): number {
  switch (item.category) {
    case 'author':
      return 0
    case 'finalized-history':
      return 1
    case 'future-plan':
      return 2
    case 'derived-locator':
      return 3
    case 'reference':
      return 4
  }
}
