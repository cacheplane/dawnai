/**
 * Result envelope produced by `dawn run` and `dawn test` for a single route invocation.
 * Test scenario authors assert against this shape via `expectOutput`, `expectMeta`, and
 * `expectError` from `@dawn-ai/sdk/testing`.
 */

export type RuntimeExecutionMode = "agent" | "chain" | "graph" | "workflow"

export type RuntimeExecutionErrorKind =
  | "app_discovery_error"
  | "execution_error"
  | "route_resolution_error"
  | "server_transport_error"
  | "unsupported_route_boundary"

export interface RuntimeExecutionError {
  readonly details?: Record<string, unknown>
  readonly kind: RuntimeExecutionErrorKind
  readonly message: string
}

export interface RuntimeExecutionTiming {
  readonly durationMs: number
  readonly finishedAt: string
  readonly startedAt: string
}

export interface RuntimeExecutionBaseResult extends RuntimeExecutionTiming {
  readonly appRoot: string | null
  readonly diagnostics?: Record<string, unknown>
  readonly executionSource: "in-process" | "server"
  readonly mode: RuntimeExecutionMode | null
  readonly routeId: string | null
  readonly routePath: string | null
}

export interface RuntimeExecutionSuccessResult extends RuntimeExecutionBaseResult {
  readonly appRoot: string
  readonly executionSource: "in-process" | "server"
  readonly mode: RuntimeExecutionMode
  readonly output: unknown
  readonly routeId: string
  readonly routePath: string
  readonly status: "passed"
}

export interface RuntimeExecutionFailureResult extends RuntimeExecutionBaseResult {
  readonly error: RuntimeExecutionError
  readonly status: "failed"
}

export type RuntimeExecutionResult = RuntimeExecutionSuccessResult | RuntimeExecutionFailureResult
