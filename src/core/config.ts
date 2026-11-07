import type { ModelConfig } from './types.ts'
import { atomicWriteJson } from './io.ts'
import { validationError } from './errors.ts'
import { loadModelConfig, projectPaths, DEFAULT_CONTEXT_BUDGET_TOKENS } from './project.ts'

export interface ModelConfigPatch {
  contextWindow?: number
  contextBudgetTokens?: number
  maxOutputTokens?: number
  safetyMarginTokens?: number
  charsPerToken?: number
}

export interface ModelBudgetSummary {
  model: string
  contextWindow: number
  contextBudgetTokens: number
  effectiveWindow: number
  maxOutputTokens: number
  safetyMarginTokens: number
  /** Input tokens available to materials, before prompt-fixed costs. */
  capacityTokens: number
}

export function effectiveContextWindow(
  config: Pick<ModelConfig, 'contextWindow' | 'contextBudgetTokens'>,
): number {
  return Math.min(config.contextWindow, config.contextBudgetTokens ?? config.contextWindow)
}

export function contextCapacityTokens(
  config: Pick<ModelConfig, 'contextWindow' | 'contextBudgetTokens' | 'maxOutputTokens' | 'safetyMarginTokens'>,
  fixedTokens = 0,
): number {
  return effectiveContextWindow(config) - config.maxOutputTokens - config.safetyMarginTokens - fixedTokens
}

export function validateModelConfig(config: ModelConfig): string[] {
  const errors: string[] = []
  const positiveInt = (name: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${name} 必须是正整数`)
  }
  positiveInt('contextWindow', config.contextWindow)
  if (config.contextBudgetTokens !== undefined) positiveInt('contextBudgetTokens', config.contextBudgetTokens)
  positiveInt('maxOutputTokens', config.maxOutputTokens)
  positiveInt('safetyMarginTokens', config.safetyMarginTokens)
  if (!Number.isFinite(config.charsPerToken) || config.charsPerToken <= 0) {
    errors.push('charsPerToken 必须是大于 0 的数字')
  }
  if (errors.length > 0) return errors

  const effectiveWindow = effectiveContextWindow(config)
  if (config.maxOutputTokens + config.safetyMarginTokens >= effectiveWindow) {
    errors.push(
      `输出预留 ${config.maxOutputTokens} + 安全余量 ${config.safetyMarginTokens} 已占满可用窗口 ${effectiveWindow}；请降低输出预留或提高 contextWindow/contextBudgetTokens`,
    )
  }
  return errors
}

export function modelBudgetSummary(config: ModelConfig): ModelBudgetSummary {
  const errors = validateModelConfig(config)
  if (errors.length > 0) throw validationError('模型配置非法', errors)
  return {
    model: config.model,
    contextWindow: config.contextWindow,
    contextBudgetTokens: config.contextBudgetTokens ?? config.contextWindow,
    effectiveWindow: effectiveContextWindow(config),
    maxOutputTokens: config.maxOutputTokens,
    safetyMarginTokens: config.safetyMarginTokens,
    capacityTokens: contextCapacityTokens(config),
  }
}

export async function updateModelConfig(root: string, patch: ModelConfigPatch): Promise<ModelConfig> {
  const current = await loadModelConfig(root)
  const next: ModelConfig = { ...current }
  for (const key of ['contextWindow', 'contextBudgetTokens', 'maxOutputTokens', 'safetyMarginTokens', 'charsPerToken'] as const) {
    const value = patch[key]
    if (value !== undefined) next[key] = value
  }
  const errors = validateModelConfig(next)
  if (errors.length > 0) throw validationError(`模型配置非法：${errors.join('；')}`, errors)
  await atomicWriteJson(projectPaths(root).modelConfig, next)
  return next
}

/**
 * Explicit, lossless upgrade for projects created before soft budgets existed.
 * It only fills the missing field; window and output settings are never guessed.
 */
export async function migrateModelConfig(root: string): Promise<{ config: ModelConfig; changed: string[] }> {
  const current = await loadModelConfig(root)
  const changed: string[] = []
  if (current.contextBudgetTokens === undefined) {
    current.contextBudgetTokens = Math.min(current.contextWindow, DEFAULT_CONTEXT_BUDGET_TOKENS)
    changed.push('contextBudgetTokens')
  }
  if (changed.length > 0) {
    const errors = validateModelConfig(current)
    if (errors.length > 0) throw validationError(`模型配置非法：${errors.join('；')}`, errors)
    await atomicWriteJson(projectPaths(root).modelConfig, current)
  }
  return { config: current, changed }
}
