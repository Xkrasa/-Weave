import path from 'node:path'
import type { ChapterContract } from './types.ts'
import type { ReviewReport } from './stage-types.ts'
import { listFiles, readJsonIfExists, readTextIfExists } from './io.ts'
import { loadContract } from './contract.ts'
import { loadStage, readDraft } from './stages.ts'
import { loadProject, projectPaths } from './project.ts'
import { loadStyleConstitution } from './style.ts'

export interface MethodModule {
  id: string
  version: number
  tags: string[]
  scope: string
  platforms?: string[]
  notFor?: string
  signal: string
  diagnosis: string
  process: string
  output: string
  positive: string
  negative: string
  selfCheck: string
}

export interface MethodSelection {
  modules: Array<{ id: string; version: number; reason: string }>
  reasons: string[]
  estimatedTokens: number
}

const BUILT_INS: MethodModule[] = [
  {
    id: 'structure-causality',
    version: 1,
    tags: ['structure', 'causality', 'plot', '结构', '因果', '目标'],
    scope: 'long-form chapter',
    platforms: ['generic', 'qidian', 'fanqie', 'long-form'],
    signal: '章节目标、阻力或结果之间缺少因果链；事件只是依次发生。',
    diagnosis: '先判断目标是否被具体阻力改变，再判断结果是否产生新的代价。',
    process: '写出本章目标 → 阻力 → 选择 → 结果 → 下一章压力；删除不改变状态的段落。',
    output: '每个场景至少改变一个状态；章末留下具体未解问题。',
    positive: '她为了拿到缺页，先交出账本，结果失去唯一证据。',
    negative: '她来到码头，看到海，想到过去，然后回家了。',
    selfCheck: '每个场景都能回答“谁想要什么、被什么阻止、付出了什么”。',
  },
  {
    id: 'character-motivation',
    version: 1,
    tags: ['character', 'motivation', 'pov', '人物', '动机', '视角'],
    scope: 'long-form chapter',
    platforms: ['generic', 'qidian', 'fanqie', 'long-form'],
    signal: '人物行为像作者安排，而不是由目标、恐惧或误判推动。',
    diagnosis: '检查人物此刻知道什么、误以为什么、最怕失去什么。',
    process: '列出视角人物的当前目标与错误信念；让行动同时服务目标和暴露局限。',
    output: '行动有可追溯动机；对白体现立场差异，而不是解释设定。',
    positive: '她明知会暴露，仍把缺页藏进袖子，因为那是唯一能证明父亲清白的东西。',
    negative: '她决定去码头，因为剧情需要她发现线索。',
    selfCheck: '删掉心理说明后，读者仍能从动作理解她为什么这样做。',
  },
  {
    id: 'scene-conflict',
    version: 1,
    tags: ['scene', 'conflict', 'pacing', '场景', '冲突', '节奏'],
    scope: 'long-form chapter',
    platforms: ['generic', 'qidian', 'fanqie', 'long-form'],
    signal: '场景空转；人物聊天但没有新信息、新阻力或新决定。',
    diagnosis: '区分信息交换、关系变化和局势变化；没有变化的场景应合并或删除。',
    process: '给场景设定一个可见目标和一个反对力量；让场景结束在变化上。',
    output: '场景结束时的局势与开始时不同；读者获得新问题或新代价。',
    positive: '她用一句试探换来对方沉默，沉默让她确认对方知道缺页。',
    negative: '两人聊了很久天气，最后各自离开。',
    selfCheck: '场景能否用“因为…所以…”连接下一个场景。',
  },
  {
    id: 'anti-template',
    version: 1,
    tags: ['style', 'voice', 'ai', '文风', '模板', '抒情'],
    scope: 'long-form chapter',
    platforms: ['generic', 'qidian', 'fanqie', 'long-form'],
    signal: '段落尾总结、抽象抒情、所有人同腔调、连续同构句式。',
    diagnosis: '先修结构和人物，再清理模板化表达；不要把结构问题当文风问题。',
    process: '删段尾总结；把抽象情绪换成动作或选择；给不同人物不同句长和词汇。',
    output: '减少解释性总结，保留具体动作、物件和可观察反应。',
    positive: '他把杯子放回桌上，杯底在木面上磨出一圈白痕。',
    negative: '他心中五味杂陈，感慨万千，意识到人生总是充满无奈。',
    selfCheck: '这一段是否只在解释前文，而没有推进人物或局势。',
  },
]

