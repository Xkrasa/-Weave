import path from 'node:path'
import type { ChapterContract, ModelConfig } from './types.ts'
import { atomicWriteJson, ensureDir, readJsonIfExists } from './io.ts'
import { contractHash, loadCharacters, loadContract, normalizeContract, saveContract } from './contract.ts'
import { checkPath, validateContract, type ContractCheckRecord } from './contract.ts'
import { completeJsonObject } from './model.ts'
import { resolveTaskConfig } from './model-policy.ts'
import { appendUsage } from './usage.ts'
import { conflictError, validationError } from './errors.ts'
import { projectPaths } from './project.ts'
import { listPlans, readApprovedPlan, type RollingPlan, type StoryPromise, type VolumeArc } from './planning.ts'
import { readMainline } from './ledger.ts'

export interface OutlineCandidate {
  schemaVersion: 1
  chapter: number
  status: 'draft' | 'approved'
  provenance: 'generated'
  createdAt: string
  contentHash: string
  contract: ChapterContract
  model?: string
  approvedAt?: string
}

export function candidatePath(root: string, chapter: number): string {
  return path.join(projectPaths(root).plans, 'candidates', 'chapters', `${String(chapter).padStart(3, '0')}.json`)
}

export async function readCandidate(root: string, chapter: number): Promise<OutlineCandidate | null> {
  return readJsonIfExists<OutlineCandidate>(candidatePath(root, chapter))
}

export async function generateOutlineCandidates(
  root: string,
  options: { fromChapter: number; count: number; config: ModelConfig; signal: AbortSignal },
): Promise<OutlineCandidate[]> {
  const { fromChapter, count, config, signal } = options
  if (!Number.isSafeInteger(fromChapter) || fromChapter <= 0) throw validationError('fromChapter 必须是正整数')
  if (!Number.isSafeInteger(count) || count <= 0 || count > 20) throw validationError('count 必须在 1–20 之间')
  const story = await readApprovedPlan<StoryPromise>(root, 'story')
  if (!story) throw conflictError('缺少已批准的故事承诺；请先批准 plans/story.json')
  const volumes = (await listPlans(root))
    .filter(entry => entry.kind === 'volume' && entry.status === 'approved')
    .map(entry => entry.content as VolumeArc)
    .sort((a, b) => b.volume - a.volume)
  const volume = volumes[0]
  if (!volume) throw conflictError('缺少已批准的卷弧；请先批准 plans/volumes/*.json')
  const rolling = await readApprovedPlan<RollingPlan>(root, 'rolling')

  const previousChapter = fromChapter - 1
  const previous = previousChapter > 0
    ? await loadContract(root, previousChapter).catch(() => null)
    : null
  const head = await readMainline(root)
  const finalizedThrough = Math.max(0, ...Object.keys(head.selectedCommitByChapter).map(Number))
  const prompt = [
    '你是长篇网文章纲生成器。只输出一个 JSON 对象，不要解释或 Markdown 围栏。',
    `请生成第 ${fromChapter} 到第 ${fromChapter + count - 1} 章的章纲候选，共 ${count} 章。`,
    '',
    '已批准的故事承诺：',
    JSON.stringify(story, null, 2),
    '',
    '已批准的当前卷弧：',
    JSON.stringify(volume, null, 2),
    ...(rolling ? ['', '已批准的滚动计划：', JSON.stringify(rolling, null, 2)] : []),
    '',
    `已定稿到第 ${finalizedThrough} 章。`,
    ...(previous ? ['上一章合同：', JSON.stringify(previous, null, 2)] : []),
    '',
    '要求：',
    '- 每章必须推进卷弧中的矛盾或读者承诺；',
    '- 只使用已存在的人物与设定，不得凭空新增关键人物；',
    '- 不得把未来计划写成已经发生的事实；',
    '- 章节之间要有具体承接，章末留下可执行的问题。',
    '',
    '输出结构：',
    JSON.stringify({
      chapters: [{
        chapter: fromChapter,
        title: '章标题',
        pov: '视角人物',
        time: '故事时间',
        location: '地点',
        openingState: '开场状态',
        endingState: '结束状态',
        goal: '本章目标',
        obstacle: '主要阻力',
        mustHappen: ['必须发生的事'],
        mayHappen: [],
        mustNotHappen: [],
        characters: ['出场人物'],
        threads: ['推进的故事线'],
        targetWords: 3000,
        previousLink: '承接上一章',
        nextLink: '留给下一章',
      }],
    }, null, 2),
  ].join('\n')

  const taskConfig = resolveTaskConfig(config, 'planning')
  const result = await completeJsonObject({ config: taskConfig, system: SYSTEM_PROMPT, user: prompt, signal })
  await appendUsage(root, { task: 'planning', model: taskConfig.model, usage: result.usage })
  const raw = result.raw
  const chapters = Array.isArray(raw.chapters) ? raw.chapters : []
  if (chapters.length === 0) throw validationError('章纲模型没有返回 chapters')
  const candidates: OutlineCandidate[] = []
  for (const item of chapters) {
    const contract = normalizeContract(item)
    if (contract.chapter < fromChapter || contract.chapter >= fromChapter + count) {
      throw validationError(`候选章号 ${contract.chapter} 超出请求范围`)
    }
    const candidate: OutlineCandidate = {
      schemaVersion: 1,
      chapter: contract.chapter,
      status: 'draft',
      provenance: 'generated',
      createdAt: new Date().toISOString(),
      contentHash: contractHash(contract),
      contract,
      model: config.model,
    }
    const file = candidatePath(root, contract.chapter)
    await ensureDir(path.dirname(file))
    await atomicWriteJson(file, candidate)
    candidates.push(candidate)
  }
  return candidates
}

