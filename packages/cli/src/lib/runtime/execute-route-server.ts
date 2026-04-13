import { createRouteAssistantId } from "./route-identity.js"
import { normalizeServerResult } from "./normalize-server-result.js"
import { createRuntimeFailureResult, formatErrorMessage, type RuntimeExecutionResult } from "./result.js"

export interface ExecuteRouteServerOptions {
  readonly appRoot: string
  readonly baseUrl: string
  readonly input: unknown
  readonly mode: "graph" | "workflow"
  readonly routeId: string
  readonly routePath: string
}

export async function executeRouteServer(
  options: ExecuteRouteServerOptions,
): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()

  try {
    const response = await fetch(new URL("/runs/wait", options.baseUrl), {
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
    })
    const finishedAt = Date.now()
    const responseBodyText = await response.text()

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
    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "server",
      kind: "server_transport_error",
      message: `Server transport failed for /runs/wait: ${formatErrorMessage(error)}`,
      mode: options.mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt,
    })
  }
}
