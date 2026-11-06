import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import {
  loadContract,
  normalizeContract,
  saveContract,
  writeContractCheck,
  requirePassingContractCheck,
} from './contract.ts'
import { runContentCheck } from './content-check.ts'
import { runExtraction } from './extraction.ts'
import { runCoverageAudit } from './audit.ts'
import { runReview } from './review.ts'
import { applyWaivers, createWaivers, loadWaivers, revokeWaiver } from './waivers.ts'
import {
  ignoreFinding,
  loadRevision,
  mergeRevision,
  recheckChapter,
  reviseChapter,
} from './revisions.ts'
import { amendChapter, finalizeChapter, writeChapter } from './writing.ts'
import { doctor, exportBook, projectStatus } from './services.ts'
import { loadModelConfig, projectPaths } from './project.ts'
import { draftHash, loadStage, readDraft, saveStage } from './stages.ts'
import { saveDraft } from './runs.ts'
import { listFiles, readJsonIfExists } from './io.ts'
import { readSearchChunk, searchBook } from './search.ts'
import { deconstructFile } from './deconstruct.ts'
import { selectMethods, styleCheck } from './methods.ts'
import { WeaveError, conflictError, usageError, validationError } from './errors.ts'
import type {
  ContentCheckReport,
  CoverageAudit,
  ExtractionReport,
  ReviewReport,
  RevisionCandidate,
} from './stage-types.ts'
import type { ChapterContract } from './types.ts'

export interface UiServerOptions {
  port?: number
  host?: string
  token?: string
}

