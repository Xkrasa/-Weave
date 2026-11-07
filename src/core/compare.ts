import { readTextIfExists } from './io.ts'
import { currentCommit, finalPath } from './ledger.ts'
import { readDraft } from './stages.ts'
import { hashText } from './hash.ts'
import { conflictError } from './errors.ts'

export interface CompareRow {
  index: number
  status: 'same' | 'changed' | 'added' | 'removed'
  before: string | null
  after: string | null
}

export interface ChapterCompare {
  chapter: number
  base: {
    commitId: string
    revision: number
    contentHash: string
    paragraphs: string[]
  }
  draft: {
    contentHash: string
    paragraphs: string[]
  }
  rows: CompareRow[]
}

/**
 * Read-only paragraph diff between the working draft and the latest finalized commit.
 * It never writes files and never offers a "replace final" path.
 */
export async function compareChapterWithCommit(root: string, chapter: number): Promise<ChapterCompare> {
  const commit = await currentCommit(root, chapter)
  if (!commit) throw conflictError(`第 ${chapter} 章还没有定稿提交，无法对比`)
  const baseText = (await readTextIfExists(finalPath(root, chapter))
    ?? await readTextIfExists(commit.contentPath)
    ?? '')
  const draft = await readDraft(root, chapter).catch(() => '')
  const baseParagraphs = splitParagraphs(baseText)
  const draftParagraphs = splitParagraphs(draft)
  return {
    chapter,
    base: {
      commitId: commit.commitId,
      revision: commit.revision,
      contentHash: hashText(baseText),
      paragraphs: baseParagraphs,
    },
    draft: {
      contentHash: hashText(draft),
      paragraphs: draftParagraphs,
    },
    rows: diffParagraphs(baseParagraphs, draftParagraphs),
  }
}

function splitParagraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)
}

function diffParagraphs(before: string[], after: string[]): CompareRow[] {
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
  const matches: Array<{ before: number; after: number }> = []
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

  const result: CompareRow[] = []
  let b = 0
  let a = 0
  let index = 0
  for (const match of [...matches, { before: before.length, after: after.length }]) {
    const removed = before.slice(b, match.before)
    const added = after.slice(a, match.after)
    const paired = Math.min(removed.length, added.length)
    for (let offset = 0; offset < paired; offset += 1) {
      index += 1
      result.push({ index, status: 'changed', before: removed[offset]!, after: added[offset]! })
    }
    for (const item of removed.slice(paired)) {
      index += 1
      result.push({ index, status: 'removed', before: item, after: null })
    }
    for (const item of added.slice(paired)) {
      index += 1
      result.push({ index, status: 'added', before: null, after: item })
    }
    if (match.before < before.length) {
      index += 1
      result.push({ index, status: 'same', before: before[match.before]!, after: after[match.after]! })
    }
    b = match.before + 1
    a = match.after + 1
  }
  return result
}
