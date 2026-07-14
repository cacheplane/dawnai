import type { DawnErrorCode } from "@dawn-ai/sdk"

/** An `Error` tagged with a stable Dawn registry code so surfaces can link docs. */
export interface DawnCodedError extends Error {
  readonly code: DawnErrorCode
}

/**
 * Construct a "sandbox unavailable" error carrying the `DAWN_E2001` code. The
 * code rides on the error object so an HTTP/SSE error body (or any caught-error
 * surface) can attach the docs link without re-deriving it from the message.
 */
export function sandboxUnavailable(message: string): DawnCodedError {
  const error = new Error(message) as Error & { code: DawnErrorCode }
  error.code = "DAWN_E2001"
  return error
}