export interface UiServer {
  server: Server
  url: string
  port: number
  token: string
  close: () => Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export async function startUiServer(root: string, options: UiServerOptions = {}): Promise<UiServer> {
  const token = options.token ?? randomBytes(24).toString('hex')
  const host = options.host ?? '127.0.0.1'
  const server = createServer((request, response) => {
    void handle(root, request, response, token).catch(error => sendError(response, error))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法确定 UI 端口')
  return {
    server,
    url: `http://${host}:${address.port}`,
    port: address.port,
    token,
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

async function handle(root: string, request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const host = request.headers.host?.split(':')[0]
  if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new WeaveError('FORBIDDEN', '只允许本机访问', 2)
  }
  const origin = request.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
    throw new WeaveError('FORBIDDEN', '拒绝跨源请求', 2)
  }
  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(response, url.pathname)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    sendJson(response, 200, {
      token,
      status: await projectStatus(root),
    })
    return
  }
  if (request.method !== 'GET' && request.headers['x-weave-token'] !== token) {
    sendJson(response, 401, {
      error: { code: 'UNAUTHORIZED', message: '缺少或错误的本地会话令牌', exitCode: 2 },
    })
    return
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const chapter = parts[1] === 'chapters' ? Number(parts[2]) : 0
  if (parts[1] === 'chapters' && parts[2] && (!Number.isSafeInteger(chapter) || chapter <= 0)) {
    throw usageError('章节号必须是正整数')
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, await projectStatus(root))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/doctor') {
    sendJson(response, 200, await doctor(root))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/chapters') {
    sendJson(response, 200, await chapterList(root))
    return
  }
  if (chapter && parts[3] === 'draft') {
    if (request.method === 'GET') {
      const content = await readDraft(root, chapter)
      sendJson(response, 200, { chapter, content, hash: draftHash(content) })
      return
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody<{ content?: string; baseHash?: string }>(request)
      const current = await readDraft(root, chapter)
      if (body.baseHash && body.baseHash !== draftHash(current)) {
        throw conflictError('草稿已在其他窗口修改；请刷新后再保存')
      }
      if (typeof body.content !== 'string') throw validationError('content 必须是字符串')
      await saveDraft(root, chapter, body.content)
      sendJson(response, 200, { chapter, hash: draftHash(body.content) })
      return
    }
  }
  if (chapter && request.method === 'POST' && parts[3] === 'contract-check') {
    const contract = await loadContract(root, chapter)
    const check = await writeContractCheck(root, contract)
    sendJson(response, 200, check)
    return
  }
  if (chapter && request.method === 'POST' && parts[3] === 'stage' && parts[4]) {
    sendJson(response, 200, await runStage(root, chapter, parts[4]))
    return
  }
  if (chapter && request.method === 'POST' && parts[3] === 'write') {
    const result = await writeChapter(root, chapter, { signal: new AbortController().signal })
    sendJson(response, 200, result)
    return
  }
  if (chapter && request.method === 'POST' && parts[3] === 'revise') {
    const body = await readJsonBody<{ findings?: string[] }>(request)
    if (!Array.isArray(body.findings) || body.findings.length === 0) {
      throw usageError('请选择至少一个 finding')
    }
    const config = await loadModelConfig(root)
    const result = await reviseChapter(root, chapter, body.findings, config, new AbortController().signal)
    sendJson(response, 200, result)
    return
  }
  if (chapter && request.method === 'POST' && parts[3] === 'merge') {
    const body = await readJsonBody<{
      revisionId?: string
      choices?: Record<string, 'base' | 'revision' | 'manual'>
    }>(request)
    if (!body.revisionId) throw usageError('缺少 revisionId')
    const report = await mergeRevision(root, chapter, body.revisionId, body.choices ?? {})
    sendJson(response, 200, report)
    return
  }
  if (chapter && request.method === 'POST' && parts[3] === 'ignore') {
    const body = await readJsonBody<{ findingId?: string; reason?: string }>(request)
    if (!body.findingId || !body.reason) throw usageError('缺少 findingId 或 reason')
    sendJson(response, 200, await ignoreFinding(root, chapter, body.findingId, body.reason))
    return
  }
  if (chapter && request.method === 'GET' && parts[3] === 'findings') {
    const review = await loadStage<ReviewReport>(root, 'review', chapter)
    sendJson(response, 200, { review })
    return
  }
  if (chapter && request.method === 'GET' && parts[3] === 'revisions') {
    sendJson(response, 200, { revisions: await listRevisions(root, chapter) })
    return
  }
  if (url.pathname === '/api/waivers') {
    if (request.method === 'GET') {
      sendJson(response, 200, { waivers: await loadWaivers(root) })
      return
    }
    if (request.method === 'POST') {
      const body = await readJsonBody<{
        chapter?: number
        findingIds?: string[]
        reason?: string
        scope?: 'chapter' | 'entity' | 'storyline' | 'project'
        scopeRef?: string
        untilChapter?: number
      }>(request)
      if (!body.chapter || !body.reason) throw usageError('缺少 chapter 或 reason')
      sendJson(response, 200, await createWaivers(
        root,
        body.chapter,
        body.findingIds ?? [],
        {
          reason: body.reason,
          scope: body.scope,
          scopeRef: body.scopeRef,
          untilChapter: body.untilChapter,
        },
      ))
      return
    }
  }
  if (request.method === 'DELETE' && parts[1] === 'waivers' && parts[2]) {
    sendJson(response, 200, await revokeWaiver(root, parts[2]))
    return
  }
  if (request.method === 'GET' && parts[1] === 'chunks' && parts[2]) {
    const chunk = await readSearchChunk(root, parts[2])
    if (!chunk) throw new WeaveError('NOT_FOUND', '未找到检索块', 2)
    sendJson(response, 200, chunk)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/search') {
    sendJson(response, 200, await searchBook(root, url.searchParams.get('q') ?? '', {
      chapter: numberParam(url.searchParams.get('chapter')),
      entity: url.searchParams.get('entity') ?? undefined,
      location: url.searchParams.get('location') ?? undefined,
      storyline: url.searchParams.get('storyline') ?? undefined,
      time: url.searchParams.get('time') ?? undefined,
      rerank: url.searchParams.get('rerank') === '1',
    }))
    return
  }
  if (request.method === 'GET' && chapter && parts[3] === 'methods') {
    sendJson(response, 200, await selectMethods(root, chapter, {
      purpose: 'route',
      platform: (url.searchParams.get('platform') as 'long-form' | 'short-form' | 'generic' | 'qidian' | 'fanqie') ?? 'long-form',
    }))
    return
  }
  if (request.method === 'GET' && chapter && parts[3] === 'style') {
    sendJson(response, 200, await styleCheck(root, chapter))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/deconstruct') {
    const body = await readJsonBody<{ path?: string; splitPattern?: string }>(request)
    if (!body.path) throw usageError('缺少 path')
    const target = path.resolve(root, body.path)
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw validationError('拆书文件必须位于项目目录内')
    }
    sendJson(response, 200, await deconstructFile(target, { splitPattern: body.splitPattern }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/export') {
    const body = await readJsonBody<{
      format?: 'merged' | 'split' | 'txt'
      platform?: 'generic' | 'qidian' | 'fanqie' | 'custom'
      countMode?: 'cjk' | 'all'
    }>(request)
    if (body.format !== 'merged' && body.format !== 'split' && body.format !== 'txt') {
      throw usageError('format 必须是 merged、split 或 txt')
    }
    sendJson(response, 200, await exportBook(
      root,
      body.format,
      body.platform ?? 'generic',
      body.countMode ?? 'all',
    ))
    return
  }
  if (request.method === 'GET' && chapter && url.pathname === `/api/chapters/${chapter}`) {
    sendJson(response, 200, await chapterDetail(root, chapter))
    return
  }
  if (request.method === 'GET' && chapter && parts[3] === 'contract') {
    sendJson(response, 200, await loadContract(root, chapter))
    return
  }
  if (request.method === 'PUT' && chapter && parts[3] === 'contract') {
    const body = await readJsonBody<ChapterContract>(request)
    const contract = normalizeContract({ ...body, chapter })
    await saveContract(root, contract)
    sendJson(response, 200, contract)
    return
  }
  throw new WeaveError('NOT_FOUND', '未知 API', 2)
}

async function chapterList(root: string): Promise<{
  chapters: Array<{
    chapter: number
    title: string
    finalized: boolean
    draft: boolean
    blocking: number
    revision: number
    status: string
  }>
  mainlineRevision: number
}> {
  const status = await projectStatus(root)
  const contractFiles = await listFiles(path.join(projectPaths(root).outlines, 'chapters'))
  const numbers = new Set<number>([
    ...status.chapters.map(item => item.chapter),
    ...status.drafts,
    ...contractFiles.filter(name => name.endsWith('.json')).map(name => Number(name.slice(0, 3))),
  ])
  const chapters = []
  for (const number of [...numbers].filter(item => item > 0).sort((a, b) => a - b)) {
    const contract = await loadContract(root, number).catch(() => null)
    const finalized = status.chapters.find(item => item.chapter === number)
    const review = await loadStage<ReviewReport>(root, 'review', number)
    const blocking = review?.findings.filter(finding => finding.severity === 'blocking' && finding.status !== 'waived').length ?? 0
    chapters.push({
      chapter: number,
      title: contract?.title ?? '',
      finalized: Boolean(finalized),
      draft: status.drafts.includes(number),
      blocking,
      revision: finalized?.revision ?? 0,
      status: finalized ? 'finalized' : blocking > 0 ? 'blocking' : review?.passed ? 'reviewed' : status.drafts.includes(number) ? 'draft' : 'planned',
    })
  }
  return { chapters, mainlineRevision: status.mainlineRevision }
}

async function chapterDetail(root: string, chapter: number): Promise<Record<string, unknown>> {
  const content = await readDraft(root, chapter).catch(() => '')
  const [contract, contentCheck, extraction, audit, review, revisions] = await Promise.all([
    loadContract(root, chapter).catch(() => null),
    loadStage<ContentCheckReport>(root, 'content-check', chapter),
    loadStage<ExtractionReport>(root, 'extraction', chapter),
    loadStage<CoverageAudit>(root, 'audit', chapter),
    loadStage<ReviewReport>(root, 'review', chapter),
    listRevisions(root, chapter),
  ])
  return {
    chapter,
    contract,
    draft: content,
    hash: draftHash(content),
    stages: { contentCheck, extraction, audit, review },
    revisions,
  }
}

async function listRevisions(root: string, chapter: number): Promise<RevisionCandidate[]> {
  const dir = path.join(projectPaths(root).revisions, String(chapter).padStart(3, '0'))
  const revisions: RevisionCandidate[] = []
  for (const name of await listFiles(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.merge.json')) continue
    const candidate = await readJsonIfExists<RevisionCandidate>(path.join(dir, name))
    if (candidate) revisions.push(candidate)
  }
  return revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function runStage(root: string, chapter: number, action: string): Promise<Record<string, unknown>> {
  const contract = await loadContract(root, chapter)
  const draft = await readDraft(root, chapter)
  const hash = draftHash(draft)
  if (action === 'check') {
    await requirePassingContractCheck(root, contract)
    const report = await runContentCheck(root, chapter, contract, draft)
    await saveStage(root, 'content-check', chapter, report)
    return { report, exitCode: report.passed ? 0 : 3 }
  }
  if (action === 'extract') {
    const contentCheck = await loadStage<ContentCheckReport>(root, 'content-check', chapter)
    if (!contentCheck || contentCheck.draftHash !== hash) throw conflictError('请先运行内容检查')
    const config = await loadModelConfig(root)
    const report = await runExtraction(root, chapter, contract, draft, config, new AbortController().signal)
    return { report, exitCode: report.passed ? 0 : 3 }
  }
  if (action === 'audit') {
    const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter)
    if (!extraction || extraction.draftHash !== hash) throw conflictError('请先运行抽取')
    const config = await loadModelConfig(root)
    const report = await runCoverageAudit(root, chapter, contract, draft, extraction, config, new AbortController().signal)
    return { report, exitCode: report.passed ? 0 : 3 }
  }
  if (action === 'review') {
    const contentCheck = await loadStage<ContentCheckReport>(root, 'content-check', chapter)
    const extraction = await loadStage<ExtractionReport>(root, 'extraction', chapter)
    const audit = await loadStage<CoverageAudit>(root, 'audit', chapter)
    if (!contentCheck || contentCheck.draftHash !== hash
      || !extraction || extraction.draftHash !== hash
      || !audit || audit.draftHash !== hash) {
      throw conflictError('阶段报告已失效；请重新运行 check/extract/audit')
    }
    const config = await loadModelConfig(root)
    const report = await applyWaivers(
      root,
      chapter,
      await runReview(root, chapter, contract, draft, extraction, audit, config, new AbortController().signal),
    )
    await saveStage(root, 'review', chapter, report)
    return { report, exitCode: report.passed ? 0 : 7 }
  }
  if (action === 'recheck') {
    const config = await loadModelConfig(root)
    const report = await recheckChapter(root, chapter, config, new AbortController().signal)
    return { report, exitCode: report.passed ? 0 : 7 }
  }
  if (action === 'finalize') {
    return { result: await finalizeChapter(root, chapter) }
  }
  if (action === 'amend') {
    return { meta: await amendChapter(root, chapter, false) }
  }
  throw usageError(`未知阶段：${action}`)
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const uiDir = path.resolve(import.meta.dirname, '..', 'ui')
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(uiDir, relative)
  if (!target.startsWith(`${uiDir}${path.sep}`) && target !== path.join(uiDir, 'index.html')) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }
  try {
    const data = await readFile(target)
    response.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
    response.end(data)
  } catch {
    response.writeHead(404)
    response.end('Not found')
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 10 * 1024 * 1024) throw validationError('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw validationError('请求体不是合法 JSON')
  }
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(`${JSON.stringify(payload)}\n`)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const weave = error instanceof WeaveError ? error : null
  const status = weave
    ? weave.code === 'NOT_FOUND'
      ? 404
      : weave.exitCode === 2
        ? 400
        : weave.exitCode === 4
          ? 409
          : weave.exitCode === 5
            ? 502
            : 422
    : 500
  sendJson(response, status, {
    error: {
      code: weave?.code ?? 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      details: weave?.details,
      exitCode: weave?.exitCode ?? 6,
    },
  })
}
