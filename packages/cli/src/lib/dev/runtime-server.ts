import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import {
  invokeResolvedRoute,
  resolveCheckpointer,
  resolveThreadsStore,
  streamResolvedRoute,
} from "../runtime/execute-route.js"
import { resolveSandboxManager } from "../runtime/resolve-sandbox.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import { type StreamChunk, toSseEvent } from "../runtime/stream-types.js"
import { handleAgUiRequest } from "./agui-handler.js"
import { loadMiddleware, runMiddleware } from "./middleware.js"
import { readPendingInterrupts } from "./pending-interrupts.js"
import { createRuntimeRegistry, type RuntimeRegistry } from "./runtime-registry.js"
import { createExecutionErrorBody, createRequestErrorBody } from "./server-errors.js"

export interface RuntimeServer {
  readonly close: () => Promise<void>
  readonly url: string
}

export interface StartRuntimeServerOptions {
  readonly appRoot: string
  readonly host?: string
  readonly port?: number
}

// ---------------------------------------------------------------------------
// Route-table types
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>

interface RouteMatcher {
  readonly method: string
  readonly pattern: RegExp
  readonly handle: RouteHandler
}

// ---------------------------------------------------------------------------
// Server factory — listener-only (no port binding)
// ---------------------------------------------------------------------------

export interface RuntimeRequestListener {
  readonly listener: (req: IncomingMessage, res: ServerResponse) => void
  readonly close: () => Promise<void>
  readonly state: { acceptingRequests: boolean; activeRequests: number; closed: boolean }
  readonly shutdownController: AbortController
}

export async function createRuntimeRequestListener(
  options: StartRuntimeServerOptions,
): Promise<RuntimeRequestListener> {
  const registry = await createRuntimeRegistry(options.appRoot)
  const middleware = await loadMiddleware(options.appRoot)
  const threadsStore = await resolveThreadsStore(options.appRoot)
  const checkpointer = await resolveCheckpointer(options.appRoot)
  const sandboxManager = await resolveSandboxManager(options.appRoot)

  let sandboxReaper: ReturnType<typeof setInterval> | undefined
  if (sandboxManager) {
    sandboxReaper = setInterval(() => {
      void sandboxManager.reapIdle()
    }, 60_000)
    sandboxReaper.unref?.()
  }

  const state = {
    acceptingRequests: true,
    activeRequests: 0,
    closed: false,
  }
  const shutdownController = new AbortController()

  const routes = buildRouteTable({
    appRoot: options.appRoot,
    checkpointer,
    middleware,
    registry,
    ...(sandboxManager ? { sandboxManager } : {}),
    signal: shutdownController.signal,
    threadsStore,
  })

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (!state.acceptingRequests) {
        sendJson(response, 503, createRequestErrorBody("Server is shutting down"))
        return
      }

      state.activeRequests++
      try {
        await dispatch(routes, request, response, shutdownController.signal)
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
    })()
  }

  const close = async (): Promise<void> => {
    if (state.closed) {
      return
    }

    state.acceptingRequests = false
    state.closed = true
    shutdownController.abort(new Error("Runtime server shutting down"))

    if (sandboxReaper) clearInterval(sandboxReaper)

    // Drain in-flight requests
    await new Promise<void>((resolve) => {
      const check = () => {
        if (state.activeRequests === 0) {
          resolve()
        } else {
          const interval = setInterval(() => {
            if (state.activeRequests > 0) {
              return
            }
            clearInterval(interval)
            resolve()
          }, 10)
        }
      }
      check()
    })

    // Release sandboxes only after in-flight requests have drained, so tools
    // executing against a sandbox are never yanked mid-request.
    if (sandboxManager) await sandboxManager.releaseAll()
  }

  return { close, listener, shutdownController, state }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export async function startRuntimeServer(
  options: StartRuntimeServerOptions,
): Promise<RuntimeServer> {
  const { close: listenerClose, listener, state } = await createRuntimeRequestListener(options)

  const server = createServer(listener)

  await listen(server, options.host, options.port)

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Runtime server did not bind to a TCP address")
  }

  // The bind host (e.g. "0.0.0.0") is not always dialable directly — report a
  // dialable loopback host in the returned url while still binding the
  // requested interface.
  const urlHost = toUrlHost(options.host)

  return {
    close: async () => {
      if (state.closed) {
        return
      }
      // Stop accepting new TCP connections; existing sockets finish below.
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      // Abort + drain in-flight requests + clear the sandbox reaper + release
      // sandboxes — the single shutdown path shared with the in-process
      // listener. This is the only place that flips state.closed.
      await listenerClose()
      await serverClosed
    },
    url: `http://${urlHost}:${(address as AddressInfo).port}`,
  }
}

