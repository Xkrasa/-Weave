import type { ModelConfig } from './types.ts'

export type TaskName = 'planning' | 'writing' | 'extraction' | 'trustedReview' | 'effectReview' | 'revision'

export interface TaskModelOverride {
  model?: string
  baseUrl?: string
  temperature?: number
  maxOutputTokens?: number
  contextWindow?: number
  contextBudgetTokens?: number
}

/**
 * Per-task model policy. Explicit task overrides win, then the legacy single-purpose fields,
 * then the project default. Nothing here promises quality: the benchmark decides.
 */
export function resolveTaskConfig(config: ModelConfig, task: TaskName): ModelConfig {
  const override = config.taskModels?.[task] ?? {}
  const legacy = legacyModel(config, task)
  return {
    ...config,
    model: override.model ?? legacy ?? config.model,
    baseUrl: override.baseUrl ?? config.baseUrl,
    temperature: override.temperature ?? config.temperature,
    maxOutputTokens: override.maxOutputTokens ?? config.maxOutputTokens,
    contextWindow: override.contextWindow ?? config.contextWindow,
    contextBudgetTokens: override.contextBudgetTokens ?? config.contextBudgetTokens,
    timeoutMs: override.timeoutMs ?? config.timeoutMs,
    apiKeyEnv: override.apiKeyEnv ?? config.apiKeyEnv,
    provider: override.provider ?? config.provider,
    capabilities: override.capabilities ?? config.capabilities,
  }
}

function legacyModel(config: ModelConfig, task: TaskName): string | undefined {
  switch (task) {
    case 'extraction':
      return config.extractionModel
    case 'trustedReview':
    case 'revision':
      return config.reviewModel
    case 'effectReview':
      return config.effectReviewModel
    default:
      return undefined
  }
}
