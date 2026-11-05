import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { conflictError } from './errors.ts'

export interface DeconstructReport {
  source: string
  format: 'txt' | 'md'
  requiresManualSplit: boolean
  chapters: Array<{
    index: number
    title: string
    characters: number
    paragraphs: number
    dialogueRatio: number
    openingExcerpt: string
    endingExcerpt: string
    structureTags: string[]
    sceneFunctions: string[]
    suspensePositions: number[]
    repeatedPatterns: string[]
  }>
  totals: {
    chapters: number
    characters: number
    averageChapterCharacters: number
    dialogueRatio: number
  }
  notice: string
}

export async function deconstructFile(file: string): Promise<DeconstructReport> {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.epub') throw conflictError('当前版本暂不支持 EPUB 拆书；请先转为 txt 或 md')
  if (ext !== '.txt' && ext !== '.md') throw conflictError('拆书只支持 txt 或 md 文件')
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const chapters = splitChapters(text, ext === '.md')
  const reportChapters = chapters.map((chapter, index) => {
    const paragraphs = chapter.text.split(/\n{2,}/).filter(item => item.trim())
    const dialogue = (chapter.text.match(/“[^”]*”|"[^"]*"/g) ?? []).join('')
    const characters = [...chapter.text.replace(/\s/g, '')].length
    return {
      index: index + 1,
      title: chapter.title,
      characters,
      paragraphs: paragraphs.length,
      dialogueRatio: characters === 0 ? 0 : [...dialogue].length / characters,
      openingExcerpt: excerpt(chapter.text, 'start'),
      endingExcerpt: excerpt(chapter.text, 'end'),
      structureTags: structureTags(chapter.text),
      sceneFunctions: sceneFunctions(chapter.text),
      suspensePositions: suspensePositions(chapter.text),
      repeatedPatterns: repeatedPatterns(chapter.text),
    }
  })
  const totalCharacters = reportChapters.reduce((sum, item) => sum + item.characters, 0)
  const dialogue = (text.match(/“[^”]*”|"[^"]*"/g) ?? []).join('')
  return {
    source: path.basename(file),
    format: ext === '.md' ? 'md' : 'txt',
    requiresManualSplit: chapters.length <= 1,
    chapters: reportChapters,
    totals: {
      chapters: reportChapters.length,
      characters: totalCharacters,
      averageChapterCharacters: reportChapters.length === 0 ? 0 : Math.round(totalCharacters / reportChapters.length),
      dialogueRatio: totalCharacters === 0
        ? 0
        : [...dialogue].length / Math.max(1, [...text.replace(/\s/g, '')].length),
    },
    notice: '仅供参考结构；不是项目事实，不得直接进入正文或 Canon。',
  }
}

function splitChapters(text: string, markdown: boolean): Array<{ title: string; text: string }> {
  const lines = text.split('\n')
  const chapters: Array<{ title: string; text: string[] }> = []
  let current: { title: string; text: string[] } | null = null
  for (const line of lines) {
    const title = chapterTitle(line, markdown)
    if (title) {
      if (current) chapters.push(current)
      current = { title, text: [] }
      continue
    }
    if (!current) current = { title: '开篇', text: [] }
    current.text.push(line)
  }
  if (current) chapters.push(current)
  if (chapters.length === 0) return [{ title: '全文', text }]
  return chapters.map(chapter => ({ title: chapter.title, text: chapter.text.join('\n') }))
}

function chapterTitle(line: string, markdown: boolean): string | null {
  const trimmed = line.trim()
  if (markdown && /^#{1,3}\s+/.test(trimmed)) return trimmed.replace(/^#{1,3}\s+/, '')
  if (/^第[一二三四五六七八九十百千万\d]+章(?:[\s:：、.-]|$)/.test(trimmed)) return trimmed.slice(0, 80)
  if (/^Chapter\s+\d+/i.test(trimmed)) return trimmed.slice(0, 80)
  return null
}

function excerpt(text: string, where: 'start' | 'end'): string {
  const trimmed = text.trim()
  const parts = [...trimmed]
  const slice = where === 'start' ? parts.slice(0, 80) : parts.slice(-80)
  return slice.join('')
}

function structureTags(text: string): string[] {
  const tags: string[] = []
  if (/[？！?!]/.test(text)) tags.push('high-tension')
  if (/[“”"]/.test(text)) tags.push('dialogue-driven')
  if (text.length > 1200) tags.push('long-scene')
  if (text.length < 300) tags.push('short-scene')
  return tags
}

function sceneFunctions(text: string): string[] {
  const functions: string[] = []
  if (/因为|所以|于是|结果/.test(text)) functions.push('causal-turn')
  if (/但是|却|然而|反而/.test(text)) functions.push('reversal')
  if (/决定|选择|必须|不能/.test(text)) functions.push('decision')
  if (/发现|意识到|明白/.test(text)) functions.push('reveal')
  return functions
}

function suspensePositions(text: string): number[] {
  const positions: number[] = []
  const characters = [...text]
  for (let index = 0; index < characters.length; index += 1) {
    if ('？！?!…'.includes(characters[index]!)) {
      positions.push(Math.round((index / Math.max(1, characters.length)) * 100))
    }
  }
  return [...new Set(positions)].slice(0, 8)
}

function repeatedPatterns(text: string): string[] {
  const counts = new Map<string, number>()
  const chars = [...text.replace(/\s/g, '')]
  for (let index = 0; index + 4 <= chars.length; index += 1) {
    const pattern = chars.slice(index, index + 4).join('')
    if (/^[\u4e00-\u9fff]{4}$/.test(pattern)) {
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pattern]) => pattern)
}