/**
 * Map a bind host to a dialable URL host.
 *
 * Wildcard bind hosts are not dialable, so they map to their loopback:
 * `0.0.0.0` → `127.0.0.1`, `::` → `::1`. Any IPv6 literal (contains `:` and is
 * not already bracketed) is wrapped in `[...]` so it forms a valid URL
 * authority, e.g. `::1` → `[::1]`.
 */
function toUrlHost(host: string | undefined): string {
  const resolved = host ?? "127.0.0.1"
  if (resolved === "0.0.0.0") {
    return "127.0.0.1"
  }
  if (resolved === "::") {
    return "[::1]"
  }
  if (resolved.includes(":") && !resolved.startsWith("[")) {
    return `[${resolved}]`
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Route table builder
// ---------------------------------------------------------------------------

function buildRouteTable(ctx: {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadsStore: ThreadsStore
}): RouteMatcher[] {
  const { appRoot, checkpointer, middleware, registry, sandboxManager, signal, threadsStore } = ctx

  // Server-scoped map: thread_id → last routeKey used for that thread.
  // Populated by runs/stream and runs/wait; read by the resume endpoint so it
  // can re-invoke the correct route without requiring the client to repeat it.
  const threadRouteMap = new Map<string, string>()

  return [
    // ------------------------------------------------------------------
    // GET /healthz
    // ------------------------------------------------------------------
    {
      handle: async (_req, res) => {
        sendJson(res, 200, { status: "ready" })
      },
      method: "GET",
      pattern: /^\/healthz(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads — create a new thread
    // ------------------------------------------------------------------
    {
      handle: async (req, res) => {
        const rawBody = await readRequestBody(req)
        let metadata: Record<string, unknown> | undefined
        if (rawBody.trim()) {
          const parsed = parseJson(rawBody)
          if (!parsed.ok || !isRecord(parsed.value)) {
            sendJson(res, 400, createRequestErrorBody("Malformed request body"))
            return
          }
          const bodyMetadata = (parsed.value as Record<string, unknown>).metadata
          if (bodyMetadata !== undefined) {
            if (!isRecord(bodyMetadata)) {
              sendJson(res, 400, createRequestErrorBody("metadata must be an object"))
              return
            }
            metadata = bodyMetadata
          }
        }
        const thread = await threadsStore.createThread(metadata !== undefined ? { metadata } : {})
        sendJson(res, 200, thread)
      },
      method: "POST",
      pattern: /^\/threads(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id — fetch a thread
    // ------------------------------------------------------------------
    {
      handle: async (_req, res, params) => {
        const thread = await threadsStore.getThread(params.thread_id ?? "")
        if (!thread) {
          sendJson(res, 404, createRequestErrorBody("Thread not found"))
          return
        }
        sendJson(res, 200, thread)
      },
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // DELETE /threads/:thread_id — delete thread + checkpoints
    // ------------------------------------------------------------------
    {
      handle: async (_req, res, params) => {
        const threadId = params.thread_id ?? ""
        await threadsStore.deleteThread(threadId)
        // Best-effort: delete checkpoints if the saver supports it.
        if (
          typeof (checkpointer as unknown as { deleteThread?: unknown }).deleteThread === "function"
        ) {
          await (
            checkpointer as unknown as { deleteThread(id: string): Promise<void> }
          ).deleteThread(threadId)
        }
        if (sandboxManager) await sandboxManager.destroyThread(threadId)
        res.writeHead(204)
        res.end()
      },
      method: "DELETE",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/runs/stream — stream SSE
    // ------------------------------------------------------------------
    {
      handle: async (req, res, params) => {
        await handleApStreamRequest({
          appRoot,
          middleware,
          registry,
          request: req,
          response: res,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        })
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /agui/:routeId — AG-UI protocol endpoint (SSE)
    // ------------------------------------------------------------------
    {
      handle: async (req, res, params) => {
        await handleAgUiRequest({
          appRoot,
          registry,
          threadsStore,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          request: req,
          response: res,
          routeKey: params.routeId ?? "",
        })
      },
      method: "POST",
      pattern: /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/runs/wait — block and return final state
    // ------------------------------------------------------------------
    {
      handle: async (req, res, params) => {
        await handleApWaitRequest({
          appRoot,
          middleware,
          registry,
          request: req,
          response: res,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        })
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id/state — latest checkpoint state
    // ------------------------------------------------------------------
    {
      handle: async (_req, res, params) => {
        const threadId = params.thread_id ?? ""
        const tuple = await checkpointer.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        })
        if (!tuple) {
          sendJson(res, 404, createRequestErrorBody("No checkpoint found for thread"))
          return
        }
        const apState = {
          config: tuple.config,
          created_at: new Date().toISOString(),
          metadata: tuple.metadata,
          next: tuple.pendingWrites?.map(([, channel]) => channel) ?? [],
          parent_config: tuple.parentConfig ?? null,
          values: tuple.checkpoint.channel_values ?? {},
        }
        sendJson(res, 200, apState)
      },
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/state(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/resume — resolve a parked interrupt
    // ------------------------------------------------------------------
    {
      handle: async (req, res, params) => {
        await handleResumeRequest({
          appRoot,
          checkpointer,
          middleware,
          registry,
          request: req,
          response: res,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        })
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/resume(?:\?.*)?$/,
    },
  ]
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(
  routes: RouteMatcher[],
  request: IncomingMessage,
  response: ServerResponse,
  _signal: AbortSignal,
): Promise<void> {
  const method = request.method ?? ""
  const url = request.url ?? "/"

  for (const route of routes) {
    if (route.method !== method) continue
    const match = route.pattern.exec(url)
    if (!match) continue

    // Collect named capture groups as params
    const params: Record<string, string> = {}
    if (match.groups) {
      for (const [key, value] of Object.entries(match.groups)) {
        if (value !== undefined) {
          params[key] = decodeURIComponent(value)
        }
      }
    }

    await route.handle(request, response, params)
    return
  }

  sendJson(response, 404, createRequestErrorBody("Not found"))
}

// ---------------------------------------------------------------------------
// AP stream handler
// ---------------------------------------------------------------------------

async function handleApStreamRequest(options: {
  readonly appRoot: string
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<void> {
  const {
    appRoot,
    middleware,
    registry,
    request,
    response,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  const rawBody = await readRequestBody(request)
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    sendJson(response, 400, createRequestErrorBody("Malformed request body"))
    return
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    sendJson(response, 400, createRequestErrorBody(validated.message))
    return
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    sendJson(response, 404, createRequestErrorBody(`Unknown route: ${routeKey}`))
    return
  }

  // Run middleware
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: request.method ?? "POST",
    params: extractRouteParams(route.routeId, input),
    routeId: route.routeId,
    url: request.url ?? `/threads/${threadId}/runs/stream`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    sendJson(response, mwResult.status, mwResult.body)
    return
  }

  // Idempotently ensure the thread exists
  let thread: Thread | undefined = await threadsStore.getThread(threadId)
  if (!thread) {
    thread = await threadsStore.createThread({ thread_id: threadId })
  }

  // Record which route last ran on this thread so the resume endpoint can
  // re-invoke it without requiring the client to repeat the route key.
  // The in-memory map is fast-path for the current server session; the thread
  // metadata persists it to SQLite so resume survives a server restart.
  threadRouteMap.set(threadId, routeKey)
  await threadsStore.updateMetadata(threadId, { route: routeKey })

  // Mark thread busy
  await threadsStore.updateStatus(threadId, "busy")

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })

  try {
    for await (const chunk of streamResolvedRoute({
      appRoot,
      input,
      ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
      routeFile: route.routeFile,
      routeId: route.routeId,
      routePath: route.routePath,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal,
      threadId,
    })) {
      response.write(toSseEvent(chunk))
    }
    await threadsStore.updateStatus(threadId, "idle")
  } catch (error) {
    const errorChunk: StreamChunk = {
      output: { error: error instanceof Error ? error.message : String(error) },
      type: "done",
    }
    response.write(toSseEvent(errorChunk))
    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
  }

  response.end()
}

// ---------------------------------------------------------------------------
// AP wait handler
// ---------------------------------------------------------------------------

async function handleApWaitRequest(options: {
  readonly appRoot: string
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<void> {
  const {
    appRoot,
    middleware,
    registry,
    request,
    response,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  const rawBody = await readRequestBody(request)
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    sendJson(response, 400, createRequestErrorBody("Malformed request body"))
    return
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    sendJson(response, 400, createRequestErrorBody(validated.message))
    return
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    sendJson(response, 404, createRequestErrorBody(`Unknown route: ${routeKey}`))
    return
  }

  // Run middleware
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: request.method ?? "POST",
    params: extractRouteParams(route.routeId, input),
    routeId: route.routeId,
    url: request.url ?? `/threads/${threadId}/runs/wait`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    sendJson(response, mwResult.status, mwResult.body)
    return
  }

  // Idempotently ensure the thread exists
  let thread: Thread | undefined = await threadsStore.getThread(threadId)
  if (!thread) {
    thread = await threadsStore.createThread({ thread_id: threadId })
  }

  // Record route for potential resume (in-memory fast-path + durable metadata)
  threadRouteMap.set(threadId, routeKey)
  await threadsStore.updateMetadata(threadId, { route: routeKey })

  await threadsStore.updateStatus(threadId, "busy")

  const resultPromise = invokeResolvedRoute({
    appRoot,
    input,
    ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
    routeFile: route.routeFile,
    routeId: route.routeId,
    routePath: route.routePath,
    ...(sandboxManager ? { sandboxManager } : {}),
    signal,
    threadId,
  })

  const result = await raceRequestAgainstShutdown(resultPromise, signal)

  if (result === SHUTDOWN_ABORTED) {
    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
    sendJson(response, 503, createRequestErrorBody("Request canceled during server shutdown"))
    return
  }

  await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)

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

// ---------------------------------------------------------------------------
// Resume handler — state-based, reads __interrupt__ from SQLite checkpoint
// ---------------------------------------------------------------------------

async function handleResumeRequest(options: {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<void> {
  const {
    appRoot,
    checkpointer,
    middleware,
    registry,
    request,
    response,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  if (!threadId) {
    sendJson(response, 400, createRequestErrorBody("Missing thread_id in resume URL"))
    return
  }

  const rawBody = await readRequestBody(request)
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    sendJson(response, 400, createRequestErrorBody("Malformed resume request body"))
    return
  }

  const body = parsedBody.value
  const interruptId = typeof body.interrupt_id === "string" ? body.interrupt_id : undefined
  const decision = body.decision
  // Optional route key supplied by the client — used when the in-memory map
  // has been cleared (e.g. after a server restart). Populated by the resume
  // endpoint before starting the SSE stream.
  const bodyRoute = typeof body.route === "string" ? body.route : undefined
  if (!interruptId) {
    sendJson(response, 400, createRequestErrorBody("Missing interrupt_id"))
    return
  }
  if (decision !== "once" && decision !== "always" && decision !== "deny") {
    sendJson(response, 400, createRequestErrorBody("decision must be 'once', 'always', or 'deny'"))
    return
  }

  const pendingInterrupts = await readPendingInterrupts(checkpointer, threadId)
  if (!pendingInterrupts) {
    sendJson(
      response,
      404,
      createRequestErrorBody("Thread not found", { code: "thread_not_found" }),
    )
    return
  }

  if (pendingInterrupts.malformed) {
    sendJson(
      response,
      409,
      createRequestErrorBody("Malformed checkpoint interrupts", {
        code: "malformed_checkpoint",
      }),
    )
    return
  }

  if (!pendingInterrupts.interrupts.some((pending) => pending.aliases.includes(interruptId))) {
    sendJson(
      response,
      409,
      createRequestErrorBody("Stale interrupt_id", { code: "stale_interrupt" }),
    )
    return
  }

  // Resolve which route last ran on this thread, in priority order:
  //   1. in-memory map (fast-path, current server session)
  //   2. durable thread metadata (survives a server restart)
  //   3. client-supplied `route` in the resume body (explicit override)
  const persistedRoute = (await threadsStore.getThread(threadId))?.metadata.route
  const routeKey =
    threadRouteMap.get(threadId) ??
    (typeof persistedRoute === "string" ? persistedRoute : undefined) ??
    bodyRoute
  if (!routeKey) {
    sendJson(
      response,
      409,
      createRequestErrorBody(
        "Cannot resume: no route recorded for this thread. " +
          "Pass `route` in the resume body (e.g. '/chat#agent') to resume explicitly.",
        { code: "route_not_found" },
      ),
    )
    return
  }

  const route = registry.lookup(routeKey)
  if (!route) {
    sendJson(response, 404, createRequestErrorBody(`Unknown route: ${routeKey}`))
    return
  }

  // Run middleware with the resume URL
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: parseHeaders(request),
    method: "POST",
    params: {},
    routeId: route.routeId,
    url: request.url ?? `/threads/${threadId}/resume`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    sendJson(response, mwResult.status, mwResult.body)
    return
  }

  // Mark thread busy
  await threadsStore.updateStatus(threadId, "busy")

  // Open a new SSE stream, passing Command({resume: decision}) as input.
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })

  try {
    for await (const chunk of streamResolvedRoute({
      appRoot,
      input: {},
      resumeDecision: decision as "once" | "always" | "deny",
      ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
      routeFile: route.routeFile,
      routeId: route.routeId,
      routePath: route.routePath,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal,
      threadId,
    })) {
      response.write(toSseEvent(chunk))
    }
    await threadsStore.updateStatus(threadId, "idle")
  } catch (error) {
    const errorChunk: StreamChunk = {
      output: { error: error instanceof Error ? error.message : String(error) },
      type: "done",
    }
    response.write(toSseEvent(errorChunk))
    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
  }

  response.end()
}

// ---------------------------------------------------------------------------
// AP run body validation
// ---------------------------------------------------------------------------

interface ApRunBody {
  readonly input: unknown
  readonly routeKey: string
}

function validateApRunBody(
  body: Record<string, unknown>,
): ({ readonly ok: true } & ApRunBody) | { readonly ok: false; readonly message: string } {
  // `route` must be a string identifying the assistant/route
  if (typeof body.route !== "string") {
    return {
      message: "Request body must include route as a string (assistant_id or route_id)",
      ok: false,
    }
  }
  return {
    input: Object.hasOwn(body, "input") ? body.input : {},
    ok: true,
    routeKey: body.route,
  }
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

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

async function listen(
  server: ReturnType<typeof createServer>,
  host?: string,
  port?: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port ?? 0, host ?? "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function parseHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ")
    }
  }
  return headers
}

function extractRouteParams(routeId: string, input: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  const inputRecord = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >

  for (const match of matches) {
    const name = match[1]
    if (name && name in inputRecord) {
      params[name] = String(inputRecord[name])
    }
  }

  return params
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
