import type { ChapterContract, ModelConfig } from './types.ts'
import type { DraftParagraph } from './stage-types.ts'
import { readDraft } from './stages.ts'
import { rewriteParagraph } from './revisions.ts'

export const KEY_FOCUS = ['opening', 'choice', 'climax', 'ending'] as const
export type KeyFocus = typeof KEY_FOCUS[number]

export interface KeyCandidateGroup {
  focus: KeyFocus
  paragraphId: string
  revisionIds: string[]
}

const MAX_CANDIDATES = 2
const MAX_FOCUS = 2

/**
 * Key chapters get a small number of candidates for the passages readers notice most.
 * Ordinary chapters keep the single-pass path; nothing here can auto-finalize.
 */
export async function generateKeyCandidates(
  root: string,
  chapter: number,
  contract: ChapterContract,
  config: ModelConfig,
  signal: AbortSignal,
): Promise<KeyCandidateGroup[]> {
  const draft = await readDraft(root, chapter)
  const paragraphs = splitParagraphs(draft)
  if (paragraphs.length === 0) return []
  const focuses = (contract.keyFocus ?? ['opening', 'ending'])
    .filter((focus): focus is KeyFocus => (KEY_FOCUS as readonly string[]).includes(focus))
    .slice(0, MAX_FOCUS)
  const groups: KeyCandidateGroup[] = []
  for (const focus of focuses) {
    const target = pickParagraph(paragraphs, focus)
    const revisionIds: string[] = []
    for (let index = 0; index < MAX_CANDIDATES; index += 1) {
      try {
        const candidate = await rewriteParagraph(
          root,
          chapter,
          target.paragraphId,
          focusGoal(focus, index),
          config,
          signal,
        )
        revisionIds.push(candidate.revisionId)
      } catch {
        // A failed candidate must not discard the draft or the other candidates.
      }
    }
    if (revisionIds.length > 0) {
      groups.push({ focus, paragraphId: target.paragraphId, revisionIds })
    }
  }
  return groups
}

function splitParagraphs(draft: string): DraftParagraph[] {
  const paragraphs: DraftParagraph[] = []
  for (const part of draft.split(/\n{2,}/)) {
    const text = part.trim()
    if (!text) continue
    paragraphs.push({
      paragraphId: `p${String(paragraphs.length + 1).padStart(3, '0')}`,
      text,
    })
  }
  return paragraphs
}

function pickParagraph(paragraphs: DraftParagraph[], focus: KeyFocus): DraftParagraph {
  if (focus === 'opening') return paragraphs[0]!
  if (focus === 'ending') return paragraphs[paragraphs.length - 1]!
  if (focus === 'climax') {
    return [...paragraphs].sort((a, b) => [...b.text].length - [...a.text].length)[0]!
  }
  const middle = paragraphs.slice(1, -1)
  const signal = /选择|决定|还是|代价|必须|不能/
  return middle.find(paragraph => signal.test(paragraph.text)) ?? middle[0] ?? paragraphs[0]!
}

function focusGoal(focus: KeyFocus, index: number): string {
  const goals: Record<KeyFocus, string> = {
    opening: '开头更快进入具体场景：用动作、对话或一个未解决的问题抓住读者，不要环境铺垫。',
    choice: '把这一段的犹豫改成一次明确选择：写出代价，以及选择后不能回头的理由。',
    climax: '让这一段成为本章最紧张的地方：缩短句子，放大动作与反应，避免概述。',
    ending: '结尾留下一个具体的、下一章必须回答的问题，不要总结人物心情。',
  }
  return index === 0
    ? goals[focus]
    : `${goals[focus]} 这是第二个版本，请选择与通常写法不同的进入方式。`
}
