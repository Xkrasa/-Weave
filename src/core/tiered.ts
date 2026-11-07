import type { ChapterContract, ModelConfig } from './types.ts'
import type { DraftParagraph } from './stage-types.ts'
import type { EffectFinding, EffectReviewReport } from './effect-review.ts'
import { draftHash, loadStage, readDraft } from './stages.ts'
import { rewriteParagraph, reviseSelection } from './revisions.ts'

export const KEY_FOCUS = ['opening', 'choice', 'climax', 'ending'] as const
export type KeyFocus = typeof KEY_FOCUS[number]

export interface KeyCandidateGroup {
  focus: KeyFocus
  paragraphId: string
  paragraphIds: string[]
  excerpt: string
  revisionIds: string[]
}

const MAX_CANDIDATES = 2
const MAX_FOCUS = 2
const PASSAGE_TARGET_CHARS = 280

/**
 * Key chapters get a small number of candidates for the passages readers notice most.
 * Ordinary chapters keep the single-pass path; nothing here can auto-finalize.
 *
 * When an up-to-date effect-review report exists, its findings guide focus selection and
 * passage targeting; multi-paragraph passages use selection revision while single paragraphs
 * stay compatible with paragraph merge.
 */
export async function generateKeyCandidates(
  root: string,
  chapter: number,
  contract: ChapterContract,
  config: ModelConfig,
  signal: AbortSignal,
  options: { focuses?: KeyFocus[]; passageChars?: number } = {},
): Promise<KeyCandidateGroup[]> {
  const draft = await readDraft(root, chapter)
  const currentHash = draftHash(draft)
  const paragraphs = splitParagraphs(draft)
  if (paragraphs.length === 0) return []
  const effectReport = await loadStage<EffectReviewReport>(root, 'effect-review', chapter).catch(() => null)
  const activeEffect = effectReport && effectReport.draftHash === currentHash ? effectReport : null

  const requested = options.focuses
    ?? deriveFocusesFromEffect(activeEffect)
    ?? contract.keyFocus
    ?? ['opening', 'ending']
  const focuses = requested
    .filter((focus): focus is KeyFocus => (KEY_FOCUS as readonly string[]).includes(focus))
    .slice(0, MAX_FOCUS)

  const targetChars = options.passageChars ?? PASSAGE_TARGET_CHARS
  const groups: KeyCandidateGroup[] = []
  for (const focus of focuses) {
    const passage = pickPassage(paragraphs, focus, activeEffect, targetChars)
    if (passage.length === 0) continue
    const primary = passage[0]!
    const excerpt = passage.map(item => item.text).join('\n\n')
    const revisionIds: string[] = []
    for (let index = 0; index < MAX_CANDIDATES; index += 1) {
      const goal = focusGoal(focus, index, activeEffect)
      try {
        if (passage.length === 1) {
          const candidate = await rewriteParagraph(
            root,
            chapter,
            primary.paragraphId,
            goal,
            config,
            signal,
          )
          revisionIds.push(candidate.revisionId)
        } else {
          const candidate = await reviseSelection(
            root,
            chapter,
            {
              baseDraftHash: currentHash,
              selectedText: excerpt,
              occurrence: 1,
              operation: 'custom',
              instruction: goal,
            },
            config,
            signal,
          )
          revisionIds.push(candidate.revisionId)
        }
      } catch {
        // A failed candidate must not discard the draft or the other candidates.
      }
    }
    if (revisionIds.length > 0) {
      groups.push({
        focus,
        paragraphId: primary.paragraphId,
        paragraphIds: passage.map(item => item.paragraphId),
        excerpt,
        revisionIds,
      })
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

function deriveFocusesFromEffect(report: EffectReviewReport | null): KeyFocus[] | null {
  if (!report || report.findings.length === 0) return null
  const found: KeyFocus[] = []
  const push = (focus: KeyFocus) => {
    if (!found.includes(focus)) found.push(focus)
  }
  for (const finding of report.findings) {
    if (finding.status === 'ignored') continue
    if (/章末|追读|钩子/.test(finding.dimension)) push('ending')
    else if (/期待|环境|开篇/.test(finding.dimension)) push('opening')
    else if (/张力|情绪/.test(finding.dimension)) push('climax')
  }
  return found.length > 0 ? found.slice(0, MAX_FOCUS) : null
}

function pickPassage(
  paragraphs: DraftParagraph[],
  focus: KeyFocus,
  effectReport: EffectReviewReport | null,
  targetChars: number,
): DraftParagraph[] {
  // Single-paragraph short drafts keep backward-compatible single-paragraph behaviour when
  // the whole draft is short (e.g. unit test fixtures).
  const totalChars = paragraphs.reduce((sum, item) => sum + [...item.text].length, 0)
  const allowMulti = totalChars >= Math.min(targetChars, 160)

  const findingMatch = findEffectParagraphIndex(paragraphs, focus, effectReport)
  if (findingMatch !== null) {
    return expandWindow(paragraphs, findingMatch, allowMulti ? targetChars : 0)
  }
  if (focus === 'opening') {
    return expandFromStart(paragraphs, allowMulti ? targetChars : 0)
  }
  if (focus === 'ending') {
    return expandFromEnd(paragraphs, allowMulti ? targetChars : 0)
  }
  if (focus === 'climax') {
    const longest = [...paragraphs].sort((a, b) => [...b.text].length - [...a.text].length)[0]!
    const idx = paragraphs.findIndex(item => item.paragraphId === longest.paragraphId)
    return expandWindow(paragraphs, Math.max(0, idx), allowMulti ? targetChars : 0)
  }
  const middle = paragraphs.slice(1, -1)
  const signal = /选择|决定|还是|代价|必须|不能/
  const chosen = middle.find(paragraph => signal.test(paragraph.text)) ?? middle[0] ?? paragraphs[0]!
  const idx = paragraphs.findIndex(item => item.paragraphId === chosen.paragraphId)
  return expandWindow(paragraphs, Math.max(0, idx), allowMulti ? targetChars : 0)
}

function findEffectParagraphIndex(
  paragraphs: DraftParagraph[],
  focus: KeyFocus,
  report: EffectReviewReport | null,
): number | null {
  if (!report) return null
  const dimPattern = focus === 'ending'
    ? /章末|追读/
    : focus === 'opening'
      ? /期待|环境/
      : focus === 'climax'
        ? /张力|情绪/
        : /人物|选择/
  const finding: EffectFinding | undefined = report.findings.find(
    item => item.quote && dimPattern.test(item.dimension),
  )
  if (!finding?.quote) return null
  const idx = paragraphs.findIndex(paragraph => paragraph.text.includes(finding.quote!))
  return idx >= 0 ? idx : null
}

function expandFromStart(paragraphs: DraftParagraph[], targetChars: number): DraftParagraph[] {
  const result: DraftParagraph[] = [paragraphs[0]!]
  let chars = [...paragraphs[0]!.text].length
  for (let i = 1; i < paragraphs.length && chars < targetChars; i += 1) {
    result.push(paragraphs[i]!)
    chars += [...paragraphs[i]!.text].length
  }
  return result
}

function expandFromEnd(paragraphs: DraftParagraph[], targetChars: number): DraftParagraph[] {
  const last = paragraphs[paragraphs.length - 1]!
  const result: DraftParagraph[] = [last]
  let chars = [...last.text].length
  for (let i = paragraphs.length - 2; i >= 0 && chars < targetChars; i -= 1) {
    result.unshift(paragraphs[i]!)
    chars += [...paragraphs[i]!.text].length
  }
  return result
}

function expandWindow(paragraphs: DraftParagraph[], center: number, targetChars: number): DraftParagraph[] {
  const base = paragraphs[center]!
  const result: DraftParagraph[] = [base]
  let chars = [...base.text].length
  let left = center - 1
  let right = center + 1
  while (chars < targetChars && (left >= 0 || right < paragraphs.length)) {
    if (right < paragraphs.length) {
      result.push(paragraphs[right]!)
      chars += [...paragraphs[right]!.text].length
      right += 1
    }
    if (chars < targetChars && left >= 0) {
      result.unshift(paragraphs[left]!)
      chars += [...paragraphs[left]!.text].length
      left -= 1
    }
  }
  return result
}

function focusGoal(focus: KeyFocus, index: number, effectReport: EffectReviewReport | null): string {
  const goals: Record<KeyFocus, string> = {
    opening: '开头更快进入具体场景：用动作、对话或一个未解决的问题抓住读者，不要环境铺垫。',
    choice: '把这一段的犹豫改成一次明确选择：写出代价，以及选择后不能回头的理由。',
    climax: '让这一段成为本章最紧张的地方：缩短句子，放大动作与反应，避免概述。',
    ending: '结尾留下一个具体的、下一章必须回答的问题，不要总结人物心情。',
  }
  const note = effectReport?.findings.find(item =>
    (focus === 'ending' && /章末|追读/.test(item.dimension))
    || (focus === 'opening' && /期待|环境/.test(item.dimension))
    || (focus === 'climax' && /张力|情绪/.test(item.dimension)),
  )?.description
  const base = note ? `${goals[focus]}（针对效果审查意见：${note}）` : goals[focus]
  return index === 0
    ? base
    : `${base} 这是第二个版本，请选择与通常写法不同的进入方式。`
}
