import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { hashFileBytes } from './hash.ts'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(temp, data)
  await rename(temp, filePath)
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const text = await readTextIfExists(filePath)
  if (text === null) return null
  return JSON.parse(text) as T
}

export async function readJson<T>(filePath: string): Promise<T> {
  const text = await readFile(filePath, 'utf8')
  return JSON.parse(text) as T
}

export async function readBytes(filePath: string): Promise<Uint8Array> {
  return readFile(filePath)
}

export async function fileHash(filePath: string): Promise<string> {
  return hashFileBytes(await readBytes(filePath))
}

export async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isFile()).map(entry => entry.name).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
