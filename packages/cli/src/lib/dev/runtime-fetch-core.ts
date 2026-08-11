import { seedDawnConfig } from "@dawn-ai/core"
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type {
  DawnMiddleware,
  MiddlewareRequest,
  ThreadAccessDeny,
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "@dawn-ai/sdk"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import {
  collectRuntimeCapabilityGaps,
  formatRuntimeCapabilityViolations,
} from "../runtime/edge-capability-report.js"
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
import {
  createPendingResumeClaims,
  type DawnResumeEntry,
  type PendingResumeClaims,
  readPendingInterrupts,
  resolvePendingResume,
} from "./pending-interrupts.js"
import { extractRouteParams } from "./request-context.js"
import { createRunRegistry, type RunRegistry } from "./run-registry.js"
import {
  createRuntimeRegistryFromManifest,
  createStaticRuntimeRegistry,
  type RuntimeRegistry,
} from "./runtime-registry-core.js"
import type { RequestStores, StartRuntimeServerOptions } from "./runtime-server.js"
import {
  createExecutionErrorBody,
  createRequestErrorBody,
  dawnErrorCodeOf,
} from "./server-errors.js"
import { statusResponse } from "./status-response.js"
import {
  normalizeThreadAccessResult,
  threadAccessBootLine,
  validateThreadAccessPolicy,
} from "./thread-access.js"
import { assertNoReservedKey, stripReservedThreadMetadata } from "./thread-metadata.js"

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

/**
 * The same failure `requireBoot` reports, raised at first USE rather than at
 * boot. Reached only when `requestStores` is supplied on a runtime with no
 * filesystem fallback and the factory did not return the store this request
 * needs — the one case where boot cannot decide whether a store is missing.
 *
 * Its own class because `fetch`'s catch-all would otherwise flatten it into a
 * generic 500 with no message: before this seam existed the same
 * misconfiguration rejected `createRuntimeFetchHandler` at boot with the store's
 * name in it, and an operator whose generated `stores.mjs` omits a store must
 * still be told WHICH one.
 */
class MissingStoreError extends Error {
  /** Registry code, read back by `dawnErrorCodeOf`. */
  readonly code = "DAWN_E5301"
  constructor(readonly store: string) {
    super(
      `${store}: no instance provided and this runtime has no filesystem fallback — pass one via options (see the edge deployment docs).`,
    )
    this.name = "MissingStoreError"
  }
}

function requireStore<T>(store: T | undefined, what: string): T {
  if (store) return store
  throw new MissingStoreError(what)
}

/**
 * A resolved thread-access policy that is not a policy. Raised at boot, from
 * here rather than from the loader, because this is the ONE seam all three
 * resolution layers pass through — the disk probe validates on its way out, but
 * an injected `options.threadAccess` and a hand-built `modules.threadAccess`
 * never touch it, and both cross a boundary where the type is erased.
 *
 * A local class, not `CliError`: `../output.js` is node-only and this module is
 * in the `@dawn-ai/cli/fetch` graph. `dawnErrorCodeOf` reads the code back, the
 * same way it does for `MissingStoreError`.
 */
class ThreadAccessPolicyError extends Error {
  readonly code = "DAWN_E3003"
  constructor(source: string, reason: string) {
    super(
      `Thread access policy from ${source} is not a valid policy: ${reason}. ` +
        "Dawn will not boot with a policy it cannot apply, because every thread endpoint would be ungated.",
    )
    this.name = "ThreadAccessPolicyError"
  }
}

function threadAccessSourceLabel(source: {
  readonly fromManifest: boolean
  readonly fromOptions: boolean
}): string {
  if (source.fromOptions) return "the runtime options"
  if (source.fromManifest) return "the build manifest"
  return "src/thread-access.ts"
}

/**
 * A gated feature this app is configured for that this runtime cannot serve —
 * the REQUEST-time half of the `hono` target's build gate, raising the same
 * `DAWN_E1005`.
 *
 * Detected once at boot (`collectRuntimeCapabilityGaps`) and raised from
 * `fetch` rather than rejecting the handler's construction, for two reasons:
 * the emitted `app.mjs` builds its handler inside the first request, so a boot
 * rejection surfaces as an unattributed 500 with no dedupe; and going through
 * `fetch`'s catch-all gives this the identical operator experience as
 * `MissingStoreError` — the cause on stderr exactly once, the code and the
 * docs URL in the body.
 *
 * Raised for EVERY request, health checks included. That is the point: this is
 * a deployment mistake, not a request mistake, and a rollout that keeps passing
 * its health check while silently ignoring the `sandbox` block is the exact
 * failure the spec forbids.
 */
class RuntimeCapabilityError extends Error {
  /** Registry code, read back by `dawnErrorCodeOf`. Same code the build gate throws. */
  readonly code = "DAWN_E1005"
  constructor(message: string) {
    super(message)
    this.name = "RuntimeCapabilityError"
  }
}

/**
 * True for `text/event-stream` with or without parameters (`; charset=utf-8`).
 *
 * Deliberately not an exact compare: this predicate decides whether the
 * response is still producing bytes after `fetch` resolves, and a producer that
 * one day appends a charset would otherwise silently downgrade a live stream to
 * "settled" — releasing sandboxes and disposing per-request stores mid-stream,
 * the exact failure the tracking exists to prevent.
 *
 * Exported for the tests: no route produces a parameterized content-type today,
 * so the guard is only reachable directly.
 */
export function isEventStream(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
}

interface RouteMatcher {
  readonly method: string
  readonly pattern: RegExp
  readonly handle: RouteHandler
}

/**
 * What one request keeps alive: the stores built for it, and the two lifetimes
 * that must BOTH end before those stores may be disposed — the response body,
 * and any run slot the request's route work still holds.
 */
interface RequestLifetime {
  readonly stores: RequestStores
  /** The response, including a streaming body, has fully settled. */
  bodySettled: boolean
  /** Run slots this request claimed that have not been released yet. */
  pendingRuns: number
  /** Body settled AND every run released: nothing more can reference this. */
  settled: boolean
  /**
   * This request's own shutdown signal source, created on first use.
   *
   * Per request rather than per handler because an AbortController is an I/O
   * object on workerd: one created while serving request A throws
   * "Cannot perform I/O on behalf of a different request" the moment request B
   * touches it — and since a worker builds its handler inside the FIRST
   * request (global scope refuses to construct an AbortController at all), a
   * handler-scoped one made every request after the first fail. Dropped in
   * `maybeSettle`, which is what keeps the live set from growing once per
   * request forever.
   */
  shutdownController?: AbortController
}

// ---------------------------------------------------------------------------
// Fetch-handler factory — the transport-agnostic runtime core
// ---------------------------------------------------------------------------

export interface RuntimeFetchHandler {
  readonly fetch: (request: Request) => Promise<Response>
  readonly close: () => Promise<void>
  readonly state: {
    acceptingRequests: boolean
    activeRequests: number
    closed: boolean
  }
  /**
   * @deprecated Vestigial, and kept only because this interface is published
   * API. Nothing in the request path reads it: shutdown is tested through the
   * plain `shutdownReason` value, and the abortable signal every run listens to
   * is minted PER REQUEST by `getShutdownSignal` (a single handler-scoped
   * AbortController cannot work on workerd — it is an I/O object bound to
   * whichever request constructed it). `close()` still aborts this one, but no
   * listener is ever attached, so subscribing to it observes nothing.
   *
   * To be notified of shutdown, await `close()`. Slated for removal in the next
   * major; removing it now would be a breaking change for a published package.
   */
  readonly shutdownController: AbortController
}

/** How long close() waits for in-flight requests before proceeding anyway. */
const CLOSE_DRAIN_DEADLINE_MS = 30_000
const AP_SSE_HEARTBEAT_INTERVAL_MS = 15_000
const AP_SSE_HEARTBEAT = new TextEncoder().encode(": ping\n\n")

export async function createRuntimeFetchHandler(
  options: StartRuntimeServerOptions & {
    /** Internal/test hook: override the close() drain deadline (default 30s). */
    readonly drainDeadlineMs?: number
    /** Internal/test hook: override AP SSE heartbeat interval (default 15s). */
    readonly apSseHeartbeatIntervalMs?: number
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
  // Authorization, unlike middleware, must never resolve to "allow all" by
  // accident: `loadThreadAccess` throws DAWN_E3003 rather than degrading when a
  // policy file exists but cannot be bound. An absent file resolves to
  // undefined — an app that never had a policy keeps today's behavior exactly.
  const threadAccess: ThreadAccessPolicy | undefined =
    options.threadAccess ??
    options.modules?.threadAccess ??
    (await fallbacks?.loadThreadAccess?.(options.appRoot))
  const threadAccessSource = {
    fromManifest: options.modules?.threadAccess !== undefined,
    fromOptions: options.threadAccess !== undefined,
    resolved: threadAccess !== undefined,
  }
  // Validated HERE, not only in the loader, so no layer can bypass the check:
  // the disk probe validates on its way out, but an injected policy and a
  // hand-built manifest entry both arrive with their types erased. Re-running
  // it on the disk value costs one shape check per boot and removes the
  // "which layer validated this?" question entirely.
  if (threadAccess !== undefined) {
    const reason = validateThreadAccessPolicy(threadAccess)
    if (reason)
      throw new ThreadAccessPolicyError(threadAccessSourceLabel(threadAccessSource), reason)
  }
  // One line per boot, and the only signal an operator has that a policy
  // vanished. Emitted AFTER resolution and validation, so any DAWN_E3003
  // pre-empts it: a boot that failed never claims to have bound anything.
  console.log(threadAccessBootLine(threadAccessSource))
  // `requestStores` makes the boot resolution below OPTIONAL, but only on a
  // runtime that has no filesystem to fall back to. Every node caller keeps
  // resolving exactly as before (it has `fallbacks`); an edge caller that
  // supplies stores per request would otherwise throw at boot, before its
  // factory ever ran. Anything neither layer supplies still fails loudly, just
  // at first use — see `requireStore`.
  const bootStoresOptional = Boolean(options.requestStores) && !fallbacks
  const threadsStore =
    options.threadsStore ??
    (bootStoresOptional
      ? undefined
      : await requireBoot(fallbacks, "threadsStore").resolveThreadsStore(options.appRoot))
  const checkpointer =
    options.checkpointer ??
    (bootStoresOptional
      ? undefined
      : await requireBoot(fallbacks, "checkpointer").resolveCheckpointer(options.appRoot))
  // Degrades rather than throws HERE: sandboxing is opt-in, so no fallbacks
  // means no sandbox provider — the same result as an app with no `sandbox`
  // config, and the right answer for every node app. What was missing is the
  // other half: a runtime with no fallbacks that IS configured for a sandbox
  // was degrading silently too. `capabilityGaps` below draws that line.
  const sandboxManager =
    options.sandboxManager ?? (await fallbacks?.resolveSandboxManager(options.appRoot))

  // The request-time half of `assertEdgeCapabilities`. One pass at boot, raised
  // per request (see RuntimeCapabilityError). `hasFilesystemFallback` is what
  // keeps this off every node path: `runtime-fetch-handler.ts` applies
  // `nodeBootFallbacks` unconditionally, so `fallbacks` is always set there and
  // the collector returns empty before reading a single config key.
  const capabilityGaps = collectRuntimeCapabilityGaps({
    config: options.config,
    hasFilesystemFallback: Boolean(fallbacks),
    hasSandboxManager: Boolean(sandboxManager),
    routes: options.modules?.routes ?? [],
  })
  const capabilityError =
    capabilityGaps.length > 0
      ? new RuntimeCapabilityError(formatRuntimeCapabilityViolations(capabilityGaps))
      : undefined
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
    // `requireStore`, not `requireBoot`: memoryStore is the one slot with no
    // `requireStore` call site of its own, and it is reachable on a deployed
    // worker — the `/memory/candidates*` routes are registered unconditionally.
    // A plain Error here carries no `.code`, so `fetch`'s catch-all flattened
    // the documented DAWN_E5301 into an anonymous 500; the edge docs and
    // `edge-capabilities.ts` both promise the code, so raise the error that
    // actually has it.
    memoryStorePromise ??= options.memoryStore
      ? options.memoryStore()
      : (requireStore(fallbacks, "memoryStore").resolveMemoryStore(
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
  const permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>) | undefined =
    options.permissionsStore ??
    (bootStoresOptional
      ? undefined
      : options.permissionsMode === "boot"
        ? await resolvePermissions()
        : resolvePermissions)

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
  // Shutdown is represented twice, and the split is the whole fix for workerd.
  //
  //  • `shutdownReason` is a PLAIN VALUE. Every "are we shutting down?" test
  //    reads this, so no request has to touch an AbortSignal that belongs to
  //    another request's I/O context;
  //  • the signal itself is minted PER REQUEST by `getShutdownSignal` below and
  //    registered here, so `close()` can still abort all of them at once.
  //
  // `shutdownController` survives only as the handler's public handle (nothing
  // in the request path reads it any more). It stays because it is part of the
  // exported RuntimeFetchHandler shape; on workerd it is constructed inside the
  // first request and then never touched again, which is harmless.
  const shutdownController = new AbortController()
  let shutdownReason: Error | undefined
  /** Per-request shutdown sources that may still have listeners attached. */
  const liveShutdownControllers = new Set<AbortController>()

  // Process-local in-flight run tracking: enables the concurrency gate, the
  // per-run abort signal, and POST /threads/:id/cancel. Scoped to this handler
  // (not module-level) so multiple handler instances in one process — which the
  // (Request) => Response core exists to allow — stay isolated.
  //
  // Lives out here rather than inside buildRouteTable because close() drains on
  // it: a run whose HTTP response has already been sent can still be executing
  // (a cancelled stream, or an abandoned wait), and that work must finish before
  // sandboxes are released.
  const runRegistry = createRunRegistry()
  const resumeClaims = createPendingResumeClaims()

  // Request-scoped store overrides. Keyed on the Request object rather than
  // carried in AsyncLocalStorage, which would require nodejs_compat on workerd
  // — the whole point of PR2a was that the bundle needs no such flag. Every
  // route handler already receives its own `request`, so a WeakMap lookup is
  // all the scoping this needs, and entries collect with the Request.
  const perRequest = new WeakMap<Request, RequestLifetime>()

  // Disposals that have started but not finished. close() drains on these as
  // well, so "close() returned" genuinely implies "every per-request pool is
  // closed" — an edge host awaiting shutdown has no other signal.
  const pendingDisposals = new Set<Promise<void>>()

  // Store names already reported by the fail-loud path below, so one
  // misconfiguration logs once rather than once per request.
  const loggedMissingStores = new Set<string>()
  // …and the same for everything else that reaches the catch-all. Keyed by the
  // message so a repeated misconfiguration logs once, while a genuinely new
  // failure still gets a line.
  const loggedFailures = new Set<string>()

  /**
   * Dispose a request's stores once — and only once BOTH of its lifetimes have
   * ended.
   *
   * Response lifetime is not run lifetime. Three paths keep executing after the
   * response body settles: an aborted AG-UI stream (whose route unwinds behind
   * `sourceCleanup`), an abandoned `/runs/wait` (whose 409 is sent while
   * `invokeResolvedRoute` runs on), and a cancelled AP stream. All three keep
   * writing checkpoints through the very stores this would tear down. `close()`
   * already draws exactly this distinction by draining on the run registry as
   * well as on activeRequests; disposal adopts the same rule.
   */
  const maybeSettle = (lifetime: RequestLifetime): void => {
    if (lifetime.settled || !lifetime.bodySettled || lifetime.pendingRuns > 0) return
    lifetime.settled = true
    // Both halves fire under the SAME condition, and that is deliberate: the
    // request's shutdown signal must stay abortable for exactly as long as its
    // stores must stay open — until the body has settled and every run it
    // started has released. Dropping it earlier would leave a detached run that
    // `close()` can no longer stop, so the drain would sit on it until the
    // deadline instead of unwinding promptly.
    if (lifetime.shutdownController) liveShutdownControllers.delete(lifetime.shutdownController)
    const dispose = lifetime.stores.dispose
    if (!dispose) return
    const running = (async () => {
      try {
        await dispose()
      } catch {
        // Teardown must never turn a served response into a failure.
      }
    })()
    pendingDisposals.add(running)
    void running.finally(() => pendingDisposals.delete(running))
  }

  const settleBody = (lifetime: RequestLifetime | undefined): void => {
    if (!lifetime) return
    lifetime.bodySettled = true
    maybeSettle(lifetime)
  }

  /**
   * This request's shutdown signal — the one to hand `runRegistry.begin`.
   *
   * Memoized on the lifetime so a request that starts several runs composes
   * them all off one controller, exactly as the single handler-scoped
   * controller used to. Already-aborted when the handler is closing, which is
   * what `begin` checks synchronously, so a request that slips past the
   * `acceptingRequests` gate still gets a dead run rather than a live one.
   *
   * A request with no lifetime cannot happen from `fetch` (one is always
   * installed before dispatch); the fallback keeps this total for any caller
   * that reaches a route table by another path.
   */
  const getShutdownSignal = (request: Request): AbortSignal => {
    const lifetime = perRequest.get(request)
    if (!lifetime) {
      const orphan = new AbortController()
      if (shutdownReason) orphan.abort(shutdownReason)
      return orphan.signal
    }
    let controller = lifetime.shutdownController
    if (!controller) {
      controller = new AbortController()
      lifetime.shutdownController = controller
      if (shutdownReason) controller.abort(shutdownReason)
      else if (!lifetime.settled) liveShutdownControllers.add(controller)
    }
    return controller.signal
  }

  /**
   * The run registry a request's route work claims its slot from.
   *
   * The wrapper counts the slots THIS request holds, so `maybeSettle` can wait
   * for route work that outlives the response before it disposes the request's
   * stores or drops its shutdown signal.
   *
   * It wraps for every request, not only for requests with stores to dispose:
   * the shutdown-signal half applies to node callers too, and the counting is
   * transparent — same handle, same idempotent release, same `activeCount`,
   * `cancel` and `has` straight through to the shared registry.
   */
  const getRunRegistry = (request: Request): RunRegistry => {
    const lifetime = perRequest.get(request)
    if (!lifetime) return runRegistry
    return {
      activeCount: () => runRegistry.activeCount(),
      begin: (threadId, shutdownSignal) => {
        const handle = runRegistry.begin(threadId, shutdownSignal)
        if (!handle) return undefined
        lifetime.pendingRuns++
        let released = false
        return {
          get cancelled() {
            return handle.cancelled
          },
          release: () => {
            handle.release()
            // Idempotent, exactly like the handle it wraps: callers release
            // from a finally that a cleanup path may reach twice.
            if (released) return
            released = true
            lifetime.pendingRuns--
            maybeSettle(lifetime)
          },
          signal: handle.signal,
        }
      },
      cancel: (threadId, reason) =>
        reason === undefined ? runRegistry.cancel(threadId) : runRegistry.cancel(threadId, reason),
      claim: (threadId) => runRegistry.claim(threadId),
      has: (threadId) => runRegistry.has(threadId),
    }
  }

  const getCheckpointer = (request: Request): BaseCheckpointSaver =>
    requireStore(perRequest.get(request)?.stores.checkpointer ?? checkpointer, "checkpointer")
  const getThreadsStore = (request: Request): ThreadsStore =>
    requireStore(perRequest.get(request)?.stores.threadsStore ?? threadsStore, "threadsStore")
  const getPermissionsStore = (
    request: Request,
  ): PermissionsStore | (() => Promise<PermissionsStore>) =>
    requireStore(
      perRequest.get(request)?.stores.permissionsStore ?? permissionsStore,
      "permissionsStore",
    )
  const getMemoryStoreFor = (request: Request): Promise<MemoryStore> => {
    const override = perRequest.get(request)?.stores.memoryStore
    // Only the boot path memoizes: a per-request store must not outlive its
    // request, and re-memoizing it would reintroduce the dead-context hang.
    return override ? Promise.resolve(override) : getMemoryStore()
  }

  const apSseHeartbeatIntervalMs = options.apSseHeartbeatIntervalMs ?? AP_SSE_HEARTBEAT_INTERVAL_MS
  const routes = buildRouteTable({
    appRoot: options.appRoot,
    apSseHeartbeatIntervalMs,
    boot,
    getCheckpointer,
    getMemoryStoreFor,
    getPermissionsStore,
    getRunRegistry,
    getThreadsStore,
    middleware,
    registry,
    resumeClaims,
    threadAccess,
    ...(sandboxManager ? { sandboxManager } : {}),
    getShutdownSignal,
    // Boot manifest → route execution derives the subagents descriptor maps
    // from it with zero entry-file imports.
    ...(options.modules ? { staticModules: options.modules } : {}),
  })

  const fetch = async (request: Request): Promise<Response> => {
    if (!state.acceptingRequests) {
      return Response.json(createRequestErrorBody("Server is shutting down"), {
        status: 503,
      })
    }

    state.activeRequests++
    let transferredToStream = false
    let lifetime: RequestLifetime | undefined
    try {
      // Before anything else, including store construction: this app asks for a
      // feature this runtime cannot serve, so every request fails identically
      // until the deployment changes. Inside the try so it travels the same
      // catch-all — logged once, coded, with a docs URL.
      if (capabilityError) throw capabilityError
      // Inside the try on purpose: a factory that throws (a pool that cannot
      // connect) must become a 500 through the handler below, not leak the
      // in-flight slot and wedge close()'s drain.
      lifetime = {
        bodySettled: false,
        pendingRuns: 0,
        settled: false,
        // `{}` for a caller with no per-request stores — every field then falls
        // through to the boot-resolved instance exactly as before. Installed
        // UNCONDITIONALLY now because the lifetime also carries this request's
        // shutdown controller, which every caller needs.
        stores: options.requestStores ? await options.requestStores(request) : {},
      }
      perRequest.set(request, lifetime)
      const response = await dispatch(routes, request)
      const body = response.body
      if (body && isEventStream(response.headers.get("content-type"))) {
        // The Response exists but its SSE body is still streaming. Hold the
        // in-flight slot until the stream settles (fully read, canceled, or
        // errored) so close() cannot release sandboxes mid-stream. The flag
        // flips only after the tracked Response has been constructed — if
        // construction throws, the finally below must still decrement.
        // Disposal chains onto the SAME settle hook, never onto `fetch`
        // resolving: an SSE turn is still streaming at that point, and ending
        // a pool mid-stream breaks the tail of every streaming turn. Settling
        // the body only ARMS disposal — see maybeSettle for the run half.
        const tracked = new Response(
          trackStreamSettled(body, () => {
            state.activeRequests--
            settleBody(lifetime)
          }),
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
      if (shutdownReason) {
        return Response.json(
          createRequestErrorBody("Request canceled during server shutdown", {
            error: error instanceof Error ? error.message : String(error),
          }),
          { status: 503 },
        )
      }

      if (error instanceof RuntimeCapabilityError) {
        // Same posture as MissingStoreError below: a deployment mistake, so the
        // full report goes to the caller AND to stderr — but only once, however
        // many requests hit it. Unlike a store, the report already names every
        // feature and its config key, so there are no extra details to attach.
        if (!loggedFailures.has(error.message)) {
          loggedFailures.add(error.message)
          console.error(`Dawn runtime misconfigured — ${error.message}`)
        }
        return Response.json(
          createExecutionErrorBody(error.message, undefined, { code: error.code }),
          { status: 500 },
        )
      }

      if (error instanceof MissingStoreError) {
        // A misconfiguration, not a request failure: every request will fail
        // the same way until the deployment supplies the store. The generic
        // 500 below would name neither the store nor the cause, so this one
        // carries the message and logs it — once per store, so a busy edge
        // host is not flooded with the same line.
        if (!loggedMissingStores.has(error.store)) {
          loggedMissingStores.add(error.store)
          console.error(`Dawn runtime misconfigured — ${error.message}`)
        }
        return Response.json(
          createExecutionErrorBody(error.message, { store: error.store }, { code: error.code }),
          { status: 500 },
        )
      }

      // Everything else. The BODY stays deliberately opaque — it is served to
      // whoever made the request, and an internal message is not theirs to
      // read — but the operator gets the real cause on stderr. Without this
      // line the three failures most likely to greet an edge deploy
      // (`DATABASE_URL` unset, no Workers env bound to the Request, a store the
      // generated `stores.mjs` omits) were a bare "Unexpected runtime server
      // failure" with nothing anywhere saying why. Deduped by message, for the
      // same reason the MissingStoreError branch above dedupes by store: a
      // misconfiguration fails every request identically.
      const code = dawnErrorCodeOf(error)
      const cause = error instanceof Error ? error.message : String(error)
      if (!loggedFailures.has(cause)) {
        loggedFailures.add(cause)
        console.error(
          `Dawn runtime failure — ${cause}${code ? ` (${code})` : ""}`,
          error instanceof Error && error.stack ? `\n${error.stack}` : "",
        )
      }
      return Response.json(
        createExecutionErrorBody(
          "Unexpected runtime server failure",
          undefined,
          code ? { code } : undefined,
        ),
        { status: 500 },
      )
    } finally {
      if (!transferredToStream) {
        state.activeRequests--
        settleBody(lifetime)
      }
    }
  }

  const close = async (): Promise<void> => {
    if (state.closed) {
      return
    }

    state.acceptingRequests = false
    state.closed = true
    shutdownReason = new Error("Runtime server shutting down")
    // The public handle, plus every request whose work may still be listening.
    // Draining below is unchanged; aborting here is only what makes in-flight
    // runs unwind promptly instead of sitting until the deadline.
    shutdownController.abort(shutdownReason)
    for (const controller of liveShutdownControllers) controller.abort(shutdownReason)
    liveShutdownControllers.clear()

    if (sandboxReaper) clearInterval(sandboxReaper)

    // Drain in-flight work — bounded: an SSE body nobody ever reads (or a
    // leaked in-flight slot) must not wedge shutdown forever.
    //
    // Both counters matter, and neither implies the other. activeRequests
    // tracks HTTP responses still being produced. runRegistry tracks route work
    // that may still be executing AFTER its response was sent: a cancelled run
    // whose route ignored ctx.signal, or an abandoned /runs/wait that returned
    // 409 while invokeResolvedRoute kept going. Those return plain JSON, so the
    // fetch wrapper (which only holds the slot for text/event-stream bodies)
    // has already decremented — draining on activeRequests alone would release
    // sandboxes out from under work still using them.
    //
    // Per-request store disposals count too: they start only once both of the
    // above have finished for their request, and a caller that awaits close()
    // is entitled to assume the pools are actually shut.
    const drainDeadlineMs = options.drainDeadlineMs ?? CLOSE_DRAIN_DEADLINE_MS
    await new Promise<void>((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        const activeRuns = runRegistry.activeCount()
        if (state.activeRequests === 0 && activeRuns === 0 && pendingDisposals.size === 0) {
          resolve()
          return
        }
        if (Date.now() - startedAt >= drainDeadlineMs) {
          console.warn(
            `close(): ${state.activeRequests} request(s), ` +
              `${pendingDisposals.size} store disposal(s) and ${activeRuns} run(s) still ` +
              `active after ${Math.round(drainDeadlineMs / 1000)}s — proceeding with shutdown`,
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
// Thread access gate
// ---------------------------------------------------------------------------

type GateOk = { readonly ok: true; readonly stamp?: Record<string, unknown> }
type GateDenied = { readonly ok: false; readonly response: Response }
type Gate = GateOk | GateDenied

interface GateSpec {
  readonly action: ThreadAction
  readonly operation: ThreadOperation
  readonly threadId?: string
  readonly thread?: Thread
  readonly requestedMetadata?: Record<string, unknown>
  /** The response a denied READ must be indistinguishable from. Supply it whenever action is "read". */
  readonly notFound?: () => Response
}

/** Allocated once: every no-op gate and every stamp-less allow returns this. */
const GATE_OK: Gate = { ok: true }

/**
 * A stamp is honored on `create` ONLY. Carrying one on any other allow is a
 * policy-authoring mistake rather than a request failure, so it is reported
 * once per process rather than once per request — unlike the malformed-return
 * warn, which is a bug that should stay noisy.
 */
let warnedIgnoredStamp = false

/**
 * Narrowing rather than a boolean, so the `await` branch typechecks. Nothing in
 * `packages/cli/src` had one before this.
 */
function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Split the stored metadata: `access` is the server stamp, `metadata` is
 * everything else. A policy therefore never sees the reserved key inside
 * `metadata` and is never tempted to authorize against the untrusted sibling.
 *
 * Own properties only, both ways. The reserved key is read with `hasOwn` rather
 * than off the object, and each survivor is DEFINED rather than assigned: the
 * stored metadata is client-authored JSON, so it can carry `__proto__` as an
 * own data property, and `copy[key] = value` for that key runs the inherited
 * setter and swaps the copy's prototype instead of adding a property. Either
 * shortcut would let a forged stamp resolve through the chain on an object that
 * reports it stripped.
 */
function toThreadSubject(thread: Thread): ThreadSubject {
  const reserved = Object.hasOwn(thread.metadata, THREAD_ACCESS_METADATA_KEY)
    ? thread.metadata[THREAD_ACCESS_METADATA_KEY]
    : undefined
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(thread.metadata)) {
    if (key === THREAD_ACCESS_METADATA_KEY) continue
    Object.defineProperty(metadata, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return {
    access: isPlainRecord(reserved) ? reserved : undefined,
    created_at: thread.created_at,
    metadata,
    status: thread.status,
    thread_id: thread.thread_id,
    updated_at: thread.updated_at,
  }
}

/**
 * Every deny becomes bytes here.
 *
 * `{ code: … }` is the SECOND positional argument — `details`, not `options` —
 * so it lands at `error.details.code` with no `error.code` / `docsUrl`, exactly
 * as `run_in_flight` and `thread_not_found` do. Deliberately no registry code
 * on the deny path: `DAWN_E3003` is for load failures, and a docs URL on a 403
 * is noise.
 *
 * Every branch supplies a literal body, and the guard is on
 * `result.body !== undefined` rather than on key presence, because
 * `Response.json(undefined)` throws and `statusResponse` would turn that into a
 * 500. A deny must never be able to 500.
 */
function denyResponse(
  action: ThreadAction,
  result: ThreadAccessDeny,
  notFound: (() => Response) | undefined,
): Response {
  const status = result.status ?? (action === "read" ? 404 : 403)
  if (result.body !== undefined) return statusResponse(status, result.body)
  if (status === 404 && notFound) return notFound()
  if (status === 404) {
    return Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
  }
  return Response.json(createRequestErrorBody("Forbidden", { code: "thread_access_denied" }), {
    status: 403,
  })
}

/**
 * Build this request's gate.
 *
 * Returns a no-op gate when the app has no policy — the ONLY thing a hook-less
 * app pays is this closure allocation. No store read, no reordering, nothing.
 *
 * `Gate | Promise<Gate>`, never `Promise<Gate>`: a policy handler that returns a
 * plain object (the header-only case) is resolved with ZERO microtask
 * boundaries, which is what keeps the `/cancel` claim binding meaningful.
 * Callers do `const settled = isThenable(g) ? await g : g`.
 */
function makeThreadGate(
  policy: ThreadAccessPolicy | undefined,
  request: Request,
): (spec: GateSpec) => Gate | Promise<Gate> {
  if (!policy) return () => GATE_OK
  const headers = headersToRecord(request.headers)
  const method = request.method
  const parsed = new URL(request.url)
  const url = `${parsed.pathname}${parsed.search}`
  return (spec) => {
    const handler = policy[spec.action] ?? policy.fallback
    const accessRequest: ThreadAccessRequest = {
      action: spec.action,
      headers,
      method,
      operation: spec.operation,
      requestedMetadata: spec.requestedMetadata,
      thread: spec.thread ? toThreadSubject(spec.thread) : undefined,
      threadId: spec.threadId,
      url,
    }
    const settle = (value: unknown): Gate => {
      const result = normalizeThreadAccessResult(value, spec.operation, spec.threadId)
      if (result.decision === "allow") {
        if (!result.stamp) return GATE_OK
        if (spec.action === "create") return { ok: true, stamp: result.stamp }
        // Dropped, not merged: the stamp is the server's answer to "who created
        // this thread", and honoring it here would let any later allow rewrite
        // it through the store's shallow merge.
        if (!warnedIgnoredStamp) {
          warnedIgnoredStamp = true
          console.warn(
            `Dawn thread access: the policy returned a stamp on a ${spec.action} allow ` +
              `(${spec.operation}). Stamps are honored on create only, so it was ignored. ` +
              "This warning is emitted once per process.",
          )
        }
        return GATE_OK
      }
      return { ok: false, response: denyResponse(spec.action, result, spec.notFound) }
    }
    const returned = handler(accessRequest) as unknown
    return isThenable(returned) ? returned.then(settle) : settle(returned)
  }
}

// ---------------------------------------------------------------------------
// Route table builder
// ---------------------------------------------------------------------------

/**
 * The store bindings arrive as request-aware ACCESSORS rather than instances:
 * a request may carry its own stores (see `requestStores`), and a handler is
 * the first place that knows which request it is serving. Each handler resolves
 * them once, up front, and hands the resolved values to the sub-handlers below
 * — whose signatures are unchanged.
 */
function buildRouteTable(ctx: {
  readonly appRoot: string
  readonly apSseHeartbeatIntervalMs: number
  readonly boot: RouteBoot
  readonly getCheckpointer: (request: Request) => BaseCheckpointSaver
  readonly getMemoryStoreFor: (request: Request) => Promise<MemoryStore>
  readonly getPermissionsStore: (
    request: Request,
  ) => PermissionsStore | (() => Promise<PermissionsStore>)
  /**
   * Also request-aware, and for the same reason: a request whose stores are
   * disposed on completion must know when the run it started actually ends,
   * which is not when its response does.
   */
  readonly getRunRegistry: (request: Request) => RunRegistry
  readonly getThreadsStore: (request: Request) => ThreadsStore
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  /**
   * The boot-resolved policy. `buildRouteTable` runs before any request exists,
   * so the gate itself is built per handler invocation from this.
   */
  readonly threadAccess: ThreadAccessPolicy | undefined
  readonly resumeClaims: PendingResumeClaims
  readonly sandboxManager?: SandboxManager
  /**
   * This request's shutdown signal, minted per request rather than shared.
   *
   * A single handler-scoped AbortSignal cannot work here: on workerd it is an
   * I/O object bound to whichever request constructed it, so every later
   * request throws on touching it. Route handlers call this with their own
   * `request` and forward the result exactly as they forwarded the old one.
   */
  readonly getShutdownSignal: (request: Request) => AbortSignal
  readonly staticModules?: DawnStaticModules
}): RouteMatcher[] {
  const {
    appRoot,
    apSseHeartbeatIntervalMs,
    boot,
    getCheckpointer,
    getMemoryStoreFor,
    getPermissionsStore,
    getRunRegistry,
    getThreadsStore,
    middleware,
    registry,
    threadAccess,
    getShutdownSignal,
    resumeClaims,
    sandboxManager,
    staticModules,
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
        // Unconditional, hook or no hook: the reserved key is Dawn's, contains
        // a colon (so it cannot be written as a JS property identifier), and
        // stripping it always means an app that adopts a policy later can never
        // inherit a stamp a client forged before it did.
        const clientMetadata = stripReservedThreadMetadata(metadata)
        const thread = await getThreadsStore(request).createThread(
          clientMetadata !== undefined ? { metadata: clientMetadata } : {},
        )
        return Response.json(thread, { status: 200 })
      },
      method: "POST",
      pattern: /^\/threads(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id — fetch a thread
    // ------------------------------------------------------------------
    {
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        // The gate runs AFTER the lookup and a denial routes through this same
        // literal, so "404 means the row does not exist" stays true for a
        // policied app — agui-endpoint.test.ts pins that invariant.
        const thread = await getThreadsStore(request).getThread(threadId)
        const notFound = () =>
          Response.json(createRequestErrorBody("Thread not found"), { status: 404 })
        const gate = makeThreadGate(threadAccess, request)
        const g = gate({
          action: "read",
          notFound,
          operation: "thread.get",
          threadId,
          ...(thread ? { thread } : {}),
        })
        const settled = isThenable(g) ? await g : g
        if (!settled.ok) return settled.response
        if (!thread) return notFound()
        return Response.json(thread, { status: 200 })
      },
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // DELETE /threads/:thread_id — delete thread + checkpoints
    // ------------------------------------------------------------------
    {
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        if (threadAccess) {
          // First in the handler, and a `getThread` this endpoint does not do
          // today — hook path only. The gate authorizes with `thread:
          // undefined` when the row is missing rather than short-circuiting to
          // 204, so "not yours" and "never existed" answer identically and the
          // existence oracle a 403 would otherwise open stays shut.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "delete",
            operation: "thread.delete",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        const checkpointer = getCheckpointer(request)
        await getThreadsStore(request).deleteThread(threadId)
        // Best-effort: delete checkpoints if the saver supports it.
        if (
          typeof (checkpointer as unknown as { deleteThread?: unknown }).deleteThread === "function"
        ) {
          await (
            checkpointer as unknown as {
              deleteThread(id: string): Promise<void>
            }
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
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        // Synchronous, FIRST statement, nothing awaited before it: the claim
        // binds to the run the caller observed, so anything that runs after it
        // (in a later slice, an awaited authorization check) can no longer make
        // the cancel land on run N+1. `cancel(threadId)` resolved the entry at
        // call time, which is why that ordering used to be load-bearing.
        //
        // Known, accepted race: a cancel arriving between the route finishing
        // and its idle-status write completing still finds the slot and reports
        // "interrupted" for a run that actually completed. The window is a
        // single DB write wide and corrupts nothing — the streaming client has
        // already received the real output.
        const claim = getRunRegistry(request).claim(threadId)
        if (threadAccess) {
          // Safe to await only because the claim is already bound. The two are
          // load-bearing together: without the claim this read would let the
          // cancel land on run N+1.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "update",
            operation: "thread.cancel",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        // A stale claim falls through to the existing 409: "the run you
        // observed already finished" is the honest answer, where cancelling
        // through the registry by thread id would silently kill a run the
        // caller never saw.
        if (claim?.cancel()) {
          return Response.json({ status: "interrupted", thread_id: threadId }, { status: 200 })
        }
        const thread = await getThreadsStore(request).getThread(threadId)
        if (!thread) {
          return Response.json(
            createRequestErrorBody("Thread not found", {
              code: "thread_not_found",
            }),
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
          apSseHeartbeatIntervalMs,
          boot,
          checkpointer: getCheckpointer(request),
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          request,
          ...(sandboxManager ? { sandboxManager } : {}),
          runRegistry: getRunRegistry(request),
          signal: getShutdownSignal(request),
          ...(staticModules ? { staticModules } : {}),
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
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
          checkpointer: getCheckpointer(request),
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          resumeClaims,
          runRegistry: getRunRegistry(request),
          threadsStore: getThreadsStore(request),
          ...(sandboxManager ? { sandboxManager } : {}),
          signal: getShutdownSignal(request),
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
      handle: async (request) =>
        handleMemoryListRequest({
          memoryStore: await getMemoryStoreFor(request),
        }),
      method: "GET",
      pattern: /^\/memory\/candidates(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/approve — approve with reconciliation
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleMemoryApproveRequest({
          appRoot,
          ...(boot.bootFallbacks
            ? { resolveIdentityKeys: boot.bootFallbacks.resolveIdentityKeys }
            : {}),
          id: params.id ?? "",
          memoryStore: await getMemoryStoreFor(request),
        }),
      method: "POST",
      pattern: /^\/memory\/candidates\/(?<id>[^/?#]+)\/approve(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // POST /memory/candidates/:id/reject — delete the record
    // ------------------------------------------------------------------
    {
      handle: async (request, params) =>
        handleMemoryRejectRequest({
          id: params.id ?? "",
          memoryStore: await getMemoryStoreFor(request),
        }),
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
          checkpointer: getCheckpointer(request),
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          request,
          runRegistry: getRunRegistry(request),
          ...(sandboxManager ? { sandboxManager } : {}),
          signal: getShutdownSignal(request),
          ...(staticModules ? { staticModules } : {}),
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/,
    },

    // ------------------------------------------------------------------
    // GET /threads/:thread_id/state — latest checkpoint state
    // ------------------------------------------------------------------
    {
      handle: async (request, params) => {
        const threadId = params.thread_id ?? ""
        const notFound = () =>
          Response.json(createRequestErrorBody("No checkpoint found for thread"), { status: 404 })
        if (threadAccess) {
          // The one extra store read this endpoint pays, and only with a policy
          // installed. The checkpointer is a SEPARATE store from ThreadsStore,
          // so a transcript can exist for a thread whose row is gone — the gate
          // therefore runs with `thread: undefined` rather than skipping.
          const thread = await getThreadsStore(request).getThread(threadId)
          const gate = makeThreadGate(threadAccess, request)
          const g = gate({
            action: "read",
            notFound,
            operation: "thread.state",
            threadId,
            ...(thread ? { thread } : {}),
          })
          const settled = isThenable(g) ? await g : g
          if (!settled.ok) return settled.response
        }
        const tuple = await getCheckpointer(request).getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        })
        if (!tuple) return notFound()
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
          apSseHeartbeatIntervalMs,
          boot,
          checkpointer: getCheckpointer(request),
          getMemoryStore: () => getMemoryStoreFor(request),
          middleware,
          permissionsStore: getPermissionsStore(request),
          registry,
          resumeClaims,
          request,
          runRegistry: getRunRegistry(request),
          ...(sandboxManager ? { sandboxManager } : {}),
          signal: getShutdownSignal(request),
          ...(staticModules ? { staticModules } : {}),
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/resume(?:\?.*)?$/,
    },
  ]
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(routes: RouteMatcher[], request: Request): Promise<Response> {
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
  readonly apSseHeartbeatIntervalMs: number
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
    apSseHeartbeatIntervalMs,
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
    return Response.json(createRequestErrorBody("Malformed request body"), {
      status: 400,
    })
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    return Response.json(createRequestErrorBody(validated.message), {
      status: 400,
    })
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), {
      status: 404,
    })
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
    const routePatch = { route: routeKey }
    // The stamp lives in the same flat metadata object and this merge is
    // shallow, so a future patch that carried the reserved key would silently
    // overwrite it. Assertion, not a gate: reaching it is a Dawn bug.
    assertNoReservedKey(routePatch)
    await threadsStore.updateMetadata(threadId, routePatch)
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
      const stopHeartbeat = startSseHeartbeat(controller, apSseHeartbeatIntervalMs)
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
                output: {
                  error: error instanceof Error ? error.message : String(error),
                },
                type: "done",
              }
          safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
          await threadsStore
            .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
            .catch(() => undefined)
        }
      } finally {
        stopHeartbeat()
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
      "cache-control": "no-cache, no-transform",
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
    return Response.json(createRequestErrorBody("Malformed request body"), {
      status: 400,
    })
  }

  const body = parsedBody.value
  const validated = validateApRunBody(body)
  if (!validated.ok) {
    return Response.json(createRequestErrorBody(validated.message), {
      status: 400,
    })
  }

  const { input, routeKey } = validated

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), {
      status: 404,
    })
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
    const routePatch = { route: routeKey }
    // The stamp lives in the same flat metadata object and this merge is
    // shallow, so a future patch that carried the reserved key would silently
    // overwrite it. Assertion, not a gate: reaching it is a Dawn bug.
    assertNoReservedKey(routePatch)
    await threadsStore.updateMetadata(threadId, routePatch)
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
  readonly apSseHeartbeatIntervalMs: number
  readonly boot: RouteBoot
  readonly checkpointer: BaseCheckpointSaver
  readonly getMemoryStore: () => Promise<MemoryStore>
  readonly middleware: DawnMiddleware | undefined
  readonly permissionsStore: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly resumeClaims: PendingResumeClaims
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
    apSseHeartbeatIntervalMs,
    boot,
    checkpointer,
    getMemoryStore,
    middleware,
    permissionsStore,
    registry,
    resumeClaims,
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
  if (!parsedBody.ok || !isDawnResumeBody(parsedBody.value)) {
    return Response.json(createRequestErrorBody("Malformed resume request body"), { status: 400 })
  }

  const body = parsedBody.value
  const releaseResumeClaim = resumeClaims.tryClaim(threadId)
  if (!releaseResumeClaim) {
    return Response.json(
      createRequestErrorBody("A resume is already in progress for this thread", {
        code: "resume_in_progress",
      }),
      { status: 409 },
    )
  }

  let claimTransferredToStream = false
  try {
    const pendingInterrupts = await readPendingInterrupts(checkpointer, threadId)
    if (!pendingInterrupts) {
      return Response.json(
        createRequestErrorBody("Thread not found", {
          code: "thread_not_found",
        }),
        { status: 404 },
      )
    }

    const resumeResolution = resolvePendingResume(body.resume, pendingInterrupts)
    if (!resumeResolution.ok) {
      return Response.json(
        createRequestErrorBody(resumeResolution.message, {
          code: resumeResolution.code,
        }),
        { status: resumeResolution.status },
      )
    }
    if (resumeResolution.mode !== "resume") {
      return Response.json(createRequestErrorBody("Resume entries are required"), { status: 409 })
    }

    // Resolve which route last ran on this thread, in priority order:
    //   1. in-memory map (fast-path, current server session)
    //   2. durable thread metadata (survives a server restart)
    //   3. client-supplied `route` in the resume body (explicit override)
    const persistedRoute = (await threadsStore.getThread(threadId))?.metadata.route
    const routeKey =
      threadRouteMap.get(threadId) ??
      (typeof persistedRoute === "string" ? persistedRoute : undefined) ??
      body.route
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

    // Claim the thread's run slot before mutating its busy status. A rejected
    // request must not clobber state for the run genuinely in flight.
    const run = runRegistry.begin(threadId, signal)
    if (!run) {
      return Response.json(
        createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
          code: "run_in_flight",
        }),
        { status: 409 },
      )
    }

    try {
      await threadsStore.updateStatus(threadId, "busy")
    } catch (error) {
      run.release()
      throw error
    }

    // Agent Protocol is durable: disconnecting the response does not stop the
    // resumed run. Explicit cancellation uses POST /threads/:id/cancel.
    const encoder = new TextEncoder()
    let sourceCleanup: Promise<void> | undefined
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const stopHeartbeat = startSseHeartbeat(controller, apSseHeartbeatIntervalMs)
        try {
          try {
            const routeStream = streamResolvedRoute({
              appRoot,
              ...boot,
              checkpointer,
              input: {},
              memoryStore: getMemoryStore,
              resume: resumeResolution.resume,
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
                  output: {
                    error: error instanceof Error ? error.message : String(error),
                  },
                  type: "done",
                }
            safeEnqueue(controller, encoder.encode(toSseEvent(terminalChunk)))
            await threadsStore
              .updateStatus(threadId, run.cancelled ? "interrupted" : "idle")
              .catch(() => undefined)
          }
        } finally {
          stopHeartbeat()
          // The client's stream ends here regardless — response lifetime and run
          // lifetime are deliberately different; see handleApStreamRequest.
          const releaseExecutionClaims = () => {
            run.release()
            releaseResumeClaim()
          }
          if (run.cancelled && sourceCleanup) {
            void sourceCleanup.finally(releaseExecutionClaims)
          } else {
            releaseExecutionClaims()
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

    claimTransferredToStream = true
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
      status: 200,
    })
  } finally {
    if (!claimTransferredToStream) releaseResumeClaim()
  }
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

function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs: number,
): () => void {
  const heartbeat = setInterval(() => {
    safeEnqueue(controller, AP_SSE_HEARTBEAT.slice())
  }, intervalMs)
  return () => clearInterval(heartbeat)
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

function isDawnResumeBody(
  value: unknown,
): value is { readonly resume: DawnResumeEntry[]; readonly route: string } {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    hasExactKeys(value, ["resume", "route"]) &&
    typeof value.route === "string" &&
    value.route.length > 0 &&
    Array.isArray(value.resume) &&
    value.resume.every(
      (entry) =>
        isRecord(entry) &&
        !Array.isArray(entry) &&
        typeof entry.interruptId === "string" &&
        entry.interruptId.length > 0 &&
        ((entry.status === "resolved" &&
          isPermissionDecision(entry.payload) &&
          hasExactKeys(entry, ["interruptId", "payload", "status"])) ||
          (entry.status === "cancelled" && hasExactKeys(entry, ["interruptId", "status"]))),
    )
  )
}

function isPermissionDecision(value: unknown): value is "always" | "deny" | "once" {
  return value === "always" || value === "deny" || value === "once"
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
