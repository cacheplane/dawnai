import type {
  RuntimeExecutionErrorKind,
  RuntimeExecutionFailureResult,
  RuntimeExecutionMode,
  RuntimeExecutionSuccessResult,
  RuntimeExecutionTiming,
} from "@dawn-ai/sdk/testing"

export type {
  RuntimeExecutionBaseResult,
  RuntimeExecutionError,
  RuntimeExecutionErrorKind,
  RuntimeExecutionFailureResult,
  RuntimeExecutionMode,
  RuntimeExecutionResult,
  RuntimeExecutionSuccessResult,
  RuntimeExecutionTiming,
} from "@dawn-ai/sdk/testing"

export function createRuntimeSuccessResult(options: {
  readonly appRoot: string
  readonly diagnostics?: Record<string, unknown>
  readonly executionSource: "in-process" | "server"
  readonly finishedAt?: number
  readonly mode: RuntimeExecutionMode
  readonly output: unknown
  readonly routeId: string
  readonly routePath: string
  readonly startedAt: number
}): RuntimeExecutionSuccessResult {
  const timing = createRuntimeTiming(options.startedAt, options.finishedAt)

  return {
    appRoot: options.appRoot,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...timing,
    executionSource: options.executionSource,
    mode: options.mode,
    output: options.output,
    routeId: options.routeId,
    routePath: options.routePath,
    status: "passed",
  }
}

export function createRuntimeFailureResult(options: {
  readonly appRoot: string | null
  readonly details?: Record<string, unknown>
  readonly diagnostics?: Record<string, unknown>
  readonly executionSource: "in-process" | "server"
  readonly finishedAt?: number
  readonly kind: RuntimeExecutionErrorKind
  readonly message: string
  readonly mode?: RuntimeExecutionMode | null
  readonly routeId?: string | null
  readonly routePath?: string | null
  readonly startedAt: number
}): RuntimeExecutionFailureResult {
  const timing = createRuntimeTiming(options.startedAt, options.finishedAt)

  return {
    appRoot: options.appRoot,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...timing,
    error: {
      ...(options.details ? { details: options.details } : {}),
      kind: options.kind,
      message: options.message,
    },
    executionSource: options.executionSource,
    mode: options.mode ?? null,
    routeId: options.routeId ?? null,
    routePath: options.routePath ?? null,
    status: "failed",
  }
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createRuntimeTiming(startedAt: number, finishedAt = Date.now()): RuntimeExecutionTiming {
  return {
    durationMs: Math.max(0, finishedAt - startedAt),
    finishedAt: new Date(finishedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
  }
}
