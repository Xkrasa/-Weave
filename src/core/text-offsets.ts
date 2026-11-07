import type { EvidenceSpan } from './stage-types.ts'

export interface OffsetTable {
  /** UTF-8 byte offset → UTF-16 code-unit offset usable by browser selection APIs. */
  byteToChar: (byteOffset: number) => number
  /** UTF-16 code-unit offset → UTF-8 byte offset. */
  charToByte: (charOffset: number) => number
  /** 1-based line number for a UTF-16 code-unit offset. */
  lineAt: (charOffset: number) => number
}

export interface EvidenceLocation {
  charStart: number
  charEnd: number
  line: number
  matched: boolean
}

const encoder = new TextEncoder()

/**
 * Builds prefix tables over code points. Both CJK (3 bytes) and astral emoji (4 bytes,
 * surrogate pair in UTF-16) are handled because byte and char prefixes advance together
 * for each code point rather than each code unit.
 */
export function buildOffsetTable(text: string): OffsetTable {
  const byteOffsets: number[] = [0]
  const charOffsets: number[] = [0]
  const newlines: number[] = []
  let byte = 0
  let char = 0
  for (const codePoint of text) {
    byte += encoder.encode(codePoint).length
    char += codePoint.length
    byteOffsets.push(byte)
    charOffsets.push(char)
    if (codePoint === '\n') newlines.push(char - 1)
  }

  return {
    byteToChar: byteOffset => charOffsets[greatestIndexAtMost(byteOffsets, byteOffset)]!,
    charToByte: charOffset => byteOffsets[greatestIndexAtMost(charOffsets, charOffset)]!,
    lineAt: charOffset => countBelow(newlines, charOffset) + 1,
  }
}

/** Greatest index whose value is ≤ target, falling back to 0 for negative targets. */
function greatestIndexAtMost(values: number[], target: number): number {
  let low = 0
  let high = values.length - 1
  let result = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! <= target) {
      result = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}

function countBelow(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

function occurrencesOf(text: string, needle: string): number[] {
  const positions: number[] = []
  if (!needle) return positions
  let index = text.indexOf(needle)
  while (index >= 0) {
    positions.push(index)
    index = text.indexOf(needle, index + Math.max(1, needle.length))
  }
  return positions
}

/**
 * Locates a quote by `occurrence` alone. Used when a report has a quote but no byte span.
 * A missing quote yields matched:false so the UI never jumps to a guessed position.
 */
export function locateQuote(
  text: string,
  quote: string,
  occurrence = 1,
  table: OffsetTable = buildOffsetTable(text),
): EvidenceLocation {
  const positions = occurrencesOf(text, quote)
  if (positions.length === 0) return { charStart: 0, charEnd: 0, line: 1, matched: false }
  const index = occurrence >= 1 && occurrence <= positions.length ? occurrence - 1 : 0
  const charStart = positions[index]!
  return {
    charStart,
    charEnd: charStart + quote.length,
    line: table.lineAt(charStart),
    matched: true,
  }
}

/**
 * Resolves a byte-based EvidenceSpan to browser offsets. The quote + occurrence is the
 * primary locator; the stored byteStart must agree with it. A mismatch is surfaced as
 * matched:false instead of silently selecting the wrong occurrence.
 */
export function resolveEvidence(
  text: string,
  span: EvidenceSpan,
  table: OffsetTable = buildOffsetTable(text),
): EvidenceLocation {
  const positions = occurrencesOf(text, span.quote)
  const occurrence = span.occurrence
  if (positions.length > 0 && Number.isSafeInteger(occurrence) && occurrence >= 1 && occurrence <= positions.length) {
    const charStart = positions[occurrence - 1]!
    const charEnd = charStart + span.quote.length
    const expectedStart = table.charToByte(charStart)
    const expectedEnd = table.charToByte(charEnd)
    return {
      charStart,
      charEnd,
      line: table.lineAt(charStart),
      matched: span.byteStart === expectedStart && span.byteEnd === expectedEnd,
    }
  }

  const charStart = table.byteToChar(span.byteStart)
  const charEnd = table.byteToChar(span.byteEnd)
  return {
    charStart,
    charEnd,
    line: table.lineAt(charStart),
    matched: false,
  }
}
