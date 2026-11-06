import type { ChapterContract, Material, MaterialDecision, ModelConfig } from './types.ts'
import { objectHash } from './hash.ts'

const SYSTEM_PROMPT = [
  '你是中文长篇小说写作引擎。',
  '只输出本章正文，不解释任务，不输出写作说明、标题或 Markdown 围栏。',
  '严格遵守提供的章节合同、已确认设定和人物信息边界。',
  '不得让角色使用其尚未获知的信息，不得擅自改变故事走向或新增关键设定。',
  '用具体动作、选择与后果推进场景，避免空泛总结和模板化抒情。',
  '环境描写只在改变人物处境、提供关键信息或制造压力时使用；连续两句以上纯环境铺陈必须删掉。',
  '字数不足时只能通过增加具体互动回合、对话潜台词、动作受阻与筹码拉锯来展开，严禁在中段插入天气、光线、气味或街景段落凑字数。',
  '开篇直接进入人物的动作、对话或一个具体问题，不要先铺陈天气、地形和光线。',
].join('\n')

export type PromptRenderer = 'json' | 'mission'

export interface ContextLayers {
  stable: string
  volume: string
  chapter: string
  full: string
}

export interface AssembledContext {
  system: string
  user: string
  contextHash: string
  layers: ContextLayers
  renderer: PromptRenderer
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
  options: { beatText?: string } = {},
): { decision: MaterialDecision; context: AssembledContext | null } {
  const renderer = renderMode(config)
  const contractText = `${JSON.stringify(contract, null, 2)}${options.beatText
    ? `\n\n已批准的场景节拍（生成辅助材料，不是既成事实）：\n${options.beatText}`
    : ''}`
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
    .sort((a, b) =>
      (b.relevance ?? 0) - (a.relevance ?? 0)
      || (a.priority ?? 100) - (b.priority ?? 100)
      || a.sourceId.localeCompare(b.sourceId),
    )
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
    const decision: 'split-required' | 'capacity-conflict' =
      !oversized && capacityTokens > 0 ? 'split-required' : 'capacity-conflict'
    return {
      decision: {
        decision,
        blockingSourceId: oversized?.sourceId ?? required[0]?.sourceId ?? 'contract',
        omissions: omitted,
        requiredTokens,
        capacityTokens,
        message:
          decision === 'split-required'
            ? '必要材料总量超过可用上下文；请拆章或分批写作，不要静默裁剪'
            : '单份必要材料或输出预留已超过可用上下文；请缩小本章范围或选择更大上下文的模型',
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
  const system = SYSTEM_PROMPT
  const user = renderer === 'mission'
    ? renderMissionPrompt(contract, ordered, options.beatText)
    : renderJsonPrompt(contract, contractText, ordered)
  const usedTokens = fixedTokens + used
  const layers = buildLayers(system, ordered, user)
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
      layers,
      renderer,
      included: ordered,
      omitted,
      estimatedTokens: usedTokens,
    },
  }
}

function renderMode(config: ModelConfig): PromptRenderer {
  const override = process.env.WEAVE_PROMPT_RENDERER
  if (override === 'json' || override === 'mission') return override
  return config.promptRenderer === 'mission' ? 'mission' : 'json'
}

function renderJsonPrompt(contract: ChapterContract, contractText: string, ordered: Material[]): string {
  const sections = ordered.map(item => `【${item.label}｜${item.category}/${item.provenance}】\n${item.text}`)
  return `章节合同：\n${contractText}\n\n${sections.join('\n\n')}\n\n请写出第 ${contract.chapter} 章《${contract.title}》正文：`
}

/**
 * Prose task brief. Hard constraints stay as explicit lists so they remain auditable;
 * only the contract narrative is turned into sentences.
 */
function renderMissionPrompt(contract: ChapterContract, ordered: Material[], beatText?: string): string {
  const lines: string[] = [
    `【本章任务】写出第 ${contract.chapter} 章《${contract.title}》的正文。`,
    '',
    '【这一章要发生的事】',
    `视角：${contract.pov}；时间：${contract.time}；地点：${contract.location}。`,
    `开场：${contract.openingState}`,
    `目标：${contract.goal}`,
    `阻力：${contract.obstacle ?? '未指定'}`,
    `收束：${contract.endingState}`,
    `承接上一章：${contract.previousLink}`,
    `留给下一章：${contract.nextLink}`,
    '',
  ]
  if (contract.readerIntent) {
    const intent = contract.readerIntent
    lines.push(
      '【阅读效果意图（软目标）】',
      `本章功能：${intent.purpose}`,
      `读者兑现：${intent.payoff}`,
      ...(intent.intensity ? [`强度：${intent.intensity}`] : []),
      ...(intent.hook ? [`章末期待：${intent.hook}`] : []),
      '',
    )
  }
  if (beatText) {
    lines.push('【已批准的场景节拍（辅助材料，不是既成事实）】', beatText, '')
  }
  if (contract.mustHappen.length > 0) {
    lines.push('必须发生：', ...contract.mustHappen.map(item => `- ${item}`), '')
  }
  if (contract.mustNotHappen.length > 0) {
    lines.push('绝对不可以发生：', ...contract.mustNotHappen.map(item => `- ${item}`), '')
  }
  if ((contract.knowledge ?? []).length > 0) {
    lines.push(
      '信息边界：',
      ...(contract.knowledge ?? []).map(item => `- ${item.character} 只知道：${item.fact}`),
      '',
    )
  }

  const groups: Array<{ title: string; categories: Material['category'][] }> = [
    { title: '【故事与风格】', categories: ['author'] },
    { title: '【本章可用的事实与衔接】', categories: ['derived-locator'] },
    { title: '【前文证据】', categories: ['finalized-history'] },
    { title: '【未来计划（不是既成事实）】', categories: ['future-plan'] },
    { title: '【参考资料（不是本书事实）】', categories: ['reference'] },
  ]
  for (const group of groups) {
    const items = ordered.filter(item => group.categories.includes(item.category))
    if (items.length === 0) continue
    lines.push(group.title)
    for (const item of items) {
      lines.push(`## ${item.label}`, item.text, '')
    }
  }

  lines.push(
    '【写作要求】',
    '- 只写正文，不写标题、说明或 Markdown 围栏。',
    '- 用具体动作、选择和代价推进，不写总结式收束。',
    '- 不得让角色使用其尚未获知的信息，不得改变合同之外的关键设定。',
    '- 场景结束时的局势必须与开始时不同。',
    '',
  )
  return lines.join('\n')
}

/**
 * Provider caches see literal text, not our hashes. These layers exist for audit and for
 * keeping the long-lived prefix byte-stable; a cache claim still needs provider usage data.
 */
function buildLayers(system: string, ordered: Material[], user: string): ContextLayers {
  const stable = ordered.filter(item => item.category === 'author')
  const volume = ordered.filter(item => item.category === 'future-plan')
  const chapter = ordered.filter(item =>
    item.category === 'derived-locator'
    || item.category === 'finalized-history'
    || item.category === 'reference',
  )
  return {
    stable: objectHash({ system, materials: stable.map(item => [item.sourceId, item.contentHash]) }),
    volume: objectHash({ materials: volume.map(item => [item.sourceId, item.contentHash]) }),
    chapter: objectHash({ user, materials: chapter.map(item => [item.sourceId, item.contentHash]) }),
    full: objectHash({ system, user }),
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
