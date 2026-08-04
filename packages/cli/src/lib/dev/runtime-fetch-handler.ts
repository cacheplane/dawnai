import type { MemoryStore } from "@dawn-ai/memory"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import {
  invokeResolvedRoute,
  resolveCheckpointer,
  resolveThreadsStore,
  streamResolvedRoute,
} from "../runtime/execute-route.js"
import { resolveMemoryStore } from "../runtime/resolve-memory.js"
import { resolveSandboxManager } from "../runtime/resolve-sandbox.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import { type StreamChunk, toSseEvent } from "../runtime/stream-types.js"
import { handleAgUiFetchRequest } from "./agui-handler.js"
import {
  handleMemoryApproveRequest,
  handleMemoryListRequest,
  handleMemoryRejectRequest,
} from "./memory-handler.js"
import { headersToRecord, loadMiddleware, runMiddleware } from "./middleware.js"
import { readPendingInterrupts } from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import { createRuntimeRegistry, type RuntimeRegistry } from "./runtime-registry.js"
import type { StartRuntimeServerOptions } from "./runtime-server.js"
import {
  createExecutionErrorBody,
  createRequestErrorBody,
  dawnErrorCodeOf,
} from "./server-errors.js"

// ---------------------------------------------------------------------------
// Route-table types
// ---------------------------------------------------------------------------

type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response>

interface RouteMatcher {
  readonly method: string
  readonly pattern: RegExp
  readonly handle: RouteHandler
}

// ---------------------------------------------------------------------------
// Fetch-handler factory — the transport-agnostic runtime core
// ---------------------------------------------------------------------------

export interface RuntimeFetchHandler {
  readonly fetch: (request: Request) => Promise<Response>
  readonly close: () => Promise<void>
  readonly state: { acceptingRequests: boolean; activeRequests: number; closed: boolean }
  readonly shutdownController: AbortController
}

export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions,
): Promise<RuntimeFetchHandler> {
  const registry = await createRuntimeRegistry(options.appRoot)
  const middleware = await loadMiddleware(options.appRoot)
  const threadsStore = await resolveThreadsStore(options.appRoot)
  const checkpointer = await resolveCheckpointer(options.appRoot)
  const sandboxManager = await resolveSandboxManager(options.appRoot)
  // Cast: resolveMemoryStore's declared return type (MemoryStoreLike, in
  // @dawn-ai/core) is the narrower capability-facing surface. The concrete
  // store (sqlite-backed, or user-supplied via dawn.config.ts) also exposes
  // listCandidates/delete, which the memory-candidate HTTP routes need — the
  // same cast `commands/memory.ts` uses for the CLI's `dawn memory` commands.
  const memoryStore = (await resolveMemoryStore(options.appRoot)) as unknown as MemoryStore

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
    memoryStore,
    middleware,
    registry,
    ...(sandboxManager ? { sandboxManager } : {}),
    signal: shutdownController.signal,
    threadsStore,
  })

  const fetch = async (request: Request): Promise<Response> => {
    if (!state.acceptingRequests) {
      return Response.json(createRequestErrorBody("Server is shutting down"), { status: 503 })
    }

    state.activeRequests++
    let transferredToStream = false
    try {
      const response = await dispatch(routes, request, shutdownController.signal)
      const body = response.body
      if (body && response.headers.get("content-type") === "text/event-stream") {
        // The Response exists but its SSE body is still streaming. Hold the
        // in-flight slot until the stream settles (fully read, canceled, or
        // errored) so close() cannot release sandboxes mid-stream.
        transferredToStream = true
        return new Response(
          trackStreamSettled(body, () => state.activeRequests--),
          {
            headers: response.headers,
            status: response.status,
          },
        )
      }
      return response
    } catch (error) {
      if (shutdownController.signal.aborted) {
        return Response.json(
          createRequestErrorBody("Request canceled during server shutdown", {
            error: error instanceof Error ? error.message : String(error),
          }),
          { status: 503 },
        )
      }

      const code = dawnErrorCodeOf(error)
      return Response.json(
        createExecutionErrorBody(
          "Unexpected runtime server failure",
          undefined,
          code ? { code } : undefined,
        ),
        { status: 500 },
      )
    } finally {
      if (!transferredToStream) state.activeRequests--
    }
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

  return { close, fetch, shutdownController, state }
}

