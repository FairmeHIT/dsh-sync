import { HarnessError } from '@deepseek-ai/dsh-error'

/** Errors raised by the sync pipeline carry a stable, user-facing code. */
export class SyncError extends HarnessError {
  constructor(code, message, details) {
    super(message, code)
    this.name = 'SyncError'
    if (details !== undefined) this.details = details
  }
}

export function formatError(error) {
  if (error instanceof HarnessError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return `E_SYNC: ${error.message}`
  return `E_SYNC: ${String(error)}`
}

/**
 * Keep DSH's structured HarnessError code for tool-result metadata, while also
 * prefixing the code into the model-visible message. Non-Harness failures are
 * wrapped with E_SYNC.
 */
export function toToolError(error) {
  if (error instanceof SyncError) {
    return new SyncError(error.code, `${error.code}: ${error.message}`, error.details)
  }
  if (error instanceof HarnessError) {
    return new HarnessError(`${error.code}: ${error.message}`, error.code, { cause: error })
  }
  const message = formatError(error)
  return new HarnessError(message, 'E_SYNC', { cause: error })
}
