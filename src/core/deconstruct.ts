import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { conflictError } from './errors.ts'

export interface DeconstructReport {
  source: string
  format: 'txt' | 'md' | 'epub'
  provenance: 'reference'
  savedPath?: string
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

export async function deconstructFile(
  file: string,
  options: { splitPattern?: string } = {},
): Promise<DeconstructReport> {
  const ext = path.extname(file).toLowerCase()
  if (ext !== '.txt' && ext !== '.md' && ext !== '.epub') {
    throw conflictError('拆书支持 txt、md 或 epub 文件')
  }
  const text = ext === '.epub'
    ? ''
    : (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const chapters = ext === '.epub'
    ? await epubChapters(file)
    : splitChapters(text, ext === '.md', options.splitPattern)
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
    format: ext === '.epub' ? 'epub' : ext === '.md' ? 'md' : 'txt',
    provenance: 'reference',
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

async function epubChapters(file: string): Promise<Array<{ title: string; text: string }>> {
  const bytes = new Uint8Array(await readFile(file))
  const zip = unzipSync(bytes)
  const readEntry = (name: string): string | null => {
    const data = zip[name]
    return data ? new TextDecoder('utf-8').decode(data) : null
  }
  const container = readEntry('META-INF/container.xml')
  const rootPath = container ? /full-path="([^"]+)"/.exec(container)?.[1] : undefined
  const opfPath = rootPath ?? Object.keys(zip).find(name => name.endsWith('.opf'))
  const opf = opfPath ? readEntry(opfPath) : null
  const manifest = new Map<string, string>()
  if (opf) {
    for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
      const tag = match[0]
      const id = /\bid="([^"]+)"/.exec(tag)?.[1]
      const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
      const type = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? ''
      if (id && href && /html|xml/.test(type)) manifest.set(id, href)
    }
  }
  const spine: string[] = []
  if (opf) {
    for (const match of opf.matchAll(/<itemref\b[^>]*>/g)) {
      const idref = /\bidref="([^"]+)"/.exec(match[0])?.[1]
      if (idref && manifest.has(idref)) spine.push(manifest.get(idref)!)
    }
  }
  const base = opfPath ? path.posix.dirname(opfPath) : ''
  const names = spine.length > 0
    ? spine.map(href => path.posix.normalize(path.posix.join(base, decodeURIComponent(href))))
    : Object.keys(zip).filter(name => /\.(xhtml|html)$/i.test(name)).sort()
  const chapters: Array<{ title: string; text: string }> = []
  for (const name of names) {
    const html = readEntry(name)
    if (!html) continue
    const title = htmlTitle(html) || path.posix.basename(name, path.extname(name))
    const text = htmlToText(html)
    if (text.trim()) chapters.push({ title, text })
  }
  if (chapters.length === 0) throw conflictError('EPUB 中没有可读取的正文 spine')
  return chapters
}

function htmlTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)?.[1]
  return decodeEntities((title ?? heading ?? '').replace(/<[^>]+>/g, '')).trim().slice(0, 100)
}

function htmlToText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
  return decodeEntities(body.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function splitChapters(
  text: string,
  markdown: boolean,
  splitPattern?: string,
): Array<{ title: string; text: string }> {
  const lines = text.split('\n')
  const chapters: Array<{ title: string; text: string[] }> = []
  let current: { title: string; text: string[] } | null = null
  const custom = splitPattern ? new RegExp(splitPattern, 'm') : null
  for (const line of lines) {
    const customTitle = custom?.test(line.trim()) ? line.trim().slice(0, 80) : null
    const title = customTitle ?? chapterTitle(line, markdown)
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
