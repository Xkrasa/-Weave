import type { ModelConfig, RunUsage } from './types.ts'
import { modelError } from './errors.ts'

export interface StreamResult {
  usage: RunUsage
}

export async function streamChapter(input: {
  config: ModelConfig
  system: string
  user: string
  signal: AbortSignal
  onDelta: (text: string) => void
}): Promise<StreamResult> {
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
    if (timeout.aborted) throw modelError(`模型请求超时（${input.config.timeoutMs}ms）`)
    throw modelError(`无法连接模型服务：${errorMessage(error)}`)
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw modelError(`模型服务返回 ${response.status}`, body.slice(0, 2000))
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
        if (result.done) return { usage }
        if (result.text) input.onDelta(result.text)
        if (result.usage) usage = result.usage
      }
    }
    if (buffer.trim()) parseEvent(buffer)
    return { usage }
  } catch (error) {
    if (input.signal.aborted) throw modelError('生成已取消')
    if (timeout.aborted) throw modelError(`模型请求超时（${input.config.timeoutMs}ms）`)
    throw modelError(`模型流中断：${errorMessage(error)}`)
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(raw: string): { text?: string; usage?: RunUsage; done?: boolean } {
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') return { done: true }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    const usageRaw = parsed.usage as Record<string, unknown> | undefined
    const usage = usageRaw
      ? {
          promptTokens: numberOrUndefined(usageRaw.prompt_tokens),
          completionTokens: numberOrUndefined(usageRaw.completion_tokens),
          totalTokens: numberOrUndefined(usageRaw.total_tokens),
        }
      : undefined
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    const content = delta?.content
    return {
      text: typeof content === 'string' ? content : undefined,
      usage,
    }
  }
  return {}
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
