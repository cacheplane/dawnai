import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"

export interface NormalizeServerResultOptions {
  readonly appRoot: string
  readonly finishedAt?: number
  readonly mode?: RuntimeExecutionMode
  readonly responseBodyText: string
  readonly routeId: string
  readonly routePath: string
  readonly startedAt: number
  readonly statusCode: number
}

export function normalizeServerResult(
  options: NormalizeServerResultOptions,
): RuntimeExecutionResult {
  const parsedBody = parseJson(options.responseBodyText)

  if (options.statusCode === 200) {
    if (!parsedBody.ok) {
      return createRuntimeFailureResult({
        appRoot: options.appRoot,
        executionSource: "server",
        ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
        kind: "server_transport_error",
        message: "Server returned a malformed JSON payload for /runs/wait",
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        routeId: options.routeId,
        routePath: options.routePath,
        startedAt: options.startedAt,
      })
    }

    const resolvedMode = options.mode ?? extractModeFromBody(parsedBody.value)

    if (!resolvedMode) {
      return createRuntimeFailureResult({
        appRoot: options.appRoot,
        executionSource: "server",
        ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
        kind: "server_transport_error",
        message: "Server returned a result with an unknown route kind",
        routeId: options.routeId,
        routePath: options.routePath,
        startedAt: options.startedAt,
      })
    }

    return createRuntimeSuccessResult({
      appRoot: options.appRoot,
      executionSource: "server",
      ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
      mode: resolvedMode,
      output: parsedBody.value,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }

  if (parsedBody.ok) {
    const executionError = tryExtractExecutionError(parsedBody.value)

    if (executionError) {
      return createRuntimeFailureResult({
        appRoot: options.appRoot,
        executionSource: "server",
        ...(executionError.details ? { details: executionError.details } : {}),
        ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
        kind: "execution_error",
        message: executionError.message,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        routeId: options.routeId,
        routePath: options.routePath,
        startedAt: options.startedAt,
      })
    }
  }

  return createRuntimeFailureResult({
    appRoot: options.appRoot,
    executionSource: "server",
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    kind: "server_transport_error",
    message: `Server transport failed for /runs/wait with HTTP ${options.statusCode}`,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    routeId: options.routeId,
    routePath: options.routePath,
    startedAt: options.startedAt,
  })
}

function extractModeFromBody(value: unknown): RuntimeExecutionMode | null {
  if (!isRecord(value)) {
    return null
  }

  const mode = value.mode

  if (mode === "graph" || mode === "workflow") {
    return mode
  }

  return null
}

function parseJson(
  input: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return {
      ok: true,
      value: JSON.parse(input),
    }
  } catch {
    return {
      ok: false,
    }
  }
}

function tryExtractExecutionError(
  value: unknown,
): { readonly details?: Record<string, unknown>; readonly message: string } | null {
  if (!isRecord(value)) {
    return null
  }

  if (value.status === "failed" && isRecord(value.error)) {
    const error = value.error

    if (error.kind === "execution_error" && typeof error.message === "string") {
      return {
        ...(isRecord(error.details) ? { details: error.details } : {}),
        message: error.message,
      }
    }
  }

  if (isRecord(value.error)) {
    const error = value.error

    if (error.kind === "execution_error" && typeof error.message === "string") {
      return {
        ...(isRecord(error.details) ? { details: error.details } : {}),
        message: error.message,
      }
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
