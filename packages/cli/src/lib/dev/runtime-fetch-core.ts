import { seedDawnConfig } from "@dawn-ai/core"
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import {
  type BootResolvedInstances,
  invokeResolvedRoute,
  type PreparedRouteModules,
  type RuntimeBootFallbacks,
  seedPreparedRouteModules,
  streamResolvedRoute,
} from "../runtime/execute-route-core.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { DawnStaticModules } from "../runtime/static-modules-core.js"
import { type StreamChunk, toSseEvent } from "../runtime/stream-types.js"
import { abortableAsyncIterable } from "./abortable-iterable.js"
import { handleAgUiFetchRequest } from "./agui-handler.js"
import {
  handleMemoryApproveRequest,
  handleMemoryListRequest,
  handleMemoryRejectRequest,
} from "./memory-handler.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { readPendingInterrupts } from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import { createRunRegistry, type RunRegistry } from "./run-registry.js"
import {
  createRuntimeRegistryFromManifest,
  createStaticRuntimeRegistry,
  type RuntimeRegistry,
} from "./runtime-registry-core.js"
import type { StartRuntimeServerOptions } from "./runtime-server.js"
import {
  createExecutionErrorBody,
  createRequestErrorBody,
  dawnErrorCodeOf,
} from "./server-errors.js"
import { statusResponse } from "./status-response.js"

// ---------------------------------------------------------------------------
// Route-table types
// ---------------------------------------------------------------------------

type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response>

/**
 * Boot state threaded verbatim into every route execution: the supplied
 * DawnConfig (so no route re-reads `dawn.config.ts`) and the node filesystem
 * fallback bag (absent on edge runtimes, where every store is injected).
 */
type RouteBoot = Pick<BootResolvedInstances, "bootFallbacks" | "config">

/**
 * Fail loudly for the inputs a correct run cannot do without. Which inputs
 * throw and which degrade to a documented default is enumerated once, on
 * `requireFallbacks` in `execute-route-core.ts` — that list covers this
 * module too.
 */
function requireBoot(
  fallbacks: RuntimeBootFallbacks | undefined,
  what: string,
): RuntimeBootFallbacks {
  if (fallbacks) return fallbacks
  throw new Error(
    `${what}: no instance provided and this runtime has no filesystem fallback — pass one via options (see the edge deployment docs).`,
  )
}

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

/** How long close() waits for in-flight requests before proceeding anyway. */
const CLOSE_DRAIN_DEADLINE_MS = 30_000

