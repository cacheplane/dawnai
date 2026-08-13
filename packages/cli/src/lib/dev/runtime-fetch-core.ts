import { seedDawnConfig } from "@dawn-ai/core"
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, MiddlewareRequest, ThreadAccessPolicy } from "@dawn-ai/sdk"
import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import type { Thread, ThreadStatus, ThreadsStore } from "@dawn-ai/sqlite-storage"
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
import { readParkedInterruptIds, readParkedRoute, settleParkedRoute } from "./parked-route.js"
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
import { terminalStatus } from "./terminal-status.js"
import { threadAccessBootLine, validateThreadAccessPolicy } from "./thread-access.js"
import { isThenable, makeThreadGate } from "./thread-gate.js"
import { assertNoReservedKey, stripReservedThreadMetadata } from "./thread-metadata.js"

// ---------------------------------------------------------------------------
// Route-table types
// ---------------------------------------------------------------------------

export type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response>

/**
 * Boot state threaded verbatim into every route execution: the supplied
 * DawnConfig (so no route re-reads `dawn.config.ts`) and the node filesystem
 * fallback bag (absent on edge runtimes, where every store is injected).
 */
export type RouteBoot = Pick<BootResolvedInstances, "bootFallbacks" | "config">

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

/**
 * The entry point says this build saw a policy file; the manifest beside it
 * carries no thread-access entry at all. Those two artifacts did not come from
 * the same build, and on a runtime with no filesystem the difference is not
 * recoverable — so this fails the boot rather than serving every thread
 * endpoint open while logging that the app has no policy.
 *
 * A local class for the same reason `ThreadAccessPolicyError` is one:
 * `../output.js` is node-only and this module is in the `@dawn-ai/cli/fetch`
 * graph. Same registry code, because from an operator's seat this IS the policy
 * failing to load — it just failed at the build boundary rather than at import.
 */
class StaleThreadAccessManifestError extends Error {
  readonly code = "DAWN_E3003"
  constructor() {
    super(
      "This app was built with a thread access policy, but the static module manifest it " +
        "booted with carries no thread access entry — the manifest is older than the build " +
        "that stamped the policy. Dawn will not boot with every thread endpoint ungated: " +
        "re-run `dawn build` and deploy the whole build output together.",
    )
    this.name = "StaleThreadAccessManifestError"
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

export interface RouteMatcher {
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
  // BEFORE the resolution below, because the resolution cannot tell the
  // difference this catches: a stale manifest resolves to `undefined` exactly
  // like an app that never had a policy. `in`, not truthiness — a key present
  // and bound to undefined is a build that considered the policy and bound
  // nothing, which is a legitimate (if unusual) hand-rolled embed, whereas a
  // key that was never emitted means the manifest predates the policy.
  //
  // Scoped to a manifest boot on purpose: without `modules` the policy comes
  // from the disk probe, which reads the app's CURRENT state and so cannot be
  // stale in this way.
  if (options.threadAccessExpected && options.modules && !("threadAccess" in options.modules)) {
    throw new StaleThreadAccessManifestError()
  }
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
// Create-thread collision detection
//
// The gate itself (`makeThreadGate`, `isThenable`, `GateSpec`) lives in
// `thread-gate.ts`, not here — see that module's header for why.
// ---------------------------------------------------------------------------

/** Structural equality over JSON-shaped values (no Dates, no Maps, no cycles). */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonDeepEqual(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]))
}

/**
 * Did `createThread` actually insert, or did it hand back a row that was
 * already there? Best-effort collision detection, NOT the security boundary —
 * the unconditional `update` recheck beside it is. It is decisive exactly when
 * the policy stamped (an adopted row carries a different stamp, or none) and
 * indecisive in the one case where it does not matter: a `permit()` with no
 * stamp on a create with no metadata has nothing to distinguish and also
 * nothing to authorize against later.
 */