/** Copies a candidate into the real chapter contract without approving it. */
export async function applyCandidate(root: string, chapter: number): Promise<OutlineCandidate> {
  const candidate = await accessCandidate(root, chapter)
  await saveContract(root, candidate.contract)
  return candidate
}

export async function approveCandidate(root: string, chapter: number): Promise<OutlineCandidate> {
  const candidate = await accessCandidate(root, chapter)
  const saved = await loadContract(root, chapter).catch(() => null)
  if (!saved) throw conflictError(`第 ${chapter} 章还没有写入正式合同；请先执行 weave outline apply ${chapter}`)
  if (contractHash(saved) !== candidate.contentHash) {
    throw conflictError(`第 ${chapter} 章正式合同与候选不一致；请重新 apply 或重新检查`)
  }
  const check = await readJsonIfExists<ContractCheckRecord>(checkPath(root, chapter))
  if (!check) throw conflictError(`第 ${chapter} 章还没有合同检查记录；请先执行 weave contract check ${chapter}`)
  if (check.contractHash !== contractHash(saved)) {
    throw conflictError(`第 ${chapter} 章合同在检查后已修改；请重新检查`)
  }
  if (!check.ok) throw conflictError(`第 ${chapter} 章合同检查未通过；请修复后重新检查`)
  const approved: OutlineCandidate = {
    ...candidate,
    status: 'approved',
    contentHash: contractHash(saved),
    approvedAt: new Date().toISOString(),
  }
  await atomicWriteJson(candidatePath(root, chapter), approved)
  return approved
}

/**
 * Hand-written contracts have no candidate record and stay usable.
 * Generated contracts must be approved before prose generation.
 */
export async function assertOutlineApproved(root: string, chapter: number): Promise<void> {
  const candidate = await readCandidate(root, chapter)
  if (!candidate) return
  if (candidate.status !== 'approved') {
    throw conflictError(`第 ${chapter} 章是生成的章纲候选（${candidate.status}）；请检查并执行 weave outline approve ${chapter}`)
  }
  const saved = await loadContract(root, chapter).catch(() => null)
  if (!saved || contractHash(saved) !== candidate.contentHash) {
    throw conflictError(`第 ${chapter} 章合同在批准后已变化；请重新检查并批准`)
  }
}

export async function outlineReport(root: string): Promise<{
  candidates: Array<{ chapter: number; status: string; contentHash: string; approvedAt?: string }>
  chapters: number
}> {
  const dir = path.join(projectPaths(root).plans, 'candidates', 'chapters')
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(dir).catch(() => [] as string[])
  const candidates: Array<{ chapter: number; status: string; contentHash: string; approvedAt?: string }> = []
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    const candidate = await readJsonIfExists<OutlineCandidate>(path.join(dir, name))
    if (!candidate) continue
    candidates.push({
      chapter: candidate.chapter,
      status: candidate.status,
      contentHash: candidate.contentHash,
      ...(candidate.approvedAt ? { approvedAt: candidate.approvedAt } : {}),
    })
  }
  const head = await readMainline(root)
  return { candidates, chapters: Object.keys(head.selectedCommitByChapter).length }
}

export async function candidateValidation(root: string, chapter: number): Promise<{ ok: boolean; errors: Array<{ code: string; message: string }> }> {
  const candidate = await accessCandidate(root, chapter)
  const registry = await loadCharacters(root)
  const errors = validateContract(candidate.contract, registry)
  return {
    ok: errors.length === 0,
    errors: errors.map(error => ({ code: error.code, message: error.message })),
  }
}

async function accessCandidate(root: string, chapter: number): Promise<OutlineCandidate> {
  const candidate = await readCandidate(root, chapter)
  if (!candidate) throw validationError(`第 ${chapter} 章没有章纲候选`)
  return candidate
}

const SYSTEM_PROMPT = [
  '你是中文长篇网文章纲生成器，不是正文写作模型。',
  '只输出一个 JSON 对象，不要解释、标题或 Markdown 围栏。',
  '章纲只描述计划，不得声称事情已经发生。',
  '每章都要有目标、阻力、选择与代价，并承接上一章。',
].join('\n')
