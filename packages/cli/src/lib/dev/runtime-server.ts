import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { executeResolvedRoute } from "../runtime/execute-route.js"
import { createRuntimeRegistry, type RuntimeRegistry } from "./runtime-registry.js"
import { createExecutionErrorBody, createRequestErrorBody } from "./server-errors.js"

export interface RuntimeServer {
  readonly close: () => Promise<void>
  readonly url: string
}

export interface StartRuntimeServerOptions {
  readonly appRoot: string
  readonly port?: number
}

export async function startRuntimeServer(
  options: StartRuntimeServerOptions,
): Promise<RuntimeServer> {
  const registry = await createRuntimeRegistry(options.appRoot)
  const state = {
    acceptingRequests: true,
    activeRequests: 0,
    closed: false,
  }
  const shutdownController = new AbortController()

  const server = createServer(async (request, response) => {
    if (!state.acceptingRequests) {
      sendJson(response, 503, createRequestErrorBody("Server is shutting down"))
      return
    }

    state.activeRequests++
    try {
      await handleRequest({ registry, request, response, signal: shutdownController.signal })
    } catch (error) {
      if (shutdownController.signal.aborted) {
        sendJson(
          response,
          503,
          createRequestErrorBody("Request canceled during server shutdown", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        return
      }

      sendJson(response, 500, createExecutionErrorBody("Unexpected runtime server failure"))
    } finally {
      state.activeRequests--
    }
  })

  await listen(server, options.port)

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Runtime server did not bind to a TCP address")
  }

  return {
    close: async () => {
      if (state.closed) {
        return
      }

      state.acceptingRequests = false
      state.closed = true
      shutdownController.abort(new Error("Runtime server shutting down"))

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          if (state.activeRequests === 0) {
            resolve()
            return
          }

          const interval = setInterval(() => {
            if (state.activeRequests > 0) {
              return
            }

            clearInterval(interval)
            resolve()
          }, 10)
        })
      })
    },
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
  }
}

async function handleRequest(options: {
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
}): Promise<void> {
  const { request, response, registry, signal } = options

  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, { status: "ready" })
    return
  }

  if (request.method !== "POST" || request.url !== "/runs/wait") {
    sendJson(response, 404, createRequestErrorBody("Not found"))
    return
  }

  const rawBody = await readRequestBody(request)
  const parsedBody = parseJson(rawBody)

  if (!parsedBody.ok) {
    sendJson(response, 400, createRequestErrorBody("Malformed request body"))
    return
  }

  const validatedBody = validateRunsWaitRequest(parsedBody.value)

  if (!validatedBody.ok) {
    sendJson(response, 400, createRequestErrorBody(validatedBody.message, validatedBody.details))
    return
  }

  const route = registry.lookup(validatedBody.value.assistant_id)

  if (!route) {
    sendJson(
      response,
      404,
      createRequestErrorBody(`Unknown assistant_id: ${validatedBody.value.assistant_id}`),
    )
    return
  }

  if (
    validatedBody.value.metadata.dawn.route_id !== route.routeId ||
    validatedBody.value.metadata.dawn.route_path !== route.routePath ||
    validatedBody.value.metadata.dawn.mode !== route.mode ||
    validatedBody.value.assistant_id !== route.assistantId
  ) {
    sendJson(
      response,
      400,
      createRequestErrorBody("Request metadata does not match the registered route", {
        assistant_id: validatedBody.value.assistant_id,
        expected: {
          assistant_id: route.assistantId,
          mode: route.mode,
          route_id: route.routeId,
          route_path: route.routePath,
        },
        received: validatedBody.value.metadata.dawn,
      }),
    )
    return
  }

  const resultPromise = executeResolvedRoute({
    appRoot: registry.appRoot,
    input: validatedBody.value.input,
    signal,
    routeFile: route.routeFile,
    routeId: route.routeId,
    routePath: route.routePath,
  })
  const result = await raceRequestAgainstShutdown(resultPromise, signal)

  if (result === SHUTDOWN_ABORTED) {
    sendJson(response, 503, createRequestErrorBody("Request canceled during server shutdown"))
    return
  }

  if (result.status === "failed") {
    if (signal.aborted) {
      sendJson(
        response,
        503,
        createRequestErrorBody("Request canceled during server shutdown", {
          error: result.error.message,
        }),
      )
      return
    }

    if (result.error.kind === "execution_error") {
      sendJson(response, 500, createExecutionErrorBody(result.error.message, result.error.details))
      return
    }

    sendJson(
      response,
      500,
      createRequestErrorBody("Route execution failed before execution began", {
        error: result.error,
      }),
    )
    return
  }

  sendJson(response, 200, result.output)
}

const SHUTDOWN_ABORTED = Symbol("shutdown-aborted")

async function raceRequestAgainstShutdown<T>(
  execution: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof SHUTDOWN_ABORTED> {
  if (signal.aborted) {
    void execution.catch(() => undefined)
    return SHUTDOWN_ABORTED
  }

  const shutdown = new Promise<typeof SHUTDOWN_ABORTED>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      resolve(SHUTDOWN_ABORTED)
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })

  const result = await Promise.race([execution, shutdown])

  if (result === SHUTDOWN_ABORTED) {
    void execution.catch(() => undefined)
  }

  return result
}

function validateRunsWaitRequest(
  value: unknown,
):
  | { readonly ok: true; readonly value: RunsWaitRequest }
  | { readonly details?: Record<string, unknown>; readonly message: string; readonly ok: false } {
  if (!isRecord(value)) {
    return { message: "Request body must be an object", ok: false }
  }

  if (typeof value.assistant_id !== "string") {
    return { message: "Request body must include assistant_id as a string", ok: false }
  }

  if (!isRecord(value.metadata) || !isRecord(value.metadata.dawn)) {
    return { message: "Request body must include metadata.dawn", ok: false }
  }

  if (typeof value.metadata.dawn.mode !== "string") {
    return { message: "Request body must include metadata.dawn.mode as a string", ok: false }
  }

  if (typeof value.metadata.dawn.route_id !== "string") {
    return { message: "Request body must include metadata.dawn.route_id as a string", ok: false }
  }

  if (typeof value.metadata.dawn.route_path !== "string") {
    return { message: "Request body must include metadata.dawn.route_path as a string", ok: false }
  }

  if (!Object.hasOwn(value, "input")) {
    return { message: "Request body must include input", ok: false }
  }

  if (value.on_completion !== "delete") {
    return { message: "Request body must set on_completion to delete", ok: false }
  }

  return {
    ok: true as const,
    value: value as unknown as RunsWaitRequest,
  }
}

interface RunsWaitRequest {
  readonly assistant_id: string
  readonly input: unknown
  readonly metadata: {
    readonly dawn: {
      readonly mode: "graph" | "workflow"
      readonly route_id: string
      readonly route_path: string
    }
  }
  readonly on_completion: "delete"
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
    return { ok: false }
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks).toString("utf8")
}

async function listen(server: ReturnType<typeof createServer>, port?: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port ?? 0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
