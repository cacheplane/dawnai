import { DAWN_ERRORS, type DawnErrorCode, errorDocsUrl } from "@dawn-ai/sdk"

export type RuntimeServerErrorKind = "request_error" | "execution_error"

export interface RuntimeServerErrorBody {
  readonly error: {
    readonly kind: RuntimeServerErrorKind
    readonly message: string
    readonly details?: Record<string, unknown>
    readonly code?: DawnErrorCode
    readonly docsUrl?: string
  }
}

interface ErrorBodyOptions {
  readonly code?: DawnErrorCode
}

function buildBody(
  kind: RuntimeServerErrorKind,
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  const code = options?.code
  const docsUrl = code ? errorDocsUrl(code) : undefined
  return {
    error: {
      ...(details ? { details } : {}),
      ...(code ? { code } : {}),
      ...(docsUrl ? { docsUrl } : {}),
      kind,
      message,
    },
  }
}

export function createRequestErrorBody(
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  return buildBody("request_error", message, details, options)
}

export function createExecutionErrorBody(
  message: string,
  details?: Record<string, unknown>,
  options?: ErrorBodyOptions,
): RuntimeServerErrorBody {
  return buildBody("execution_error", message, details, options)
}

/** Read a Dawn error code off a caught error, if it carries a real registry code. */
export function dawnErrorCodeOf(error: unknown): DawnErrorCode | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && code in DAWN_ERRORS) {
      return code as DawnErrorCode
    }
  }
  return undefined
}
