import path from 'node:path'
import { readTextIfExists } from './io.ts'

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Minimal `.env` loader for local-first use.
 *
 * Rules that matter for safety:
 * - only fills variables that are not already set, so an explicit shell export always wins;
 * - never reads, prints or writes the value anywhere except `process.env`;
 * - ignores malformed lines instead of guessing.
 */
export async function loadDotEnv(dir: string = process.cwd()): Promise<string[]> {
  return loadDotEnvFile(path.join(dir, '.env'))
}

/** Same rules as {@link loadDotEnv}, but pointing at an explicit file. */
export async function loadDotEnvFile(filePath: string): Promise<string[]> {
  const text = await readTextIfExists(filePath)
  if (!text) return []
  const applied: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!KEY_PATTERN.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const quoted = (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      if (quoted) value = value.slice(1, -1)
    }
    if (process.env[key] !== undefined) continue
    process.env[key] = value
    applied.push(key)
  }
  return applied
}