export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions & {
    /** Internal/test hook: override the close() drain deadline (default 30s). */
    readonly drainDeadlineMs?: number
  },
): Promise<RuntimeFetchHandler> {
  // The node filesystem fallbacks, when this runtime has any. `dawn dev` /
  // `dawn start` (and every existing test) come through
  // `runtime-fetch-handler.ts`, which supplies `nodeBootFallbacks`. An edge
  // caller supplies none: each store must then be injected, or the first use
  // throws with a message naming what is missing.
  const fallbacks = options.bootFallbacks
  const boot: RouteBoot = {
    ...(options.config ? { config: options.config } : {}),
    ...(fallbacks ? { bootFallbacks: fallbacks } : {}),
  }
  // Seed the config memo FIRST — every node fallback below (stores, sandbox,
  // memory, permissions) goes through loadDawnConfig, and a supplied config
  // means `dawn.config.ts` must never be read from disk.
  if (options.config && fallbacks) {
    seedDawnConfig(options.appRoot, options.config)
  }
  // No `modules` means the route tree must be walked — a node-only capability
  // reached through the boot fallbacks, never imported here (that would put
  // `node:fs` back in the fetch graph).
  const registry = options.modules
    ? createStaticRuntimeRegistry(options.appRoot, options.modules)
    : createRuntimeRegistryFromManifest(
        await requireBoot(fallbacks, "routeManifest").discoverRouteManifest(options.appRoot),
      )
  if (options.modules) {
    // Pre-populate the per-route prepared-modules cache (execute-route.ts)
    // from the static manifest so every route's first request also skips its
    // dynamic loads — cache hit = static, cache miss = dynamic (unreachable
    // here since every route in the registry came from `modules.routes`).
    seedPreparedRouteModules(
      new Map(
        options.modules.routes.map((route) => [
          route.routeFile,
          {
            memory: route.memory,
            module: route.module,
            stateFields: route.stateFields,
            tools: route.tools,
          } satisfies PreparedRouteModules,
        ]),
      ),
    )
  }
  // Caller-supplied instances win over every fallback resolution below —
  // an injected store means the corresponding disk/sqlite path never runs.
  const middleware =
    options.middleware ??
    options.modules?.middleware ??
    // Middleware is optional by contract, so a runtime with no filesystem
    // fallback resolves "none" rather than failing the boot.
    (await fallbacks?.loadMiddleware(options.appRoot))
  const threadsStore =
    options.threadsStore ??
    (await requireBoot(fallbacks, "threadsStore").resolveThreadsStore(options.appRoot))
  const checkpointer =
    options.checkpointer ??
    (await requireBoot(fallbacks, "checkpointer").resolveCheckpointer(options.appRoot))
  // Degrades rather than throws: sandboxing is opt-in, so no fallbacks means
  // no sandbox provider — the same result as an app with no `sandbox` config.
  const sandboxManager =
    options.sandboxManager ?? (await fallbacks?.resolveSandboxManager(options.appRoot))
  // Lazy, memoized, shared: resolveMemoryStore (and the sqlite it opens) runs
  // at most once per process, on the FIRST request that actually needs
  // memory — not unconditionally at boot for apps with no memory routes, and
  // not once per request for the capability path (execute-route.ts threads
  // this same thunk down instead of calling resolveMemoryStore itself).
  //
  // No cast needed: the config-facing store type is the full MemoryStore
  // contract (browse/stats/delete/listCandidates included), so the resolved
  // store satisfies the memory-candidate HTTP routes directly.
  let memoryStorePromise: Promise<MemoryStore> | undefined
  const getMemoryStore = (): Promise<MemoryStore> => {
    memoryStorePromise ??= options.memoryStore
      ? options.memoryStore()
      : (requireBoot(fallbacks, "memoryStore").resolveMemoryStore(
          options.appRoot,
        ) as Promise<MemoryStore>)
    return memoryStorePromise
  }

  // Permissions store: an injected `options.permissionsStore` wins REGARDLESS
  // of permissionsMode — the caller has taken over resolution entirely (it may
  // itself be an instance or a per-request factory). Otherwise, per
  // StartRuntimeServerOptions.permissionsMode: "boot" (production) loads once
  // here and reuses the instance; the default "per-request" (dev) hands route
  // execution a factory that re-loads `.dawn/permissions.json` each request,
  // so HITL "Always" grants written mid-process apply immediately — the one
  // deliberate per-request read kept.
  const resolvePermissions = (): Promise<PermissionsStore> =>
    requireBoot(fallbacks, "permissionsStore").resolvePermissionsStore(options.appRoot)
  const permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>) =
    options.permissionsStore ??
    (options.permissionsMode === "boot" ? await resolvePermissions() : resolvePermissions)

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
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    ...(sandboxManager ? { sandboxManager } : {}),
    signal: shutdownController.signal,
    // Boot manifest → route execution derives the subagents descriptor maps
    // from it with zero entry-file imports.
    ...(options.modules ? { staticModules: options.modules } : {}),
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
        // errored) so close() cannot release sandboxes mid-stream. The flag
        // flips only after the tracked Response has been constructed — if
        // construction throws, the finally below must still decrement.
        const tracked = new Response(
          trackStreamSettled(body, () => state.activeRequests--),
          {
            headers: response.headers,
            status: response.status,
          },
        )
        transferredToStream = true
        return tracked
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

    // Drain in-flight requests — bounded: an SSE body nobody ever reads (or a
    // leaked in-flight slot) must not wedge shutdown forever.
    const drainDeadlineMs = options.drainDeadlineMs ?? CLOSE_DRAIN_DEADLINE_MS
    await new Promise<void>((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        if (state.activeRequests === 0) {
          resolve()
          return
        }
        if (Date.now() - startedAt >= drainDeadlineMs) {
          console.warn(
            `close(): ${state.activeRequests} request(s) still active after ` +
              `${Math.round(drainDeadlineMs / 1000)}s — proceeding with shutdown`,
          )
          resolve()
          return
        }
        setTimeout(check, 10)
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
  readonly boot: RouteBoot
  readonly checkpointer: BaseCheckpointSaver
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly staticModules?: DawnStaticModules
  readonly threadsStore: ThreadsStore
}): RouteMatcher[] {
  const {
    appRoot,
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    sandboxManager,
    signal,
    staticModules,
    threadsStore,
  } = ctx

  // Server-scoped map: thread_id → last routeKey used for that thread.
  // Populated by runs/stream and runs/wait; read by the resume endpoint so it
  // can re-invoke the correct route without requiring the client to repeat it.
  const threadRouteMap = new Map<string, string>()

  // Process-local in-flight run tracking: enables the concurrency gate, the
  // per-run abort signal, and POST /threads/:id/cancel. Scoped to this route
  // table (not module-level) so multiple handler instances in one process —
  // which the (Request) => Response core exists to allow — stay isolated.
  const runRegistry = createRunRegistry()

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
    // POST /threads/:thread_id/cancel — stop the in-flight run
    // ------------------------------------------------------------------
    // Thread-scoped rather than LangGraph's runs/:run_id/cancel: Dawn has no
    // run identity, and the one-run-per-thread gate makes the thread id an
    // unambiguous stand-in. Semantics match LangGraph's action=interrupt —
    // stop the run, keep checkpointed state. Rollback is not supported.
    {
      handle: async (_request, params) => {
        const threadId = params.thread_id ?? ""
        // Cancel first: it is synchronous, so nothing can interleave between
        // observing the slot and aborting it. Awaiting getThread beforehand
        // would open a window in which the run we cancel is not the run the
        // caller observed (run N finishes and releases its slot, run N+1
        // begins on the same thread, and the cancel — issued against N — hits
        // N+1 instead).
        //
        // Known, accepted race: a cancel arriving between the route finishing
        // and its idle-status write completing still finds the slot and reports
        // "interrupted" for a run that actually completed. The window is a
        // single DB write wide and corrupts nothing — the streaming client has
        // already received the real output. Closing it would require tracking a
        // settled state per run, which is not worth the complexity.
        if (runRegistry.cancel(threadId)) {
          return Response.json({ status: "interrupted", thread_id: threadId }, { status: 200 })
        }
        const thread = await threadsStore.getThread(threadId)
        if (!thread) {
          return Response.json(
            createRequestErrorBody("Thread not found", { code: "thread_not_found" }),
            { status: 404 },
          )
        }
        // Deliberately not an idempotent 200: a silent success would hide
        // the fact that this process is not the one running the thread.
        return Response.json(
          createRequestErrorBody(`No run in flight for thread "${threadId}"`, {
            code: "no_run_in_flight",
          }),
          { status: 409 },
        )
      },
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/cancel(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /threads/:thread_id/runs/stream — stream SSE
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleApStreamRequest({
          appRoot,
          boot,
          checkpointer,
          getMemoryStore,
          middleware,
          permissionsStore,
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          runRegistry,
          signal,
          ...(staticModules ? { staticModules } : {}),
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
          boot,
          checkpointer,
          getMemoryStore,
          middleware,
          permissionsStore,
          registry,
          threadsStore,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          ...(staticModules ? { staticModules } : {}),
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
      handle: async () => handleMemoryListRequest({ memoryStore: await getMemoryStore() }),
      method: "GET",
      pattern: /^\/memory\/candidates(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/approve — approve with reconciliation
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) =>
        handleMemoryApproveRequest({
          appRoot,
          ...(boot.bootFallbacks
            ? { resolveIdentityKeys: boot.bootFallbacks.resolveIdentityKeys }
            : {}),
          id: params.id ?? "",
          memoryStore: await getMemoryStore(),
        }),
      method: "POST",
      pattern: /^\/memory\/candidates\/(?<id>[^/?#]+)\/approve(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/reject — delete the record
    // ------------------------------------------------------------------
    {
      handle: async (_request, params) =>
        handleMemoryRejectRequest({ id: params.id ?? "", memoryStore: await getMemoryStore() }),
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
          boot,
          checkpointer,
          getMemoryStore,
          middleware,
          permissionsStore,
          registry,
          request,
          runRegistry,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          ...(staticModules ? { staticModules } : {}),
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
          boot,
          checkpointer,
          getMemoryStore,
          middleware,
          permissionsStore,
          registry,
          request,
          runRegistry,
          ...(sandboxManager ? { sandboxManager } : {}),
          signal,
          ...(staticModules ? { staticModules } : {}),
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
  readonly boot: RouteBoot
  readonly checkpointer: BaseCheckpointSaver
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly runRegistry: RunRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly staticModules?: DawnStaticModules
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    request,
    runRegistry,
    sandboxManager,
    signal,
    staticModules,
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
    return statusResponse(mwResult.status, mwResult.body)
  }

  // Idempotently ensure the thread exists
  let thread: Thread | undefined = await threadsStore.getThread(threadId)
  if (!thread) {
    thread = await threadsStore.createThread({ thread_id: threadId })
  }

  // Claim the thread's run slot. Dawn has no run_id, so one run per thread is
  // what makes "cancel this thread's run" well-defined — and it stops two runs
  // from interleaving checkpoint writes against the same LangGraph thread.
  // Gated on the in-memory registry, never the persisted status column, so a
  // process that crashed mid-run does not brick the thread with a stale "busy".
  // Deliberately BEFORE any thread-state mutation below: a rejected request
  // must never clobber the recorded route (or anything else) for the run that
  // is genuinely in flight — that's the same class of corruption this gate
  // exists to prevent, just via metadata instead of checkpoint writes.
  const run = runRegistry.begin(threadId, signal)
  if (!run) {
    return Response.json(
      createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
        code: "run_in_flight",
      }),
      { status: 409 },
    )
  }

  // Record which route last ran on this thread so the resume endpoint can
  // re-invoke it without requiring the client to repeat the route key.
  // The in-memory map is fast-path for the current server session; the thread
  // metadata persists it to SQLite so resume survives a server restart.
  threadRouteMap.set(threadId, routeKey)
  try {
    await threadsStore.updateMetadata(threadId, { route: routeKey })
    await threadsStore.updateStatus(threadId, "busy")
  } catch (error) {
    // The stream's finally has not been armed yet, so nothing else would ever
    // free this slot — without an explicit release the thread would 409 for the
    // remaining life of the process.
    run.release()
    throw error
  }

  // A client disconnect deliberately does NOT stop the run.
  //
  // Agent Protocol is Dawn's durable surface: runs are checkpointed and a
  // thread can be resumed, so a dropped socket is a lost viewer, not a lost
  // intent — and a deliberate stop and a network drop are indistinguishable
  // on the wire. LangGraph Platform, the reference AP server, defaults to
  // on_disconnect: "continue" for exactly this pair of endpoints. Aborting
  // instead would discard streamed-but-not-yet-checkpointed state and leave
  // the thread behind what the user already saw (LangGraph issue #5672).
  //
  // Cancellation is therefore explicit: POST /threads/:id/cancel. AG-UI takes
  // the opposite default because it is ephemeral with nothing to reattach to.
  // Rationale: docs/superpowers/specs/2026-08-06-ap-run-cancellation.md
  const encoder = new TextEncoder()
  // Set only when abortableAsyncIterable stops CONSUMING the route on abort —
  // it wins a race against iterator.next() and does not wait for the route's
  // own `.return()` to settle. A route suspended at a non-abortable await
  // (subprocess, non-abort-aware SDK, CPU-bound loop) keeps running after
  // that race is won. See the finally below for why this matters.
  let sourceCleanup: Promise<void> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        try {
          const routeStream = streamResolvedRoute({
            appRoot,
            ...boot,
            checkpointer,
            input,
            memoryStore: getMemoryStore,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            permissionsStore,
            routeFile: route.routeFile,
            routeId: route.routeId,
            ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal: run.signal,
            ...(staticModules ? { staticModules } : {}),
            threadId,
            threadsStore,
          })
          // Belt-and-braces, mirroring the AG-UI handler: pass the signal to
          // the route *and* wrap the iterator, so a route that ignores its
          // ctx.signal still stops when the run is cancelled. The third
          // argument lets us observe when the route's OWN cleanup finishes,
          // independently of when this loop stops consuming it.
          for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
            sourceCleanup = p
          })) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
        } catch (error) {
          // A cancelled run is not a failure: clients must be able to tell the
          // two apart without inferring it from a truncated stream.
          const terminalChunk: StreamChunk = run.cancelled
            ? { output: { cancelled: true }, type: "done" }
            : {
                output: { error: error instanceof Error ? error.message : String(error) },
                type: "done",
              }
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          await threadsStore
            .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
            .catch(() => undefined)
        }
      } finally {
        // The client's stream ends here regardless — safeClose below fires on
        // this same tick either way, so cancellation still looks instant to
        // the caller. What differs is when the run SLOT frees.
        if (run.cancelled && sourceCleanup) {
          // The abort stopped us CONSUMING the route, not the route itself:
          // abortableAsyncIterable wins a race against iterator.next(), and a
          // generator suspended at a non-abortable await keeps going until that
          // await settles. Hold the thread's slot until the source has genuinely
          // unwound, or a newly admitted run would interleave checkpoint writes
          // with it. The client's stream still ends immediately (above) —
          // response lifetime and run lifetime are deliberately different here.
          void sourceCleanup.finally(() => run.release())
        } else {
          run.release()
        }
        safeClose(controller)
      }
    },
    cancel() {
      // Intentionally empty — see the disconnect note above the stream.
      // Further enqueues no-op via safeEnqueue, and the fetch wrapper's stream
      // tracking settles the in-flight slot. To actually stop the run, call
      // POST /threads/:id/cancel.
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
  readonly boot: RouteBoot
  readonly checkpointer: BaseCheckpointSaver
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly runRegistry: RunRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly staticModules?: DawnStaticModules
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    request,
    runRegistry,
    sandboxManager,
    signal,
    staticModules,
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
    return statusResponse(mwResult.status, mwResult.body)
  }

  // Idempotently ensure the thread exists
  let thread: Thread | undefined = await threadsStore.getThread(threadId)
  if (!thread) {
    thread = await threadsStore.createThread({ thread_id: threadId })
  }

  // Claim the thread's run slot. Deliberately BEFORE any thread-state
  // mutation below — same reasoning as the stream handler: a rejected
  // request must never clobber the recorded route or status for the run
  // that is genuinely in flight.
  const run = runRegistry.begin(threadId, signal)
  if (!run) {
    return Response.json(
      createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
        code: "run_in_flight",
      }),
      { status: 409 },
    )
  }

  // Record route for potential resume (in-memory fast-path + durable metadata)
  threadRouteMap.set(threadId, routeKey)
  try {
    await threadsStore.updateMetadata(threadId, { route: routeKey })
    await threadsStore.updateStatus(threadId, "busy")
  } catch (error) {
    // Nothing else will ever free this slot — without an explicit release
    // the thread would 409 for the remaining life of the process.
    run.release()
    throw error
  }

  // Shared by both places below that report a cancelled run, so the response
  // body and the status write cannot drift apart.
  //
  // Deliberate asymmetry with the streaming endpoints: an SSE response has
  // already committed to 200 and started sending bytes before cancellation is
  // knowable, so it signals in-band via a done chunk with {cancelled:true}.
  // /runs/wait has not sent anything yet and can still use a status code, so
  // it does — 409 rather than 503, which would conflate cancellation with
  // server shutdown, the exact ambiguity this feature removes.
  const respondCancelled = async (): Promise<Response> => {
    await threadsStore.updateStatus(threadId, "interrupted").catch(() => undefined)
    return Response.json(
      createRequestErrorBody(`Run cancelled for thread "${threadId}"`, {
        code: "run_cancelled",
      }),
      { status: 409 },
    )
  }

  // Set only when the route is abandoned (detached, not stopped) rather than
  // genuinely settled — see the finally below.
  let abandoned = false
  let resultPromise: ReturnType<typeof invokeResolvedRoute> | undefined
  try {
    resultPromise = invokeResolvedRoute({
      appRoot,
      ...boot,
      checkpointer,
      input,
      memoryStore: getMemoryStore,
      ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
      permissionsStore,
      routeFile: route.routeFile,
      routeId: route.routeId,
      ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
      routePath: route.routePath,
      ...(sandboxManager ? { sandboxManager } : {}),
      signal: run.signal,
      ...(staticModules ? { staticModules } : {}),
      threadId,
      threadsStore,
    })

    const result = await raceRequestAgainstShutdown(resultPromise, run.signal)

    if (result === SHUTDOWN_ABORTED) {
      // A cancelled run is not server shutdown: the caller asked to wait for
      // a result that no longer exists because someone cancelled the run —
      // that is a conflict, not a 503.
      if (run.cancelled) {
        // raceRequestAgainstShutdown only detaches resultPromise
        // (`execution.catch(() => undefined)`) — it never stops the route.
        // Unlike /runs/stream there is no abortable iterator here to drive
        // the route's own cleanup, so it may still be executing and writing
        // checkpoints. The slot must stay held until it genuinely settles
        // (see the finally below), or a newly admitted run on this thread
        // would interleave with it.
        abandoned = true
        return await respondCancelled()
      }
      await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
      return Response.json(createRequestErrorBody("Request canceled during server shutdown"), {
        status: 503,
      })
    }

    if (result.status === "failed") {
      // Defensive re-check, not dead code: resultPromise can settle in the
      // same tick the abort fires, so the Promise.race above can resolve to
      // the settled promise rather than the abort — SHUTDOWN_ABORTED is not
      // guaranteed to catch every cancellation. resultPromise has already
      // settled by the time we get here, though, so — unlike the branch
      // above — there is no orphaned work and the slot releases normally.
      if (run.signal.aborted) {
        if (run.cancelled) {
          return await respondCancelled()
        }
        await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
        return Response.json(
          createRequestErrorBody("Request canceled during server shutdown", {
            error: result.error.message,
          }),
          { status: 503 },
        )
      }

      await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)

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

    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
    return Response.json(result.output, { status: 200 })
  } finally {
    if (abandoned && resultPromise) {
      // Hold the slot until the abandoned route genuinely finishes rather
      // than freeing it the instant the 409 is decided (see the comment
      // above). The outcome is discarded — nobody is waiting on it anymore —
      // and any rejection is swallowed so it never surfaces as an unhandled
      // rejection.
      void resultPromise.finally(() => run.release()).catch(() => undefined)
    } else {
      run.release()
    }
  }
}