export async function loadMethods(root: string): Promise<MethodModule[]> {
  const byId = new Map(BUILT_INS.map(module => [module.id, module]))
  const dir = path.join(root, 'methods')
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.md')) continue
    const text = await readTextIfExists(path.join(dir, name))
    if (!text) continue
    const parsed = parseMethodMarkdown(name.replace(/\.md$/, ''), text)
    if (parsed) byId.set(parsed.id, parsed)
  }
  const disabled = await readJsonIfExists<string[] | { ids?: string[] }>(path.join(dir, 'disabled.json'))
  const disabledIds = new Set(Array.isArray(disabled) ? disabled : disabled?.ids ?? [])
  return [...byId.values()]
    .filter(module => !disabledIds.has(module.id))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function selectMethods(
  root: string,
  chapter: number,
  options: {
    maxTokens?: number
    purpose?: 'write' | 'rewrite' | 'route'
    platform?: 'long-form' | 'short-form' | 'generic' | 'qidian' | 'fanqie'
  } = {},
): Promise<MethodSelection> {
  const contract = await loadContract(root, chapter)
  const review = await loadStage<ReviewReport>(root, 'review', chapter)
  const purpose = options.purpose ?? 'write'
  const platform = options.platform ?? (await loadProject(root)).platform ?? 'long-form'
  const candidateModules = (await loadMethods(root)).filter(module => {
    if (purpose !== 'rewrite' && purpose !== 'route' && /revision/.test(module.scope.toLowerCase())) {
      return false
    }
    if (platform === 'short-form' && /long-form/.test(module.scope.toLowerCase())) return false
    if (platform === 'long-form' && /short-form/.test(module.scope.toLowerCase())) return false
    if (module.platforms && !module.platforms.includes(platform) && !module.platforms.includes('*')) {
      return false
    }
    if (module.notFor && module.notFor.toLowerCase().includes(platform)) return false
    if (purpose !== 'rewrite' && module.notFor && /revision/i.test(module.notFor)) return false
    return true
  })
  const readerPurpose = contract.readerIntent?.purpose
  const sceneTypes = contract.sceneTypes ?? []
  const text = [
    contract.goal,
    contract.obstacle ?? '',
    ...contract.mustHappen,
    readerPurpose ?? '',
    ...sceneTypes,
    contract.pov,
    ...(review?.findings.map(finding => `${finding.dimension} ${finding.description}`) ?? []),
  ].join(' ')
  const scores = candidateModules.map(module => {
    let score = 0
    if (module.tags.some(tag => text.includes(tag))) score += 2
    if (readerPurpose && module.tags.includes(readerPurpose)) score += 3
    if (sceneTypes.some(type => module.tags.includes(type))) score += 2
    if (module.tags.includes(contract.pov)) score += 2
    if (text.includes(module.id)) score += 2
    if (module.id === 'structure-causality' && /因果|目标|阻力|结构|动机/.test(text)) score += 2
    if (module.id === 'character-motivation' && /人物|动机|视角|误判/.test(text)) score += 2
    if (module.id === 'scene-conflict' && /场景|冲突|节奏|空转/.test(text)) score += 2
    if (module.id === 'anti-template' && /文风|模板|AI|抒情|总结/.test(text)) score += 1
    const blocking = review?.findings.some(finding => finding.severity === 'blocking') ?? false
    if (blocking && module.id === 'structure-causality') score += 1
    const tier = module.id === 'structure-causality'
      ? (blocking ? 0 : 1)
      : module.id === 'character-motivation'
        ? 2
        : module.id === 'scene-conflict'
          ? 3
          : 4
    return { module, score, tier }
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tier - b.tier || a.module.id.localeCompare(b.module.id))
    .slice(0, 3)
  const maxTokens = options.maxTokens ?? 1200
  while (scores.length > 1) {
    const estimated = Math.ceil(scores.reduce((sum, item) => sum + methodText(item.module).length, 0) / 1.6)
    if (estimated <= maxTokens) break
    scores.pop()
  }
  if (scores.length === 1
    && Math.ceil(methodText(scores[0]!.module).length / 1.6) > maxTokens) {
    scores.length = 0
  }
  const selected = scores.map(item => ({
    id: item.module.id,
    version: item.module.version,
    reason: `匹配：${item.module.tags.filter(tag => text.includes(tag)).join('、') || '章节诊断'}`,
  }))
  return {
    modules: selected,
    reasons: selected.map(item => `${item.id}: ${item.reason}`),
    estimatedTokens: Math.ceil(scores.reduce((sum, item) => sum + methodText(item.module).length, 0) / 1.6),
  }
}

export async function styleCheck(root: string, chapter: number): Promise<{
  chapter: number
  passed: boolean
  findings: Array<{ severity: 'blocking' | 'warning'; code: string; message: string }>
  stats: { sentences: number; averageSentenceLength: number; dialogueRatio: number }
  style: Awaited<ReturnType<typeof loadStyleConstitution>>
}> {
  const draft = await readDraft(root, chapter)
  const contract = await loadContract(root, chapter).catch(() => null)
  const style = await loadStyleConstitution(root)
  const sentences = draft.split(/[。！？!?]/).map(item => item.trim()).filter(Boolean)
  const avg = sentences.length === 0 ? 0 : sentences.reduce((sum, item) => sum + [...item].length, 0) / sentences.length
  const dialogueText = (draft.match(/“[^”]*”|"[^"]*"/g) ?? []).join('')
  const dialogueRatio = [...draft].length === 0 ? 0 : [...dialogueText].length / [...draft].length
  const findings: Array<{ severity: 'blocking' | 'warning'; code: string; message: string }> = []
  if (avg > style.sentenceLength.max) {
    findings.push({
      severity: 'warning',
      code: 'LONG_SENTENCE',
      message: `平均句长 ${avg.toFixed(1)} 字，超过 ${style.sentenceLength.max}`,
    })
  }
  if (avg < style.sentenceLength.min && sentences.length > 3) {
    findings.push({
      severity: 'warning',
      code: 'SHORT_SENTENCE',
      message: `平均句长 ${avg.toFixed(1)} 字，低于 ${style.sentenceLength.min}`,
    })
  }
  if (dialogueRatio < style.dialogueRatio.min && draft.length > 200) {
    findings.push({ severity: 'warning', code: 'LOW_DIALOGUE', message: '对白占比低于风格宪法下限' })
  }
  if (dialogueRatio > style.dialogueRatio.max) {
    findings.push({ severity: 'warning', code: 'HIGH_DIALOGUE', message: '对白占比高于风格宪法上限' })
  }
  const dashRatio = [...draft].length === 0 ? 0 : (draft.match(/——|—/g) ?? []).length / [...draft].length
  if (style.dashRatio && style.dashRatio.max > 0 && dashRatio > style.dashRatio.max) {
    findings.push({
      severity: 'warning',
      code: 'EXCESS_DASH',
      message: `破折号频率 ${dashRatio.toFixed(4)} 超过风格宪法上限 ${style.dashRatio.max}`,
    })
  }
  if (contract && style.pov !== 'any' && contract.narrativeMode !== style.pov) {
    findings.push({
      severity: 'warning',
      code: 'POV_MISMATCH',
      message: `合同视角 ${contract.narrativeMode ?? 'limited'} 与风格宪法 ${style.pov} 不一致`,
    })
  }
  const interiorityCount = (draft.match(/想|觉得|感到|意识到/g) ?? []).length
  const interiorityPerK = draft.length === 0 ? 0 : interiorityCount / draft.length * 1000
  if (style.interiority === 'low' && interiorityPerK > 8) {
    findings.push({ severity: 'warning', code: 'HIGH_INTERIORITY', message: '心理描写密度高于风格宪法' })
  }
  if (style.interiority === 'high' && interiorityPerK < 2 && draft.length > 300) {
    findings.push({ severity: 'warning', code: 'LOW_INTERIORITY', message: '心理描写密度低于风格宪法' })
  }
  const descriptionDensity = draft.length === 0 ? 0 : (draft.match(/的/g) ?? []).length / draft.length
  if (style.descriptionDensity === 'low' && descriptionDensity > 0.08) {
    findings.push({ severity: 'warning', code: 'DENSE_DESCRIPTION', message: '描写密度高于风格宪法' })
  }
  if (style.descriptionDensity === 'high' && descriptionDensity < 0.02 && draft.length > 300) {
    findings.push({ severity: 'warning', code: 'SPARSE_DESCRIPTION', message: '描写密度低于风格宪法' })
  }
  if (/总之[，,]|终于明白|意识到人生|感慨万千/.test(draft.slice(-120))) {
    findings.push({ severity: 'warning', code: 'SUMMARY_ENDING', message: '章末出现总结式收束' })
  }
  const prohibitions = await readTextIfExists(path.join(projectPaths(root).canon, 'prohibitions.md'))
  const forbidden = [
    ...style.forbiddenPatterns,
    ...(prohibitions?.split(/\r?\n/).map(item => item.trim()).filter(Boolean) ?? []),
  ]
  for (const pattern of forbidden) {
    if (draft.includes(pattern)) {
      findings.push({ severity: 'blocking', code: 'PROHIBITED_TEXT', message: `命中禁区：${pattern}` })
    }
  }
  return {
    chapter,
    passed: findings.every(finding => finding.severity !== 'blocking'),
    findings,
    stats: { sentences: sentences.length, averageSentenceLength: avg, dialogueRatio },
    style,
  }
}

function parseMethodMarkdown(id: string, text: string): MethodModule | null {
  const sections = new Map<string, string>()
  let current = ''
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading) {
      current = heading[1]!.trim().toLowerCase()
      continue
    }
    if (current) {
      const previous = sections.get(current)
      sections.set(current, previous ? `${previous}\n${line}` : line)
    }
  }
  const version = Number(/version:\s*(\d+)/i.exec(text)?.[1] ?? 1)
  const tags = (/(?:tags|标签):\s*(.+)/i.exec(text)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const scope = sections.get('scope')
    ?? /(?:scope|范围):\s*(.+)/i.exec(text)?.[1]?.trim()
    ?? 'long-form'
  const platforms = (sections.get('platforms')
    ?? sections.get('platform')
    ?? /(?:platforms?|平台):\s*(.+)/i.exec(text)?.[1]
    ?? '')
    .split(',').map(item => item.trim()).filter(Boolean)
  const signal = sections.get('signal') ?? ''
  const process = sections.get('process') ?? ''
  if (!signal || !process) return null
  return {
    id,
    version,
    tags,
    scope,
    platforms: platforms.length > 0 ? platforms : undefined,
    notFor: sections.get('not for')?.trim() ?? sections.get('不适用')?.trim() ?? undefined,
    signal,
    diagnosis: sections.get('diagnosis') ?? '',
    process,
    output: sections.get('output contract') ?? sections.get('output') ?? '',
    positive: sections.get('positive example') ?? '',
    negative: sections.get('negative example') ?? '',
    selfCheck: sections.get('self check') ?? '',
  }
}

export function methodText(module: MethodModule): string {
  return [
    `## ${module.id}`,
    `Scope: ${module.scope}`,
    module.notFor ? `Not for: ${module.notFor}` : '',
    module.signal,
    module.diagnosis,
    module.process,
    module.output,
    module.positive,
    module.negative,
    module.selfCheck,
  ].filter(Boolean).join('\n')
}
