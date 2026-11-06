import path from 'node:path'
import { atomicWrite, readTextIfExists } from './io.ts'
import { objectHash } from './hash.ts'
import { loadProject } from './project.ts'
import { readApprovedPlan, type StoryPromise } from './planning.ts'
import { loadPlatformProfile, type PlatformProfile } from './platform-profiles.ts'
import { validationError } from './errors.ts'

export type PublishFieldStatus = 'confirmed' | 'suggested' | 'pending' | 'platform-unverified'
export interface PublishField {
  value: string
  status: PublishFieldStatus
  candidate?: string
  source: string
}

export interface PublishDocument {
  schemaVersion: 1
  platform: 'fanqie'
  bookType: 'long'
  profileVersion: number
  verifiedOn: string
  contentHash: string
  fields: Record<string, PublishField>
  pendingAuthor: string[]
  pendingPlatform: string[]
  sources: string[]
}

export interface PublishValidation {
  fail: string[]
  warn: string[]
}

export async function buildPublishDocument(root: string): Promise<{
  document: PublishDocument
  path: string
  validation: PublishValidation
}> {
  const [project, story, profile] = await Promise.all([
    loadProject(root),
    readApprovedPlan<StoryPromise>(root, 'story'),
    loadPlatformProfile(root, 'fanqie'),
  ])
  const fields: Record<string, PublishField> = {
    title: confirmedOrPending(project.title, 'project.title（作者已确认）'),
    penName: pending('作者笔名尚未提供'),
    signingMode: {
      value: '', status: 'platform-unverified', source: '签约模式取决于当前账号等级和后台选项',
    },
    targetAudience: pending('目标读者需作者明确选择，不从主角性别或文风推断'),
    protagonist1: story?.protagonistDesire
      ? { value: '', status: 'suggested', candidate: story.protagonistDesire, source: '已批准 StoryPromise.protagonistDesire；人物姓名仍需作者核对' }
      : pending('缺少已批准的主角资料'),
    protagonist2: pending('第二主角未确认'),
    readingTags: story?.genre
      ? { value: '', status: 'suggested', candidate: story.genre, source: '已批准 StoryPromise.genre；不是平台当前完整候选' }
      : pending('缺少已批准的题材信息'),
    contentTags: story?.coreFantasy
      ? { value: '', status: 'suggested', candidate: story.coreFantasy, source: '已批准 StoryPromise.coreFantasy；标签需按后台逐项确认' }
      : pending('缺少已批准的核心幻想'),
    synopsis: story
      ? {
          value: '',
          status: 'suggested',
          candidate: [story.coreFantasy, story.uniqueSellingPoint, story.emotionalPromise].filter(Boolean).join('；'),
          source: '由已批准 StoryPromise 生成的简介候选，不是作者定稿',
        }
      : pending('缺少已批准 StoryPromise'),
    cover: pending('封面可暂缓；如生成，必须包含正确书名和笔名并核对平台规格'),
  }
  const pendingAuthor = Object.entries(fields).flatMap(([name, field]) => {
    if (field.status === 'pending') return [`${name}：${field.source}`]
    if (field.status === 'suggested') return [`${name} 候选：${field.candidate ?? ''}`]
    return []
  })
  const pendingPlatform = [
    ...profile.pendingPlatformVerification,
    ...Object.entries(fields).filter(([, field]) => field.status === 'platform-unverified').map(([name, field]) => `${name}：${field.source}`),
  ]
  const sources = profile.sources.map(source => `${source.id}：${source.url}（${source.verifiedOn}；${source.note}）`)
  const document: PublishDocument = {
    schemaVersion: 1,
    platform: 'fanqie',
    bookType: 'long',
    profileVersion: profile.version,
    verifiedOn: profile.verifiedOn,
    contentHash: objectHash({ fields, pendingAuthor, pendingPlatform, sources }),
    fields,
    pendingAuthor,
    pendingPlatform,
    sources,
  }
  const path = await writePublishDocument(root, document)
  return { document, path, validation: validatePublishDocument(document, profile) }
}

