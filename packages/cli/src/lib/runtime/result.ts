export type RuntimeExecutionMode = "graph" | "workflow"

export type RuntimeExecutionErrorKind =
  | "app_discovery_error"
  | "execution_error"
  | "route_resolution_error"
  | "unsupported_route_boundary"

export interface RuntimeExecutionError {
  readonly kind: RuntimeExecutionErrorKind
  readonly message: string
}

export interface RuntimeExecutionSuccessResult {
  readonly appRoot: string
  readonly mode: RuntimeExecutionMode
  readonly output: unknown
  readonly routeFile: string
  readonly status: "passed"
}

export interface RuntimeExecutionFailureResult {
  readonly appRoot: string | null
  readonly error: RuntimeExecutionError
  readonly mode: RuntimeExecutionMode | null
  readonly routeFile: string | null
  readonly status: "failed"
}

export type RuntimeExecutionResult = RuntimeExecutionSuccessResult | RuntimeExecutionFailureResult

export function createRuntimeSuccessResult(options: {
  readonly appRoot: string
  readonly mode: RuntimeExecutionMode
  readonly output: unknown
  readonly routeFile: string
}): RuntimeExecutionSuccessResult {
  return {
    appRoot: options.appRoot,
    mode: options.mode,
    output: options.output,
    routeFile: options.routeFile,
    status: "passed",
  }
}

export function createRuntimeFailureResult(options: {
  readonly appRoot: string | null
  readonly kind: RuntimeExecutionErrorKind
  readonly message: string
  readonly mode?: RuntimeExecutionMode | null
  readonly routeFile?: string | null
}): RuntimeExecutionFailureResult {
  return {
    appRoot: options.appRoot,
    error: {
      kind: options.kind,
      message: options.message,
    },
    mode: options.mode ?? null,
    routeFile: options.routeFile ?? null,
    status: "failed",
  }
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
