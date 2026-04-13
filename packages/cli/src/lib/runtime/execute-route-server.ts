import { createRouteAssistantId } from "./route-identity.js"
import { normalizeServerResult } from "./normalize-server-result.js"
import { createRuntimeFailureResult, formatErrorMessage, type RuntimeExecutionResult } from "./result.js"

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 30_000

export interface ExecuteRouteServerOptions {
  readonly appRoot: string
  readonly baseUrl: string
  readonly input: unknown
  readonly mode: "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
  readonly timeoutMs?: number
}

export async function executeRouteServer(
  options: ExecuteRouteServerOptions,
): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`Timed out after ${timeoutMs}ms waiting for /runs/wait`))
  }, timeoutMs)

  try {
    const response = await fetch(createRunsWaitUrl(options.baseUrl), {
      body: JSON.stringify({
        assistant_id: createRouteAssistantId(options.routeId, options.mode),
        input: options.input,
        metadata: {
          dawn: {
            mode: options.mode,
            route_id: options.routeId,
            route_path: options.routePath,
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    })
    const responseBodyText = await response.text()
    const finishedAt = Date.now()

    return normalizeServerResult({
      appRoot: options.appRoot,
      finishedAt,
      mode: options.mode,
      responseBodyText,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt,
      statusCode: response.status,
    })
  } catch (error) {
    const finishedAt = Date.now()
    const diagnostics = timedOut ? { timeoutMs } : undefined

    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "server",
      kind: "server_transport_error",
      message: timedOut
        ? `Server transport timed out after ${timeoutMs}ms waiting for /runs/wait`
        : `Server transport failed for /runs/wait: ${formatErrorMessage(error)}`,
      mode: options.mode,
      finishedAt,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt,
      ...(diagnostics ? { diagnostics } : {}),
    })
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function createRunsWaitUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${ensureTrailingSlash(url.pathname)}runs/wait`
  return url
}

function ensureTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`
}