export function renderPublishMarkdown(document: PublishDocument): string {
  const title = document.fields.title!.value
  const synopsis = document.fields.synopsis!.status === 'confirmed' ? document.fields.synopsis!.value : ''
  return [
    '> 格式版本：1',
    '> 目标平台：番茄小说',
    '> 作品类型：长篇',
    `> 档案版本：${document.profileVersion}`,
    `> 核验：${document.verifiedOn}；以当前后台为准`,
    `> 内容哈希：${document.contentHash}`,
    '',
    `# 书本名称：${title}`,
    '',
    `- 作者/笔名：${document.fields.penName!.value}`,
    `- 签约模式：${document.fields.signingMode!.value}`,
    `- 目标读者：${document.fields.targetAudience!.value}`,
    `- 主角1：${document.fields.protagonist1!.value}`,
    `- 主角2：${document.fields.protagonist2!.value}`,
    '',
    '## 阅读标签',
    '',
    `- 主分类：${document.fields.readingTags!.value}`,
    '- 主题：',
    '- 角色：',
    '- 情节：',
    '',
    '## 内容标签',
    '',
    `- 情节：${document.fields.contentTags!.value}`,
    '- 情感：',
    '- 人设：',
    '- 世界观：',
    '',
    '## 作品简介',
    '',
    synopsis,
    '',
    '## 待作者确认',
    '',
    ...(document.pendingAuthor.length > 0 ? document.pendingAuthor.map(item => `- ${item}`) : ['无']),
    '',
    '## 待平台核实',
    '',
    ...(document.pendingPlatform.length > 0 ? document.pendingPlatform.map(item => `- ${item}`) : ['无']),
    '',
    '## 来源说明',
    '',
    ...document.sources.map(item => `- ${item}`),
    '',
  ].join('\n')
}

export async function validatePublishMarkdown(root: string, file: string): Promise<PublishValidation> {
  const text = await readTextIfExists(path.resolve(root, file))
  if (!text) throw validationError(`发布资料不存在：${file}`)
  const fail: string[] = []
  const warn: string[] = []
  for (const marker of ['> 格式版本：1', '> 目标平台：番茄小说', '> 作品类型：长篇', '# 书本名称：', '## 待作者确认', '## 待平台核实', '## 来源说明']) {
    if (!text.includes(marker)) fail.push(`缺少结构标记：${marker}`)
  }
  if (!/^# 书本名称：\S+/m.test(text)) warn.push('书名尚未确认')
  const profile = await loadPlatformProfile(root, 'fanqie')
  const title = /^# 书本名称：(.*)$/m.exec(text)?.[1]?.trim() ?? ''
  if ([...title].length > profile.publish.title.maxChars) warn.push(`书名超过 ${profile.publish.title.maxChars} 字，保留原值并需人工核对`)
  const synopsis = /## 作品简介\s+([\s\S]*?)\s+## 待作者确认/.exec(text)?.[1]?.trim() ?? ''
  if ([...synopsis].length > profile.publish.synopsis.maxChars) warn.push(`简介超过 ${profile.publish.synopsis.maxChars} 字，保留原值并需人工核对`)
  if (!synopsis) warn.push('作品简介尚未确认')
  return { fail, warn }
}

function validatePublishDocument(document: PublishDocument, profile: PlatformProfile): PublishValidation {
  const fail: string[] = []
  const warn: string[] = []
  if (!document.fields.title!.value) fail.push('书名必填')
  if ([...document.fields.title!.value].length > profile.publish.title.maxChars) {
    warn.push(`书名超过 ${profile.publish.title.maxChars} 字，保留原值并需人工核对`)
  }
  const synopsis = document.fields.synopsis!.status === 'confirmed'
    ? document.fields.synopsis!.value
    : document.fields.synopsis!.candidate ?? ''
  if ([...synopsis].length > profile.publish.synopsis.maxChars) {
    warn.push(`简介候选超过 ${profile.publish.synopsis.maxChars} 字，需作者压缩后确认`)
  }
  if (document.pendingPlatform.length > 0) warn.push('仍有字段需要以当前平台后台核实')
  return { fail, warn }
}

async function writePublishDocument(root: string, document: PublishDocument): Promise<string> {
  const markdown = renderPublishMarkdown(document)
  const original = path.join(root, '发布资料-番茄小说.md')
  const previous = await readTextIfExists(original)
  if (previous === markdown) return original
  const target = previous === null
    ? original
    : path.join(root, `发布资料-番茄小说-${document.contentHash.slice(7, 15)}.md`)
  if (await readTextIfExists(target)) throw validationError(`发布资料候选已存在但内容不同：${target}`)
  await atomicWrite(target, markdown)
  return target
}

function confirmedOrPending(value: string, source: string): PublishField {
  return value.trim()
    ? { value: value.trim(), status: 'confirmed', source }
    : { value: '', status: 'pending', source: '缺少作者确认值' }
}

function pending(source: string): PublishField {
  return { value: '', status: 'pending', source }
}
