import type { ModelConfig, RunUsage, StreamAttempt } from './types.ts'
import { modelError, validationError, type WeaveError } from './errors.ts'
import { parseJsonObject } from './stages.ts'

export type { StreamAttempt } from './types.ts'

export interface StreamResult {
  usage: RunUsage
  attempts: StreamAttempt[]
}

class AttemptFailure extends Error {
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message)
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

export interface StructuredResult {
  raw: Record<string, unknown>
  text: string
  usage: RunUsage
  repairs: number
}

/**
 * JSON contract with one repair pass. Every provider path (structured output, tool calls, plain
 * text) must still pass the same local parse and business validation.
 */
export async function completeJsonObject(input: {
  config: ModelConfig
  system: string
  user: string
  signal: AbortSignal
}): Promise<StructuredResult> {
  const first = await completeText(input)
  try {
    return { raw: parseJsonObject(first.text), text: first.text, usage: first.usage, repairs: 0 }
  } catch (firstError) {
    const message = firstError instanceof Error ? firstError.message : String(firstError)
    const repair = await completeText({
      ...input,
      user: `${input.user}\n\n上一次输出无法解析为 JSON 对象（${message}）。请只输出一个合法的 JSON 对象，不要解释或 Markdown 围栏。`,
    })
    try {
      return { raw: parseJsonObject(repair.text), text: repair.text, usage: repair.usage, repairs: 1 }
    } catch (secondError) {
      throw validationError(
        `模型没有返回可解析的 JSON：${secondError instanceof Error ? secondError.message : String(secondError)}`,
        { firstError: message },
      )
    }
  }
}

export async function completeText(input: {
  config: ModelConfig
  system: string
  user: string
  signal: AbortSignal
}): Promise<{ text: string; usage: RunUsage }> {
  let text = ''
  const result = await streamChapter({
    ...input,
    onDelta: delta => { text += delta },
  })
  return { text, usage: result.usage }
}

/**
 * A stream can only be retried transparently before the first delta reaches the caller.
 * Once text has been emitted, a retry would duplicate prose, so the failure surfaces and the
 * caller keeps the partial under its own run.
 */
export async function streamChapter(input: {
  config: ModelConfig
  system: string
  user: string
  signal: AbortSignal
  onDelta: (text: string) => void
}): Promise<StreamResult> {
  const maxRetries = Math.max(0, input.config.maxRetries ?? 3)
  const baseMs = Math.max(0, input.config.retryBaseMs ?? 800)
  const attempts: StreamAttempt[] = []
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const startedAt = new Date().toISOString()
    let emitted = false
    try {
      const usage = await streamOnce({
        ...input,
        onDelta: text => {
          emitted = true
          input.onDelta(text)
        },
      })
      attempts.push({ attempt, status: 'ok', startedAt })
      return { usage, attempts }
    } catch (error) {
      if (input.signal.aborted) {
        attempts.push({ attempt, status: 'failed', reason: 'cancelled', startedAt })
        throw fail('生成已取消', attempts)
      }
      const failure = error instanceof AttemptFailure
        ? error
        : new AttemptFailure(errorMessage(error), false)
      const lastAttempt = attempt === maxRetries + 1
      if (emitted || !failure.retryable || lastAttempt) {
        attempts.push({ attempt, status: 'failed', reason: failure.message, startedAt })
        throw fail(failure.message, attempts)
      }
      const waitMs = failure.retryAfterMs ?? backoffMs(baseMs, attempt)
      attempts.push({ attempt, status: 'retry', reason: failure.message, waitMs, startedAt })
      await delay(waitMs, input.signal)
    }
  }
  /* c8 ignore next */
  throw fail('模型请求重试次数已用尽', attempts)
}

async function streamOnce(input: {
  config: ModelConfig
  system: string
  user: string
  signal: AbortSignal
  onDelta: (text: string) => void
}): Promise<RunUsage> {
  const apiKey = process.env.WEAVE_API_KEY?.trim() ?? ''
  const endpoint = `${input.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const timeout = AbortSignal.timeout(input.config.timeoutMs)
  const signal = AbortSignal.any([input.signal, timeout])
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: input.config.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        stream: true,
        temperature: input.config.temperature,
        max_tokens: input.config.maxOutputTokens,
      }),
    })
  } catch (error) {
    if (input.signal.aborted) throw modelError('生成已取消')
    if (timeout.aborted) throw new AttemptFailure(`模型请求超时（${input.config.timeoutMs}ms）`, true)
    throw new AttemptFailure(`无法连接模型服务：${errorMessage(error)}`, true)
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw new AttemptFailure(
      `模型服务返回 ${response.status}${body ? `：${body.slice(0, 500)}` : ''}`,
      isRetryableStatus(response.status),
      retryAfterMs(response.headers.get('retry-after')),
    )
  }

  let buffer = ''
  let usage: RunUsage = {}
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const result = parseEvent(event)
        if (result.done) return usage
        if (result.text) input.onDelta(result.text)
        if (result.usage) usage = result.usage
      }
    }
    if (buffer.trim()) {
      const result = parseEvent(buffer)
      if (result.text) input.onDelta(result.text)
      if (result.usage) usage = result.usage
    }
    return usage
  } catch (error) {
    if (input.signal.aborted) throw modelError('生成已取消')
    if (timeout.aborted) throw new AttemptFailure(`模型请求超时（${input.config.timeoutMs}ms）`, true)
    throw new AttemptFailure(`模型流中断：${errorMessage(error)}`, true)
  } finally {
    reader.releaseLock()
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000))
  return undefined
}

function backoffMs(baseMs: number, attempt: number): number {
  const exponential = baseMs * 2 ** (attempt - 1)
  const jitter = Math.floor(Math.random() * Math.max(1, baseMs / 2))
  return Math.min(exponential + jitter, 30_000)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(modelError('生成已取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parseEvent(raw: string): { text?: string; usage?: RunUsage; done?: boolean } {
  const lines = raw.split(/\r?\n/)
  const payloads = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
  if (payloads.includes('[DONE]')) return { done: true }
  let text = ''
  let usage: RunUsage | undefined
  for (const data of payloads) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    const usageRaw = parsed.usage as Record<string, unknown> | undefined
    if (usageRaw) {
      usage = {
        promptTokens: numberOrUndefined(usageRaw.prompt_tokens),
        completionTokens: numberOrUndefined(usageRaw.completion_tokens),
        totalTokens: numberOrUndefined(usageRaw.total_tokens),
      }
    }
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    const content = delta?.content
    if (typeof content === 'string') text += content
  }
  return { text: text || undefined, usage }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function fail(message: string, attempts: StreamAttempt[]): WeaveError {
  const error = modelError(message) as WeaveError & { attempts?: StreamAttempt[] }
  error.attempts = attempts
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
