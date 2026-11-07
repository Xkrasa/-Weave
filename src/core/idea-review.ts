import type { ReviewFinding } from './stage-types.ts'
import type { ChapterContract } from './types.ts'
import { ideaScopeMatches, listIdeas, readIdea } from './ideas.ts'
import { meaningfulKeywords } from './segment-checks.ts'

const REVIEW_DIMENSION = '想法回灌'

/**
 * Deterministic soft checks for promoted ideas. They only ever produce warning/info findings,
 * so the finalize gate stays exactly the same. Inbox and archived ideas are never inspected.
 */
export async function collectIdeaReviewFindings(
  root: string,
  contract: ChapterContract,
  draft: string,
  options: { includeBookIdeas?: boolean } = {},
): Promise<ReviewFinding[]> {
  const ideas = (await listIdeas(root, { status: 'promoted' }))
    .filter(idea => idea.promotionState === 'active' && ideaScopeMatches(idea, contract, options))
  const findings: ReviewFinding[] = []
  for (const idea of ideas) {
    const { meta, body } = await readIdea(root, idea.id)
    const forbidden = (contract.mustNotHappen ?? [])
      .map(item => item.trim())
      .find(item => item && (body.includes(item) || meta.title.includes(item)))
    if (forbidden) {
      findings.push({
        findingId: `idea-${idea.id}-conflict`,
        dimension: REVIEW_DIMENSION,
        severity: 'warning',
        description: `想法「${meta.title}」与合同禁区「${forbidden}」冲突；合同优先，想法不得写成已发生剧情。`,
        status: 'open',
      })
      continue
    }
    if (!mentionsIdea(draft, meta.title, meta.tags)) {
      findings.push({
        findingId: `idea-${idea.id}-unused`,
        dimension: REVIEW_DIMENSION,
        severity: 'info',
        description: `晋升想法「${meta.title}」在本章正文中未出现；若本章不推进它，可忽略此提示。`,
        status: 'open',
      })
    }
  }
  return findings
}

/** Conservative proxy: a title, tag, title keyword, or 4-character title shingle must appear verbatim. */
function mentionsIdea(draft: string, title: string, tags: string[]): boolean {
  const terms = [title, ...tags, ...meaningfulKeywords(title)]
    .map(term => term.trim())
    .filter(term => term.length >= 2)
  if (terms.some(term => draft.includes(term))) return true
  const characters = [...title]
  for (let index = 0; index + 4 <= characters.length; index += 1) {
    if (draft.includes(characters.slice(index, index + 4).join(''))) return true
  }
  return false
}
