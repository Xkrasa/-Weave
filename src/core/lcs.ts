export interface LcsMatch {
  /** Index in the left sequence. */
  before: number
  /** Index in the right sequence. */
  after: number
}

/**
 * Longest-common-subsequence match pairs. Both diff callers only need the matching
 * positions; each caller expands the gaps into its own output shape (paragraph rows or
 * a unified diff string).
 */
export function lcsMatches<T>(before: readonly T[], after: readonly T[]): LcsMatch[] {
  const rows = before.length + 1
  const cols = after.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const matches: LcsMatch[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      matches.push({ before: i, after: j })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1
    } else {
      j += 1
    }
  }
  return matches
}
