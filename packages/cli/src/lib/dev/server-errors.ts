export type RuntimeServerErrorKind = "request_error" | "execution_error"

export interface RuntimeServerErrorBody {
  readonly error: {
    readonly kind: RuntimeServerErrorKind
    readonly message: string
    readonly details?: Record<string, unknown>
  }
}

export function createRequestErrorBody(
  message: string,
  details?: Record<string, unknown>,
): RuntimeServerErrorBody {
  return {
    error: {
      ...(details ? { details } : {}),
      kind: "request_error",
      message,
    },
  }
}

export function createExecutionErrorBody(
  message: string,
  details?: Record<string, unknown>,
): RuntimeServerErrorBody {
  return {
    error: {
      ...(details ? { details } : {}),
      kind: "execution_error",
      message,
    },
  }
}
