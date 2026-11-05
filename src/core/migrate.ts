import path from 'node:path'
import { copyFile, readdir } from 'node:fs/promises'
import type { ModelConfig } from './types.ts'
import { atomicWriteJson, ensureDir, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import { conflictError } from './errors.ts'

export const CURRENT_SCHEMA_VERSION = 4

export interface MigrationResult {
  migrated: boolean
  from: number
  to: number
  backupDir: string | null
}

export async function ensureProjectMigrated(root: string): Promise<MigrationResult> {
  const paths = projectPaths(root)
  const raw = await readJsonIfExists<Record<string, unknown>>(paths.project)
  if (!raw) throw conflictError('项目配置缺失')
  const version = Number(raw.schemaVersion)
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw conflictError(`无效的项目版本：${String(raw.schemaVersion)}`)
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw conflictError(`项目版本 ${version} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}；请升级 Weave`)
  }
  if (version === CURRENT_SCHEMA_VERSION) {
    return { migrated: false, from: version, to: version, backupDir: null }
  }

  const backupDir = await backupBeforeMigration(root, version)
  const project = raw as Record<string, unknown>
  if (version < 2) {
    const config = await readJsonIfExists<Partial<ModelConfig>>(paths.modelConfig)
    if (!config) throw conflictError('迁移失败：模型配置缺失')
    if (!Number.isSafeInteger(config.snapshotEvery) || Number(config.snapshotEvery) <= 0) {
      config.snapshotEvery = 10
    }
    await atomicWriteJson(paths.modelConfig, config)
    project.schemaVersion = 2
    await atomicWriteJson(paths.project, project)
  }
  if (version < 3) {
    project.workflowVersion = 1
    project.schemaVersion = 3
    await atomicWriteJson(paths.project, project)
  }
  if (version < 4) {
    project.ledgerVersion = 1
    project.schemaVersion = 4
    await atomicWriteJson(paths.project, project)
  }

  return { migrated: true, from: version, to: CURRENT_SCHEMA_VERSION, backupDir }
}

async function backupBeforeMigration(root: string, fromVersion: number): Promise<string> {
  const paths = projectPaths(root)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(paths.metadata, 'backups', `pre-migration-v${fromVersion}-${stamp}`)
  await ensureDir(dir)
  await copyFile(paths.project, path.join(dir, 'project.json'))
  try {
    await copyFile(paths.modelConfig, path.join(dir, 'config.json'))
  } catch {
    // The migration reports the missing config separately; keep the backup that succeeded.
  }
  return dir
}

export async function listMigrationBackups(root: string): Promise<string[]> {
  const dir = path.join(projectPaths(root).metadata, 'backups')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
}
