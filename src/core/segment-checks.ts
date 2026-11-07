export interface SegmentCheckInput {
  text: string
  targetWords: number
  previousTail: string
  mustNotHappen: string[]
  pov: string
  goal: string
  exitState: string
}

export interface SegmentCheckResult {
  /** Hard failures that require a retry before the segment can be accepted. */
  passed: boolean
  retryReasons: string[]
  /** Soft observations; they never block a segment. */
  warnings: string[]
  /** Text with a duplicated boundary overlap removed. */
  text: string
  trimmedChars: number
}

export const MIN_LENGTH_RATIO = 0.7
export const MAX_LENGTH_RATIO = 1.4
export const MIN_BOUNDARY_OVERLAP = 40

export function countProseChars(text: string): number {
  return [...text.replace(/\s+/g, '')].length
}

export function checkSegment(input: SegmentCheckInput): SegmentCheckResult {
  const warnings: string[] = []
  const retryReasons: string[] = []
  const { text, trimmedChars } = trimBoundaryOverlap(input.previousTail, input.text)
  if (trimmedChars >= MIN_BOUNDARY_OVERLAP) {
    warnings.push(`已裁掉与上一段重复的 ${trimmedChars} 个字符`)
  }

  const chars = countProseChars(text)
  const min = Math.round(input.targetWords * MIN_LENGTH_RATIO)
  const max = Math.round(input.targetWords * MAX_LENGTH_RATIO)
  if (chars < min) retryReasons.push(`本段过短：${chars} 字，目标 ${input.targetWords} 字（至少 ${min} 字）`)
  if (chars > max) retryReasons.push(`本段过长：${chars} 字，目标 ${input.targetWords} 字（最多 ${max} 字）`)

  for (const banned of input.mustNotHappen) {
    if (banned.trim() && text.includes(banned.trim())) {
      retryReasons.push(`命中本段禁止项：${banned.trim()}`)
    }
  }

  if (input.pov && !text.includes(input.pov)) {
    warnings.push(`本段没有出现视角人物「${input.pov}」`)
  }
  const exitKeywords = meaningfulKeywords(input.exitState)
  if (exitKeywords.length > 0 && !exitKeywords.some(keyword => text.includes(keyword))) {
    warnings.push(`未检测到退出状态关键词：${exitKeywords.join('、')}`)
  }

  return {
    passed: retryReasons.length === 0,
    retryReasons,
    warnings,
    text,
    trimmedChars,
  }
}

/** Longest suffix of the previous tail that is also a prefix of the new segment, capped at 600 chars. */
export function trimBoundaryOverlap(previousTail: string, text: string): { text: string; trimmedChars: number } {
  const tail = previousTail.trim()
  if (!tail) return { text, trimmedChars: 0 }
  let overlap = Math.min(tail.length, text.length, 600)
  while (overlap >= MIN_BOUNDARY_OVERLAP && tail.slice(-overlap) !== text.slice(0, overlap)) overlap -= 1
  if (overlap < MIN_BOUNDARY_OVERLAP) return { text, trimmedChars: 0 }
  return { text: text.slice(overlap).replace(/^\s+/, ''), trimmedChars: overlap }
}

export function meaningfulKeywords(state: string): string[] {
  return state
    .split(/[，。；、！？：""''（）()\s]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
    .slice(0, 6)
}