// ---------------------------------------------------------------------------
// Resume handler — state-based, reads __interrupt__ from SQLite checkpoint
// ---------------------------------------------------------------------------

async function handleResumeRequest(options: {
  readonly appRoot: string
  readonly boot: RouteBoot
  readonly checkpointer: BaseCheckpointSaver
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly runRegistry: RunRegistry
  readonly sandboxManager?: SandboxManager
  readonly signal: AbortSignal
  readonly staticModules?: DawnStaticModules
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    appRoot,
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    request,
    runRegistry,
    sandboxManager,
    signal,
    staticModules,
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
    return statusResponse(mwResult.status, mwResult.body)
  }

  // Claim the thread's run slot. Deliberately BEFORE the busy-status
  // mutation below — same reasoning as the stream handler: a rejected
  // request must never clobber state for the run that is genuinely in
  // flight.
  const run = runRegistry.begin(threadId, signal)
  if (!run) {
    return Response.json(
      createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
        code: "run_in_flight",
      }),
      { status: 409 },
    )
  }

  // Mark thread busy
  try {
    await threadsStore.updateStatus(threadId, "busy")
  } catch (error) {
    // The stream's finally has not been armed yet, so nothing else would ever
    // free this slot — without an explicit release the thread would 409 for the
    // remaining life of the process.
    run.release()
    throw error
  }

  // Open a new SSE stream, passing Command({resume: decision}) as input.
  //
  // As with /runs/stream, a client disconnect deliberately does NOT stop the
  // resumed run — Agent Protocol is the durable surface, and a resumed run is
  // if anything more expensive to discard than a fresh one. Explicit stop is
  // POST /threads/:id/cancel.
  // Rationale: docs/superpowers/specs/2026-08-06-ap-run-cancellation.md
  const encoder = new TextEncoder()
  // See the equivalent comment in handleApStreamRequest: abortableAsyncIterable
  // stops CONSUMING the route on abort, not the route itself, so a route
  // suspended at a non-abortable await keeps running past that point.
  let sourceCleanup: Promise<void> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        try {
          const routeStream = streamResolvedRoute({
            appRoot,
            ...boot,
            checkpointer,
            input: {},
            memoryStore: getMemoryStore,
            resume: decision,
            ...(mwResult.context ? { middlewareContext: mwResult.context } : {}),
            permissionsStore,
            routeFile: route.routeFile,
            routeId: route.routeId,
            ...(registry.manifest ? { routeManifest: registry.manifest } : {}),
            routePath: route.routePath,
            ...(sandboxManager ? { sandboxManager } : {}),
            signal: run.signal,
            ...(staticModules ? { staticModules } : {}),
            threadId,
            threadsStore,
          })
          // Belt-and-braces, mirroring the AG-UI handler: pass the signal to
          // the route *and* wrap the iterator, so a route that ignores its
          // ctx.signal still stops when the run is cancelled. The third
          // argument lets us observe when the route's OWN cleanup finishes,
          // independently of when this loop stops consuming it.
          for await (const chunk of abortableAsyncIterable(routeStream, run.signal, (p) => {
            sourceCleanup = p
          })) {
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          await threadsStore.updateStatus(threadId, "idle")
        } catch (error) {
          // A cancelled run is not a failure: clients must be able to tell the
          // two apart without inferring it from a truncated stream.
          const terminalChunk: StreamChunk = run.cancelled
            ? { output: { cancelled: true }, type: "done" }
            : {
                output: { error: error instanceof Error ? error.message : String(error) },
                type: "done",
              }
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          await threadsStore
            .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
            .catch(() => undefined)
        }
      } finally {
        // The client's stream ends here regardless — response lifetime and run
        // lifetime are deliberately different; see handleApStreamRequest.
        if (run.cancelled && sourceCleanup) {
          void sourceCleanup.finally(() => run.release())
        } else {
          run.release()
        }
        safeClose(controller)
      }
    },
    cancel() {
      // Intentionally empty — see the disconnect note above the stream.
      // Further enqueues no-op via safeEnqueue, and the fetch wrapper's stream
      // tracking settles the in-flight slot. To actually stop the run, call
      // POST /threads/:id/cancel.
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
