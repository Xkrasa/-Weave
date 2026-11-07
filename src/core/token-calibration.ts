import path from 'node:path'
import { atomicWriteJson, ensureDir, readJsonIfExists } from './io.ts'
import { projectPaths } from './project.ts'
import type { ModelConfig } from './types.ts'

/**
 * Observed prose-to-token ratio, kept as an EWMA so a single odd run cannot
 * permanently unbalance the estimate. Only provider-reported usage feeds it.
 */
export interface TokenCalibration {
  schemaVersion: 1
  observedCharsPerToken: number
  samples: number
  updatedAt: string
  last: {
    promptChars: number
    estimatedTokens: number
    promptTokens: number
  }
}

export const EWMA_ALPHA = 0.3
export const DEVIATION_WARN_THRESHOLD = 0.2
/** Guards against provider reports that would make the estimate absurd. */
const MIN_OBSERVED = 0.25
const MAX_OBSERVED = 8

export function calibrationPath(root: string): string {
  return path.join(projectPaths(root).metadata, 'token-calibration.json')
}

export async function loadTokenCalibration(root: string): Promise<TokenCalibration | null> {
  const stored = await readJsonIfExists<TokenCalibration>(calibrationPath(root))
  if (!stored || stored.schemaVersion !== 1) return null
  if (!Number.isFinite(stored.observedCharsPerToken) || stored.observedCharsPerToken <= 0) return null
  return stored
}

/** Conservative estimate: never assume a better ratio than the configured one. */
export function effectiveCharsPerToken(
  config: Pick<ModelConfig, 'charsPerToken'>,
  calibration: TokenCalibration | null,
): number {
  return calibration ? Math.min(config.charsPerToken, calibration.observedCharsPerToken) : config.charsPerToken
}

export async function recordTokenObservation(
  root: string,
  promptChars: number,
  promptTokens: number | undefined,
  charsPerToken: number,
): Promise<TokenCalibration | null> {
  if (!Number.isFinite(promptChars) || promptChars <= 0) return null
  if (promptTokens === undefined || !Number.isFinite(promptTokens) || promptTokens <= 0) return null
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) return null

  const observed = clamp(promptChars / promptTokens, MIN_OBSERVED, MAX_OBSERVED)
  const previous = await loadTokenCalibration(root)
  const value = previous
    ? previous.observedCharsPerToken * (1 - EWMA_ALPHA) + observed * EWMA_ALPHA
    : observed
  const next: TokenCalibration = {
    schemaVersion: 1,
    observedCharsPerToken: round(value, 3),
    samples: (previous?.samples ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    last: {
      promptChars,
      estimatedTokens: Math.ceil(promptChars / charsPerToken),
      promptTokens,
    },
  }
  await ensureDir(path.dirname(calibrationPath(root)))
  await atomicWriteJson(calibrationPath(root), next)
  return next
}

export interface CalibrationDeviation {
  observedCharsPerToken: number
  configuredCharsPerToken: number
  samples: number
  /** (estimated - actual) / actual; negative means the estimate under-counts tokens. */
  deviation: number
  last: TokenCalibration['last']
}

export function calibrationDeviation(
  config: Pick<ModelConfig, 'charsPerToken'>,
  calibration: TokenCalibration | null,
): CalibrationDeviation | null {
  if (!calibration) return null
  const { last } = calibration
  if (!Number.isFinite(last.promptTokens) || last.promptTokens <= 0) return null
  return {
    observedCharsPerToken: calibration.observedCharsPerToken,
    configuredCharsPerToken: config.charsPerToken,
    samples: calibration.samples,
    deviation: round((last.estimatedTokens - last.promptTokens) / last.promptTokens, 4),
    last,
  }
}

/** Author-facing hint; only fires past the 20% threshold from the task spec. */
export function calibrationWarning(report: CalibrationDeviation): string | null {
  if (Math.abs(report.deviation) <= DEVIATION_WARN_THRESHOLD) return null
  const percent = Math.round(report.deviation * 100)
  const direction = percent > 0 ? '多估' : '少估'
  return `token 估算${direction} ${Math.abs(percent)}%（估算 ${report.last.estimatedTokens} / 实际 ${report.last.promptTokens}）；观测约 ${report.observedCharsPerToken} 字/token，建议执行 weave config set --chars-per-token ${report.observedCharsPerToken}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
