import { createHash } from 'node:crypto'

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hashText(text: string): string {
  return `sha256:${sha256Hex(Buffer.from(text, 'utf8'))}`
}

export function hashFileBytes(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`
}

export function commitFileName(commitId: string): string {
  return `commit-${commitId.replace(/^sha256:/, '')}.json`
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key])
    return sorted
  }
  return value
}

export function objectHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}