function isRowWeJustWrote(thread: Thread, stored: Record<string, unknown> | undefined): boolean {
  return thread.created_at === thread.updated_at && jsonDeepEqual(thread.metadata, stored ?? {})
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
/**
 * Exported for `test/thread-access-coverage.test.ts`, which walks every entry
 * and requires each to be classified as gated, deferred or exempt. Not part of
 * any package barrel — `fetch-exports.ts` and `runtime-exports.ts` re-export
 * only `createRuntimeFetchHandler`.
 */
export function buildRouteTable(ctx: {
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
        const gate = makeThreadGate(threadAccess, request)
        const created = gate({
          action: "create",
          operation: "thread.create",
          ...(clientMetadata !== undefined ? { requestedMetadata: clientMetadata } : {}),
        })
        const settled = isThenable(created) ? await created : created
        if (!settled.ok) return settled.response

        const stored = settled.stamp
          ? { ...(clientMetadata ?? {}), [THREAD_ACCESS_METADATA_KEY]: settled.stamp }
          : clientMetadata
        const input = stored !== undefined ? { metadata: stored } : {}

        let thread = await getThreadsStore(request).createThread(input)

        // Both of the following are inside the hook branch. A hook-less app
        // makes the one createThread call above and returns, exactly as today.
        if (threadAccess) {
          // The id is server-generated and only 32 bits wide, so the row that
          // came back is not necessarily the row we wrote: Postgres upserts on a
          // collision and returns the existing row with its existing metadata,
          // discarding the caller's. Retry rather than hand back a stranger's
          // thread — a bare re-authorization would be safe but would 403 a
          // create the caller was fully entitled to make.
          for (let attempt = 1; attempt < 3 && !isRowWeJustWrote(thread, stored); attempt++) {
            thread = await getThreadsStore(request).createThread(input)
          }

          // Unconditional: authorize the ROW, not the intent. Never a stamp
          // comparison — when the policy returns permit() with no stamp both
          // sides are undefined, the comparison passes, and the loser proceeds
          // on the winner's row with no re-authorization at all.
          const recheck = gate({
            action: "update",
            operation: "thread.create",
            thread,
            threadId: thread.thread_id,
          })
          const rechecked = isThenable(recheck) ? await recheck : recheck
          if (!rechecked.ok) return rechecked.response
        }

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
        // AFTER the gate, deliberately. A 409 here and a 403 from the gate are
        // distinguishable, so answering the run-in-flight case first would tell
        // an unauthorized caller whether someone else's thread is busy — the
        // activity oracle the 403/404 split exists to keep shut.
        //
        // Refused while a turn is executing, for the same reason a second run
        // is: deleting a thread out from under its own in-flight turn is
        // incoherent whoever asks. The turn keeps running against state that no
        // longer exists, and every write it has left to make — status, metadata,
        // the parked-route gate — targets a row that is gone. Those writes do
        // not fail, they NO-OP (`updateMetadata` returns early on a missing
        // row), so the turn parks durably while its gate records nothing, and
        // the next run to touch the thread recreates the row with its own route.
        // The run registry already owns the "one turn at a time on a thread"
        // invariant, so it is the natural place to answer from, and its slot is
        // held across every settle — including the /runs/wait arms that defer
        // their release until an abandoned route unwinds.
        if (getRunRegistry(request).has(threadId)) {
          return Response.json(
            createRequestErrorBody(`A run is already in flight for thread "${threadId}"`, {
              code: "run_in_flight",
            }),
            { status: 409 },
          )
        }
        const checkpointer = getCheckpointer(request)
        // Checkpoints BEFORE the row, and deliberately not the other way round:
        // the two deletes are not atomic, so one of them has to be the one that
        // can be left undone. Losing the row first would strand a live payload
        // behind a thread the endpoint 404s for — until any run recreates the
        // row and serves it under the new route. Losing the payload first
        // strands nothing: the row still carries the recorded parking route, so
        // whatever remains stays gated exactly as it was, and the caller sees
        // the failure and can retry.
        if (
          typeof (checkpointer as unknown as { deleteThread?: unknown }).deleteThread === "function"
        ) {
          await (
            checkpointer as unknown as {
              deleteThread(id: string): Promise<void>
            }
          ).deleteThread(threadId)
        }
        await getThreadsStore(request).deleteThread(threadId)
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
          threadAccess,
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
          threadAccess,
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
          threadAccess,
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
    // GET /threads/:thread_id/pending_interrupts — durable HITL prompts
    // ------------------------------------------------------------------
    // Not a collision with GET /threads/:thread_id: that pattern's
    // [^/?#]+ capture cannot span a slash.
    {
      handle: async (request, params) =>
        handleApPendingInterruptsRequest({
          checkpointer: getCheckpointer(request),
          middleware,
          registry,
          request,
          threadAccess,
          threadId: params.thread_id ?? "",
          threadRouteMap,
          threadsStore: getThreadsStore(request),
        }),
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/pending_interrupts(?:\?.*)?$/,
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
          threadAccess,
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
  readonly threadAccess: ThreadAccessPolicy | undefined
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
    threadAccess,
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

  // Gated as "update" unconditionally — never "create", even for a thread
  // this call is about to create. See ThreadOperation's `run.stream` doc:
  // the client picks this thread id (unlike POST /threads' server-generated
  // one), so starting a run is authorized the same way whether or not the
  // row exists yet. AFTER the middleware reject above and BEFORE both
  // `createThread` and `runRegistry.begin` below — a denial must create no
  // row and take no run slot.
  if (threadAccess) {
    const gate = makeThreadGate(threadAccess, request)
    const g = gate({
      action: "update",
      operation: "run.stream",
      threadId,
      ...(thread ? { thread } : {}),
    })
    const settled = isThenable(g) ? await g : g
    if (!settled.ok) return settled.response
  }

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

  // Taken from the thread already loaded above, so the turn's own settle call
  // can tell whether a parking route was recorded without a second store
  // round-trip. Only ever consulted to decide whether to CLEAR — see
  // settleParkedRoute for why a value sampled this early is safe there.
  const previousParkedRoute = readParkedRoute(thread)

  // Record which route last ran on this thread so the resume endpoint can
  // re-invoke it without requiring the client to repeat the route key.
  // The in-memory map is fast-path for the current server session; the thread
  // metadata persists it to SQLite so resume survives a server restart.
  //
  // Deliberately NOT the identity GET /pending_interrupts gates on: this is
  // overwritten by any run the caller is allowed to start. See PARKED_ROUTE_KEY.
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
  // A parked turn takes the NORMAL completion path: the adapter yields the
  // interrupt chunk and then `done`, so a drained loop does not mean the turn
  // finished. Without this, a thread waiting on a human reads back as "idle"
  // and a reconnecting client is told the agent is done. Deliberately the
  // handler's own flag, so parked-status honesty depends on nothing outside
  // this request.
  let sawInterrupt = false
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
            if (chunk.type === "interrupt") sawInterrupt = true
            safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
          }
          // Before the status write, and inside the same try, so a failure to
          // tighten the gate on a parked turn surfaces rather than leaving a
          // thread that reads "interrupted" with its prompt gated on whatever
          // route runs next.
          await settleParkedRoute({
            canPark: route.mode === "agent",
            checkpointer,
            parked: sawInterrupt,
            previousParkedRoute,
            routeKey,
            threadId,
            threadsStore,
          })
          // Deliberately not run.cancelled: the loop drained, so the turn
          // finished. A cancel that lost the race against the last chunk does
          // not retroactively interrupt it — the same abort-vs-settle race the
          // /runs/wait re-check documents at length.
          await threadsStore.updateStatus(
            threadId,
            terminalStatus({ cancelled: false, sawInterrupt }),
          )
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
          // A turn that parked before failing is still parked, so the gate has
          // to be recorded here too — including when the failure IS the
          // success-path settle above. Retried, not skipped.
          await settleParkedRoute({
            canPark: route.mode === "agent",
            checkpointer,
            parked: sawInterrupt,
            previousParkedRoute,
            routeKey,
            threadId,
            threadsStore,
          }).catch(() => undefined)
          await threadsStore
            .updateStatus(threadId, terminalStatus({ cancelled: run.cancelled, sawInterrupt }))
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
  readonly threadAccess: ThreadAccessPolicy | undefined
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
    threadAccess,
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

  // Gated as "update" unconditionally, same reasoning as handleApStreamRequest:
  // this endpoint picks the thread id the same way /runs/stream does, so a
  // denial must create no row and take no run slot. AFTER the middleware
  // reject above and BEFORE both `createThread` and `runRegistry.begin` below.
  if (threadAccess) {
    const gate = makeThreadGate(threadAccess, request)
    const g = gate({
      action: "update",
      operation: "run.wait",
      threadId,
      ...(thread ? { thread } : {}),
    })
    const settled = isThenable(g) ? await g : g
    if (!settled.ok) return settled.response
  }

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

  // See handleApStreamRequest: taken from the thread already loaded above.
  const previousParkedRoute = readParkedRoute(thread)

  // Record route for potential resume (in-memory fast-path + durable metadata).
  // Not the identity GET /pending_interrupts gates on — see PARKED_ROUTE_KEY.
  threadRouteMap.set(threadId, routeKey)
  // Unlike the streaming handlers, this one has no chunks to watch: executeAgent
  // drains the adapter's stream and returns only the `done` payload, so both the
  // interrupt chunks and LangGraph's `__interrupt__` key are gone by the time
  // the output lands here. The park is therefore detected by DIFFING the
  // checkpoint's pending-interrupt ids across the turn. It has to be a diff and
  // not just "is anything pending afterwards": interrupts this turn did not
  // park belong to whichever route did, and letting a turn claim them is the
  // same repointing PARKED_ROUTE_KEY exists to prevent.
  //
  // COST, stated plainly: an agent turn through this endpoint pays two extra
  // getTuple calls — this one and its partner below — every time, including on
  // threads that never park. Neither can be made lazy. The "after" read is the
  // only park signal this endpoint has, and the "before" read cannot wait until
  // something looks interesting: by the time the turn has run, its starting
  // state is unobservable. Deferring it on a cheap proxy does not work either —
  // thread STATUS is the obvious one, and it is precisely the signal this
  // endpoint deliberately does not maintain (see the settle call below).
  //
  // Accepted because of what it is measured against: an agent turn is at least
  // one model round-trip and several checkpoint WRITES, so two reads are noise
  // beside it. The routes where a per-request read would actually show up —
  // plain graph, chain, workflow — pay nothing at all, because nothing but an
  // agent route is handed a checkpointer to park into, which also makes their
  // diff known-empty without asking.
  const canPark = route.mode === "agent"
  let interruptIdsBefore: ReadonlySet<string> = new Set()
  try {
    if (canPark) interruptIdsBefore = await readParkedInterruptIds(checkpointer, threadId)
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

  /**
   * Bind this turn's gate to the route that parked, whatever way the turn ended.
   *
   * Every arm has to call it, not just the one that returns output. A turn that
   * parked and was then cancelled is still parked — its `__interrupt__` write is
   * durable and the endpoint will serve it — so an arm that returns without
   * settling leaves `parked_route` unset on a thread's first park, and the
   * endpoint falls through to the `threadRouteMap ?? metadata.route` chain that
   * any allowed run can repoint. "Leaving the recorded value alone
   * over-restricts" is only true once a value is recorded; on the first park
   * there is nothing to leave alone.
   *
   * Always a post-hoc diff, never "is anything pending now": interrupts this
   * turn did not park belong to whichever route did.
   */
  const settleParkedRouteForTurn = async (): Promise<void> => {
    const interruptIdsAfter = canPark
      ? await readParkedInterruptIds(checkpointer, threadId).catch(() => undefined)
      : undefined
    await settleParkedRoute({
      canPark,
      checkpointer,
      parked: interruptIdsAfter
        ? [...interruptIdsAfter].some((id) => !interruptIdsBefore.has(id))
        : false,
      ...(interruptIdsAfter ? { pendingAfter: interruptIdsAfter } : {}),
      previousParkedRoute,
      routeKey,
      threadId,
      threadsStore,
    }).catch(() => undefined)
  }

  // Set only when the route is abandoned (detached, not stopped) rather than
  // genuinely settled — see the finally below.
  let abandoned = false
  // Set when the route is STILL EXECUTING as this handler returns. The settle
  // then cannot happen at return time: the route may not have written its
  // interrupt yet, and reading the checkpoint now would miss a park that lands
  // a moment later. It has to hang off resultPromise instead — see the finally.
  let settleAfterRouteUnwinds = false
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
      // Neither arm below has a settled route: raceRequestAgainstShutdown stops
      // WAITING for resultPromise, it never stops the route. So both defer the
      // gate write until the route genuinely unwinds.
      settleAfterRouteUnwinds = true

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
      // Settled inline, unlike the two arms above: resultPromise has resolved,
      // so the route is done writing and the slot is still held. Once, before
      // the sub-branching, so all three exits below are covered — a turn that
      // parked and THEN failed is still parked.
      await settleParkedRouteForTurn()

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

    // A /runs/wait turn CAN park, and this gate has to know about it even though
    // the spec leaves this endpoint out of the parked-STATUS work below: a park
    // recorded nowhere is a park whose prompt stays gated on the last-run route,
    // which any run the caller is allowed to start can repoint. The status
    // contract below is untouched — a parked /runs/wait turn still reads "idle".
    await settleParkedRouteForTurn()

    // Deliberately unconditional, unlike the streaming handlers' terminalStatus:
    // the spec scopes parked-status honesty to the streaming endpoints, so a
    // /runs/wait turn that parks still reads "idle" here. Clients detect that
    // case via GET /threads/:id/pending_interrupts.
    await threadsStore.updateStatus(threadId, "idle").catch(() => undefined)
    return Response.json(result.output, { status: 200 })
  } finally {
    if (settleAfterRouteUnwinds && resultPromise) {
      // The route outlived this response. Its park — if it parks at all — may
      // land AFTER the 409 was sent, so the gate write chases the route rather
      // than the response: settle once resultPromise has genuinely unwound.
      // `.catch` first so a rejected route still reaches the settle; the
      // outcome itself is discarded, since nobody is waiting on it anymore.
      //
      // Best-effort on the shutdown arm specifically, which (as before this
      // change) frees the slot without waiting: another run could in principle
      // be admitted before this settles. Not tightened here because holding a
      // slot open across shutdown would delay process exit, and the arm that
      // an unauthenticated caller can actually drive — cancel — is the one
      // that keeps its slot.
      void resultPromise
        .catch(() => undefined)
        .then(settleParkedRouteForTurn)
        .catch(() => undefined)
        .finally(() => {
          // Hold the slot until the abandoned route genuinely finishes rather
          // than freeing it the instant the 409 is decided, or a newly admitted
          // run would interleave checkpoint writes with it.
          if (abandoned) run.release()
        })
      if (!abandoned) run.release()
    } else {
      run.release()
    }
  }
}

// ---------------------------------------------------------------------------
// AP pending-interrupts handler — durable HITL prompts for a reconnected client
// ---------------------------------------------------------------------------

async function handleApPendingInterruptsRequest(options: {
  readonly checkpointer: BaseCheckpointSaver
  readonly middleware: DawnMiddleware | undefined
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly threadAccess: ThreadAccessPolicy | undefined
  readonly threadId: string
  readonly threadRouteMap: Map<string, string>
  readonly threadsStore: ThreadsStore
}): Promise<Response> {
  const {
    checkpointer,
    middleware,
    registry,
    request,
    threadAccess,
    threadId,
    threadRouteMap,
    threadsStore,
  } = options

  // Thread first, with the same code POST /cancel and POST /resume use for an
  // unknown thread, so a client branches on one code across the AP surface.
  // Thread existence is therefore observable BEFORE any middleware runs — the
  // same as POST /resume, which answers 404 long before it calls
  // runMiddleware. Deliberate, and mandated by §1 of the spec; the interrupt
  // payloads themselves stay behind the middleware gate below.
  const notFound = () =>
    Response.json(createRequestErrorBody("Thread not found", { code: "thread_not_found" }), {
      status: 404,
    })
  const thread = await threadsStore.getThread(threadId)

  // Thread access, IN ADDITION to the route identity resolved below — the two
  // compose as AND, and neither replaces the other.
  //
  // Route identity alone is not enough here, and the reason is what middleware
  // usually IS in practice: it AUTHENTICATES rather than authorizes per user. A
  // shared API key, or any-valid-user, satisfies the parking route's middleware
  // for every caller alike — so under the common shape, route identity admits
  // anyone holding the app's key to the parked prompt's `interruptId`/
  // `resumeKey` pair. That pair is the credential POST /resume takes, and
  // /resume is now gated on this axis; leaving the read on capability-only
  // gating would put the weaker gate in front of the more sensitive thing.
  //
  // `read`, not `update` — unlike the four run.* operations, this endpoint
  // changes nothing. So a deny defaults to 404 rather than 403, and it is
  // `notFound` above, the handler's OWN literal, that it must be
  // indistinguishable from: a distinct 404 shape here would itself be the
  // enumeration oracle the shared response exists to close.
  //
  // BEFORE the route identity below, not after it — the same ordering exception
  // POST /resume makes, for the same reason and at the same stated cost. The
  // route the middleware would authorize against is read off this thread's own
  // metadata, so "after middleware" would mean resolving an identity from a
  // thread the caller has not been authorized to read, and it would hand a
  // denied caller the 409 thread_route_unknown branch — which answers whether
  // the thread has ever run. The cost: on an app carrying BOTH a policy and
  // authenticating middleware, a caller who would have received a middleware
  // 401 receives the 404 instead. The two checks still compose as AND; only
  // which one answers first is decided here.
  //
  // ABOVE the missing-row 404, and invoked with `thread: undefined` when there
  // is no row — same as GET /threads/:id and GET /threads/:id/state, and what
  // `ThreadAccessRequest.thread` promises: the policy is invoked on every gated
  // request, never short-circuited to the endpoint's natural 404. Ordering it
  // the other way is only invisible while the deny keeps its 404 default. An
  // app that overrides a read deny to 403 would get 403 for a thread that
  // exists and 404 for one that does not — the enumeration oracle, reopened by
  // the one endpoint that answered before asking. And a policy that audits
  // denials would never see the miss at all.
  if (threadAccess) {
    const gate = makeThreadGate(threadAccess, request)
    const g = gate({
      action: "read",
      notFound,
      operation: "thread.pending_interrupts",
      threadId,
      ...(thread ? { thread } : {}),
    })
    const settled = isThenable(g) ? await g : g
    if (!settled.ok) return settled.response
  }
  if (!thread) return notFound()

  // Route identity for middleware. The PARKING route wins — the route whose own
  // turn left these interrupts in the checkpoint (see PARKED_ROUTE_KEY) — and
  // only then the last-run chain POST /resume uses: the in-memory map as the
  // fast path for this server session, thread metadata to survive a restart.
  // There is no client-supplied fallback; a GET has no body to carry one.
  //
  // Gating on the last-run route ALONE is a hole, not an inherited convention.
  // Every endpoint that starts a turn overwrites that identity before executing
  // anything, so a caller a routeId-scoped policy allows on some cheaper route
  // could park-swap their way in: start a run on the route they are allowed,
  // and the same GET that was refused now answers with the parked prompt's
  // `interruptId` and `resumeKey`. POST /resume resolving identity the same way
  // is not a precedent for it: /resume only chooses which route to re-invoke
  // and never returns the payload. This endpoint is what makes route identity
  // control read access, so it is what has to be bound to the parking route.
  //
  // WHAT THIS GATE ACTUALLY PROTECTS is narrower than it looks, and worth being
  // exact about so nobody defends the wrong thing. The prompt's semantic
  // content — the tool name, its argument preview, the fact that a decision is
  // pending — is ALREADY readable without passing this gate: ungated
  // GET /threads/:id/state returns the messages carrying the tool call and its
  // arguments verbatim, plus `next: ["__interrupt__"]`. The ADDRESSING PAIR is
  // what is genuinely gated here and nowhere else. (Gating /state is tracked
  // separately; this endpoint is not the place to compensate for it.)
  //
  // And what that leak is, stated precisely because it is easy to get
  // backwards: it is DISCLOSURE, not approval. It is NOT bounded by /resume
  // gating on an identity the attacker cannot forge — /resume resolves
  // `threadRouteMap ?? metadata.route ?? body.route`, every term of which a
  // park-swap controls. What actually stops them is that resuming the route
  // they swapped in does not answer the prompt the other route parked: a plain
  // graph route ignores `resume` entirely, and an agent route replays its own
  // graph, destroying the pending set rather than resolving it. So the prompt
  // stays unanswered — which makes this a confidentiality fix, and means the
  // secrecy of `resumeKey` is not what the permission decision rests on.
  //
  // RESIDUALS, deliberately accepted. Every HTTP endpoint that can park records
  // it — /runs/stream, /runs/wait (on all four of its exit arms), /resume and
  // /agui — so what is left is the cases where no record was ever written:
  //   1. a thread parked by a build that predates this key;
  //   2. a park whose metadata write itself failed, on one of the arms that
  //      swallow that error rather than mask the failure that brought them
  //      there (the streaming catch paths, /agui's finally);
  //   3. a /runs/wait park whose settle was deferred behind an abandoned route
  //      — cancelled or shut down — that had still not unwound when the process
  //      exited.
  // All three fall through to the chain below and stay swappable until the
  // thread's next turn settles. Detecting them from the checkpoint would mean
  // inferring an owner for interrupts nobody recorded — and the only inferable
  // owner is the last-run route, which is exactly the value an attacker
  // controls.
  //
  // A fourth path parks without recording, and is called out separately because
  // it is not an HTTP endpoint at all: `createAgentHarness`
  // (packages/testing/src/harness.ts) drives `streamResolvedRoute` directly,
  // taking no run slot and settling nothing. It is fail-closed by accident
  // rather than design — a harness run writes no threads-store row, so this
  // endpoint 404s on it before middleware is ever consulted — and it is
  // test-only. Worth knowing before someone gives the harness a threads store.
  //
  // What is NOT on this list any more: deleting the thread row mid-turn. Every
  // settle ends in `updateMetadata`, which no-ops rather than fails on a missing
  // row, so a delete landing between turn start and the interrupt write used to
  // produce a durable park with no record. DELETE now refuses while a run is in
  // flight (see the route above), which closes that window rather than narrowing
  // it: before the turn starts nothing is parked, and after it settles the row
  // and the payload go together.
  const parkedRoute = readParkedRoute(thread)
  const persistedRoute = thread.metadata.route
  const routeKey =
    parkedRoute ??
    threadRouteMap.get(threadId) ??
    (typeof persistedRoute === "string" ? persistedRoute : undefined)
  if (!routeKey) {
    // Fail closed: with no route there is no identity at all to gate on, and
    // route-scoped middleware would silently fall through on an endpoint that
    // serves interrupt payloads. Deliberately a different code from /resume's
    // route_not_found: that one is fixable by passing `route` in the body.
    return Response.json(
      createRequestErrorBody(
        `No route recorded for thread "${threadId}": it has never run, so its pending ` +
          "interrupts cannot be gated by route middleware.",
        { code: "thread_route_unknown" },
      ),
      { status: 409 },
    )
  }

  const route = registry.lookup(routeKey)
  if (!route) {
    // Same code and status as the branch above: both mean "this thread has no
    // usable route identity", and the caller is still ungated here, so the
    // server-derived route key is deliberately NOT echoed — it would tell
    // anyone who can name a thread id which route that thread ran. The other
    // `Unknown route` sites can echo safely because there the key came from
    // the caller's own request body.
    return Response.json(
      createRequestErrorBody(
        `The route recorded for thread "${threadId}" is no longer registered.`,
        { code: "thread_route_unknown" },
      ),
      { status: 409 },
    )
  }

  const requestUrl = new URL(request.url)
  const mwRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    // The first AP endpoint where middleware sees a method other than POST.
    method: "GET",
    // Always empty: run endpoints derive params from the request input via
    // extractRouteParams, and a checkpoint has no input to reconstruct them
    // from. Middleware gating on req.params.orgId for an `[orgId]` route sees
    // {} here — as it does on /resume.
    params: {},
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const mwResult = await runMiddleware(middleware, mwRequest)
  if (mwResult.action === "reject") {
    return statusResponse(mwResult.status, mwResult.body)
  }

  // A known thread with no checkpoint has nothing parked. That is a 200 with an
  // empty list, not a 404: "no such thread" and "nothing pending" are different
  // answers and a reconnecting client acts on them differently.
  //
  // A malformed pending-write set is still listed — this endpoint reports what
  // is parked, and POST /resume is the surface that refuses to act on writes it
  // cannot address safely (malformed_checkpoint).
  const snapshot = await readPendingInterrupts(checkpointer, threadId)
  const interrupts = (snapshot?.interrupts ?? []).map(({ interruptId, resumeKey, value }) => ({
    interruptId,
    resumeKey,
    value,
  }))
  return Response.json(
    { interrupts },
    // Checkpoint state changes under the client; a cached answer would show a
    // prompt that has already been resolved.
    { headers: { "cache-control": "no-store" }, status: 200 },
  )
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
  readonly threadAccess: ThreadAccessPolicy | undefined
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
    threadAccess,
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

  // The ordering exception. Every other run endpoint gates AFTER `runMiddleware`
  // so that an existing 401 never silently becomes a 403; here the gate runs
  // before `tryClaim`, and therefore before the middleware. Two holes make the
  // usual ordering unsatisfiable on this endpoint:
  //
  //   1. `tryClaim` is a side effect a denied caller must not be able to cause.
  //      A caller the policy would deny still takes the victim's resume claim,
  //      so a legitimate resume racing it gets 409 resume_in_progress — a
  //      targeted denial of service against a parked turn, needing no
  //      credential at all.
  //   2. `resolvePendingResume` answers questions about the victim's parked
  //      interrupts: distinct 400/409 codes tell a denied caller whether the
  //      thread has anything parked and whether a guessed
  //      `interruptId`/`resumeKey` is valid. That pair is the credential for
  //      resuming someone else's turn, and it is exactly what the
  //      `/pending_interrupts` gate exists to protect — leaking it here would
  //      make that gate pointless.
  //
  // The cost, stated rather than hidden: on THIS endpoint alone, a caller who
  // would have received a middleware 401 receives a thread-access deny instead.
  // That is not a preference. `runMiddleware` needs `routeKey`, and `routeKey`
  // is read from the resuming thread's own metadata — so the route identity the
  // middleware would authorize against is itself derived from the thread this
  // caller has not yet been authorized to read. "After middleware" and "before
  // any side effect" cannot both hold, and the two holes above decide it.
  //
  // `update`, like every other `run.*` operation — see ThreadOperation.
  if (threadAccess) {
    const existing = await threadsStore.getThread(threadId)
    const gate = makeThreadGate(threadAccess, request)
    const g = gate({
      action: "update",
      operation: "run.resume",
      threadId,
      ...(existing ? { thread: existing } : {}),
    })
    const settled = isThenable(g) ? await g : g
    if (!settled.ok) return settled.response
  }

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
    const resumingThread = await threadsStore.getThread(threadId)
    const persistedRoute = resumingThread?.metadata.route
    const previousParkedRoute = readParkedRoute(resumingThread)
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
    // A resumed turn can park again (an "once" decision authorizes one call,
    // not the tool). Same reasoning as handleApStreamRequest: the adapter's
    // `done` follows the interrupt chunk, so a drained loop is not completion.
    let sawInterrupt = false
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
              if (chunk.type === "interrupt") sawInterrupt = true
              safeEnqueue(controller, encoder.encode(toSseEvent(chunk)))
            }
            // A resume that parks again re-arms the gate on the route that
            // parked; one that answers the last prompt retires it. Same
            // ordering and same failure contract as handleApStreamRequest.
            await settleParkedRoute({
              canPark: route.mode === "agent",
              checkpointer,
              parked: sawInterrupt,
              previousParkedRoute,
              routeKey,
              threadId,
              threadsStore,
            })
            // Deliberately not run.cancelled: the loop drained, so the turn
            // finished. A cancel that lost the race against the last chunk does
            // not retroactively interrupt it — the same abort-vs-settle race the
            // /runs/wait re-check documents at length.
            await threadsStore.updateStatus(
              threadId,
              terminalStatus({ cancelled: false, sawInterrupt }),
            )
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
            await settleParkedRoute({
              canPark: route.mode === "agent",
              checkpointer,
              parked: sawInterrupt,
              previousParkedRoute,
              routeKey,
              threadId,
              threadsStore,
            }).catch(() => undefined)
            await threadsStore
              .updateStatus(threadId, terminalStatus({ cancelled: run.cancelled, sawInterrupt }))
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