/**
 * Relay `body` chunk-for-chunk, invoking `onSettled` exactly once when the
 * stream finishes for any reason — fully consumed, canceled by the consumer,
 * or errored. Used to keep an SSE response counted as in-flight until its
 * body has actually completed, since `fetch` returns as soon as the
 * `Response` object exists.
 */
function trackStreamSettled(
  body: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    onSettled()
  }
  const reader = body.getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>
      try {
        next = await reader.read()
      } catch (error) {
        settle()
        controller.error(error)
        return
      }
      if (next.done) {
        settle()
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        settle()
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Route table builder
// ---------------------------------------------------------------------------

function buildRouteTable(ctx: {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  readonly memoryStore: MemoryStore
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadsStore: ThreadsStore
}): RouteMatcher[] {
  const {
    appRoot,
    checkpointer,
    memoryStore,
    middleware,
    registry,
    sandboxManager,
    signal,
    threadsStore,
  } = ctx

  // Server-scoped map: thread_id → last routeKey used for that thread.
  // Populated by runs/stream and runs/wait; read by the resume endpoint so it
  // can re-invoke the correct route without requiring the client to repeat it.
  const threadRouteMap = new Map<string, string>()

  return [
    // ------------------------------------------------------------------
    // GET /healthz
    // ------------------------------------------------------------------
    {
      handle: async () => Response.json({ status: "ready" }, { status: 200 }),
      method: "GET",
      pattern: /^\/healthz(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads — create a new thread
    // ------------------------------------------------------------------
    {
      handle: async (request) => {
        const rawBody = await request.text()
        let metadata: Record<string, unknown> | undefined
        if (rawBody.trim()) {
          const parsed = parseJson(rawBody)
          if (!parsed.ok || !isRecord(parsed.value)) {
            return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
          }
          const bodyMetadata = (parsed.value as Record<string, unknown>).metadata
          if (bodyMetadata !== undefined) {
            if (!isRecord(bodyMetadata)) {
              return Response.json(createRequestErrorBody("metadata must be an object"), {
                status: 400,
              })
            }
            metadata = bodyMetadata
          }
        }
        const thread = await threadsStore.createThread(metadata !== undefined ? { metadata } : {})
        return Response.json(thread, { status: 200 })
      },
      method: "POST",
      pattern: /^\/threads(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id — fetch a thread
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) => {
        const thread = await threadsStore.getThread(params.thread_id ?? "")
        if (!thread) {
          return Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
        }
        return Response.json(thread, { status: 200 })
      },
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // DELETE /threads/:thread_id — delete thread + checkpoints
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) => {
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
        return new Response(null, { status: 204 })
      },
      method: "DELETE",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/runs/stream — stream SSE
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleApStreamRequest({
          appRoot,
          middleware,
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /agui/:routeId — AG-UI protocol endpoint (SSE)
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleAgUiFetchRequest({
          appRoot,
          checkpointer,
          middleware,
          registry,
          threadsStore,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          request,
          routeKey: params.routeId ?? "",
        }),
      method: "POST",
      pattern: /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /memory/candidates — list memory candidates (all namespaces)
    // ------------------------------------------------------------------
    {
      handle: async () => handleMemoryListRequest({ memoryStore }),
      method: "GET",
      pattern: /^\/memory\/candidates(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/approve — flip a candidate to active
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) =>
        handleMemoryApproveRequest({ id: params.id ?? "", memoryStore }),
      method: "POST",
      pattern: /^\/memory\/candidates\/(?<id>[^/?#]+)\/approve(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/reject — delete the record
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) =>
        handleMemoryRejectRequest({ id: params.id ?? "", memoryStore }),
      method: "POST",
      pattern: /^\/memory\/candidates\/(?<id>[^/?#]+)\/reject(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/runs/wait — block and return final state
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleApWaitRequest({
          appRoot,
          middleware,
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id/state — latest checkpoint state
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) => {
        const threadId = params.thread_id ?? ""
        const tuple = await checkpointer.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        })
        if (!tuple) {
          return Response.json(createRequestErrorBody("No checkpoint found for thread"), {
            status: 404,
          })
        }
        const apState = {
          config: tuple.config,
          created_at: new Date().toISOString(),
          metadata: tuple.metadata,
          next: tuple.pendingWrites?.map(([, channel]) => channel) ?? [],
          parent_config: tuple.parentConfig ?? null,
          values: tuple.checkpoint.channel_values ?? {},
        }
        return Response.json(apState, { status: 200 })
      },
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/state(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/resume — resolve a parked interrupt
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleResumeRequest({
          appRoot,
          checkpointer,
          middleware,
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore,
        }),
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
  request: Request,
  _signal: AbortSignal,
): Promise<Response> {
  const method = request.method
  const pathname = new URL(request.url).pathname

  for (const route of routes) {
    if (route.method !== method) continue
    const match = route.pattern.exec(pathname)
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

    return await route.handle(request, params)
  }

  return Response.json(createRequestErrorBody("Not found"), { status: 404 })
}

// ---------------------------------------------------------------------------
// AP stream handler
// ---------------------------------------------------------------------------

async function handleApStreamRequest(options: {
  readonly appRoot: string
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    middleware,
    registry,
    request,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  const rawBody = await request.text()
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    return Response.json(createRequestErrorBody(validated.message), { status: 400 })
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
  }

  // Run middleware
  const requestUrl = new URL(request.url)
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    method: request.method,
    params: extractRouteParams(route.routeId, input),
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    return Response.json(mwResult.body, { status: mwResult.status })
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

  // Client disconnect (request.signal) or stream cancellation stops the run;
  // the shutdown signal continues to abort it exactly as before.
  const streamAbort = new AbortController()
  const abortStream = () => streamAbort.abort()
  if (request.signal.aborted) abortStream()
  else request.signal.addEventListener("abort", abortStream, { once: true })
  const runSignal = AbortSignal.any([signal, streamAbort.signal])

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        try {
          for await (const chunk of streamResolvedRoute({
            appRoot,
            input,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            routeFile: route.routeFile,
            routeId: route.routeId,
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal: runSignal,
            threadId,
          })) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
        } catch (error) {
          const errorChunk: StreamChunk = {
            output: { error: error instanceof Error ? error.message : String(error) },
            type: "done",
          }
          safeEnqueue(controller, encoder.encode(toSseEvent(errorChunk)))
          await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
        }
      } finally {
        safeClose(controller)
      }
    },
    cancel() {
      abortStream()
    },
  })

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
}

// ---------------------------------------------------------------------------
// AP wait handler
// ---------------------------------------------------------------------------

async function handleApWaitRequest(options: {
  readonly appRoot: string
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    middleware,
    registry,
    request,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  const rawBody = await request.text()
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    return Response.json(createRequestErrorBody("Malformed request body"), { status: 400 })
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    return Response.json(createRequestErrorBody(validated.message), { status: 400 })
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
  }

  // Run middleware
  const requestUrl = new URL(request.url)
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    method: request.method,
    params: extractRouteParams(route.routeId, input),
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    return Response.json(mwResult.body, { status: mwResult.status })
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
    return Response.json(createRequestErrorBody("Request canceled during server shutdown"), {
      status: 503,
    })
  }

  await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)

  if (result.status === "failed") {
    if (signal.aborted) {
      return Response.json(
        createRequestErrorBody("Request canceled during server shutdown", {
          error: result.error.message,
        }),
        { status: 503 },
      )
    }

    if (result.error.kind === "execution_error") {
      return Response.json(createExecutionErrorBody(result.error.message, result.error.details), {
        status: 500,
      })
    }

    return Response.json(
      createRequestErrorBody("Route execution failed before execution began", {
        error: result.error,
      }),
      { status: 500 },
    )
  }

  return Response.json(result.output, { status: 200 })
}

// ---------------------------------------------------------------------------
// Resume handler — state-based, reads __interrupt__ from SQLite checkpoint
// ---------------------------------------------------------------------------

async function handleResumeRequest(options: {
  readonly appRoot: string
  readonly checkpointer: BaseCheckpointSaver
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    checkpointer,
    middleware,
    registry,
    request,
    sandboxManager,
    signal,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  if (!threadId) {
    return Response.json(createRequestErrorBody("Missing thread_id in resume URL"), {
      status: 400,
    })
  }

  const rawBody = await request.text()
  const parsedBody = parseJson(rawBody)
  if (!parsedBody.ok || !isRecord(parsedBody.value)) {
    return Response.json(createRequestErrorBody("Malformed resume request body"), { status: 400 })
  }

  const body = parsedBody.value
  const interruptId = typeof body.interrupt_id === "string" ? body.interrupt_id : undefined
  const decision = body.decision
  // Optional route key supplied by the client — used when the in-memory map
  // has been cleared (e.g. after a server restart). Populated by the resume
  // endpoint before starting the SSE stream.
  const bodyRoute = typeof body.route === "string" ? body.route : undefined
  if (!interruptId) {
    return Response.json(createRequestErrorBody("Missing interrupt_id"), { status: 400 })
  }
  if (decision !== "once" && decision !== "always" && decision !== "deny") {
    return Response.json(createRequestErrorBody("decision must be 'once', 'always', or 'deny'"), {
      status: 400,
    })
  }

  const pendingInterrupts = await readPendingInterrupts(checkpointer, threadId)
  if (!pendingInterrupts) {
    return Response.json(createRequestErrorBody("Thread not found", { code: "thread_not_found" }), {
      status: 404,
    })
  }

  if (pendingInterrupts.malformed) {
    return Response.json(
      createRequestErrorBody("Malformed checkpoint interrupts", {
        code: "malformed_checkpoint",
      }),
      { status: 409 },
    )
  }

  if (!pendingInterrupts.interrupts.some((pending) => pending.aliases.includes(interruptId))) {
    return Response.json(
      createRequestErrorBody("Stale interrupt_id", { code: "stale_interrupt" }),
      { status: 409 },
    )
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
    return Response.json(
      createRequestErrorBody(
        "Cannot resume: no route recorded for this thread. " +
          "Pass `route` in the resume body (e.g. '/chat#agent') to resume explicitly.",
        { code: "route_not_found" },
      ),
      { status: 409 },
    )
  }

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
  }

  // Run middleware with the resume URL
  const requestUrl = new URL(request.url)
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    method: "POST",
    params: {},
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    return Response.json(mwResult.body, { status: mwResult.status })
  }

  // Mark thread busy
  await threadsStore.updateStatus(threadId, "busy")

  // Open a new SSE stream, passing Command({resume: decision}) as input.
  // Client disconnect (request.signal) or stream cancellation stops the run;
  // the shutdown signal continues to abort it exactly as before.
  const streamAbort = new AbortController()
  const abortStream = () => streamAbort.abort()
  if (request.signal.aborted) abortStream()
  else request.signal.addEventListener("abort", abortStream, { once: true })
  const runSignal = AbortSignal.any([signal, streamAbort.signal])

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        try {
          for await (const chunk of streamResolvedRoute({
            appRoot,
            input: {},
            resume: decision,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            routeFile: route.routeFile,
            routeId: route.routeId,
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal: runSignal,
            threadId,
          })) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
        } catch (error) {
          const errorChunk: StreamChunk = {
            output: { error: error instanceof Error ? error.message : String(error) },
            type: "done",
          }
          safeEnqueue(controller, encoder.encode(toSseEvent(errorChunk)))
          await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
        }
      } finally {
        safeClose(controller)
      }
    },
    cancel() {
      abortStream()
    },
  })

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
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

function safeEnqueue(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) {
  try {
    controller.enqueue(chunk)
  } catch {
    // The consumer already canceled the stream — writes become no-ops, exactly
    // like `response.write` on a disconnected socket did.
  }
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>) {
  try {
    controller.close()
  } catch {
    // Already canceled/errored.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
