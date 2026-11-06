import path from 'node:path'
import { listFiles, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { validationError } from './errors.ts'

export interface PlatformSource {
  id: string
  url: string
  kind: string
  verifiedOn: string
  note: string
}

export interface PlatformProfile {
  schemaVersion: 1
  platform: 'fanqie'
  version: number
  verifiedOn: string
  scope: string
  audience: string[]
  sources: PlatformSource[]
  reviewFocus: string[]
  publish: {
    title: { required: boolean; maxChars: number }
    signingMode: { required: boolean; choices: string[]; requiresAccountReview: boolean }
    targetAudience: { required: boolean; choices: string[]; requiresExplicitAuthorChoice: boolean }
    protagonists: { required: boolean; maxPerPerson: number; maxPeople: number }
    synopsis: { required: boolean; maxChars: number; minimumUnverified: boolean }
    readingTags: {
      requiresTargetAudience: boolean
      mainCategoryRequired: boolean
      mainCategorySingleChoice: boolean
      lockedAfterSigning: boolean
    }
    contentTags: { minimumRequired: boolean }
    cover: { required: boolean; width: number; height: number; maxBytes: number; requiresTitleAndPenName: boolean }
  }
  pendingPlatformVerification: string[]
}

export async function loadPlatformProfile(root: string, platform = 'fanqie'): Promise<PlatformProfile> {
  if (platform !== 'fanqie') throw validationError(`暂不支持的平台档案：${platform}`)
  const file = path.join(projectPaths(root).canon, 'platforms', `${platform}.json`)
  const profile = await readJsonIfExists<PlatformProfile>(file)
  if (!profile) throw validationError(`缺少平台档案：${file}`)
  validateProfile(profile)
  return profile
}

export async function listPlatformProfiles(root: string): Promise<string[]> {
  return (await listFiles(path.join(projectPaths(root).canon, 'platforms')))
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace(/\.json$/i, ''))
}

export function platformReviewPrompt(profile: PlatformProfile): string {
  return [
    `目标平台档案：${profile.platform} v${profile.version}，核验日期 ${profile.verifiedOn}。`,
    `适用范围：${profile.scope}`,
    `软效果维度：${profile.reviewFocus.join('；')}`,
    '这些只用于 warning/info，不是平台算法、完读率证据或固定配额；当前平台界面与档案冲突时必须标记待作者核实。',
  ].join('\n')
}

function validateProfile(profile: PlatformProfile): void {
  if (profile.schemaVersion !== 1) throw validationError('平台档案 schemaVersion 必须为 1')
  if (profile.platform !== 'fanqie') throw validationError('平台档案 platform 必须是 fanqie')
  if (!Number.isSafeInteger(profile.version) || profile.version < 1) throw validationError('平台档案 version 必须是正整数')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.verifiedOn)) throw validationError('平台档案 verifiedOn 必须是 YYYY-MM-DD')
  if (!profile.scope.trim() || !Array.isArray(profile.reviewFocus) || profile.reviewFocus.length === 0) {
    throw validationError('平台档案必须声明适用范围和软效果维度')
  }
  if (!Array.isArray(profile.sources) || profile.sources.some(source => !source.id || !source.url || !source.verifiedOn)) {
    throw validationError('平台档案 sources 必须包含 id、url 和 verifiedOn')
  }
  if (!Array.isArray(profile.pendingPlatformVerification)) throw validationError('平台档案必须列出待平台核实事项')
  if (!Number.isSafeInteger(profile.publish?.title?.maxChars) || profile.publish.title.maxChars < 1) {
    throw validationError('平台档案书名字段配置非法')
  }
}
