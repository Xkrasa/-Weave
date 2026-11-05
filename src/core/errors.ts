export type WeaveExitCode = 2 | 3 | 4 | 5 | 6

export class WeaveError extends Error {
  readonly code: string
  readonly exitCode: WeaveExitCode
  readonly details?: unknown

  constructor(code: string, message: string, exitCode: WeaveExitCode, details?: unknown) {
    super(message)
    this.name = 'WeaveError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

export function usageError(message: string): WeaveError {
  return new WeaveError('USAGE', message, 2)
}

export function validationError(message: string, details?: unknown): WeaveError {
  return new WeaveError('VALIDATION', message, 3, details)
}

export function conflictError(message: string, details?: unknown): WeaveError {
  return new WeaveError('CONFLICT', message, 4, details)
}

export function modelError(message: string, details?: unknown): WeaveError {
  return new WeaveError('MODEL', message, 5, details)
}
