import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { DawnConfig } from "@dawn-ai/core"
// Type-only imports below (stores, middleware, checkpointer) erase at
// runtime - this module's VALUE graph stays node-http-only.
import type { MemoryStore } from "@dawn-ai/memory"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware, ThreadAccessPolicy } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { RuntimeBootFallbacks } from "../runtime/execute-route-core.js"
import type { SandboxManager } from "../runtime/sandbox-manager.js"
import type { DawnStaticModules } from "../runtime/static-modules-core.js"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import { createRuntimeFetchHandler } from "./runtime-fetch-handler.js"

export interface RuntimeServer {
  readonly close: () => Promise<void>
  readonly url: string
}

/**
 * Per-request store overrides, plus the teardown for whatever they hold open.
 *
 * Every field is optional: whatever a factory omits falls through to the
 * boot-resolved store (or fails loudly, if this runtime has neither).
 */
export interface RequestStores {
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  readonly permissionsStore?: PermissionsStore
  readonly memoryStore?: MemoryStore
  /**
   * Called once BOTH the response body has settled and any run the request
   * started has released its slot — never mid-stream, and never while route
   * work that outlived the response (an aborted stream, an abandoned
   * `/runs/wait`) is still writing through these stores.
   */
  readonly dispose?: () => Promise<void>
}

export interface StartRuntimeServerOptions {
  readonly appRoot: string
  readonly host?: string
  readonly port?: number
  /**
   * How the runtime resolves the HITL permissions store.
   *
   * - `"per-request"` (default - `dawn dev` and unset callers): re-load
   *   `.dawn/permissions.json` on every request, so "Always" grants written
   *   mid-process by the HITL resume path apply on the very next request. The
   *   dev loop does not watch `.dawn/`, so a boot snapshot would go stale.
   * - `"boot"` (production `serveRuntime`): load once at boot and reuse the
   *   instance - no per-request read.
   */
  readonly permissionsMode?: "per-request" | "boot"
  /**
   * A build-time-generated module manifest (PR 2's static-wiring seam). When
   * present, `createRuntimeFetchHandler` builds the runtime registry from it
   * (zero `discoverRoutes` filesystem walk) and pre-seeds the per-route
   * prepared-modules cache so every route's first request also skips its
   * dynamic loads (route/tool/state/memory). When absent, boot and per-request
   * behavior are byte-for-byte the existing dynamic path.
   */
  readonly modules?: DawnStaticModules
  /**
   * An already-constructed DawnConfig. When present, it is seeded into the
   * config memo BEFORE any store/sandbox/memory resolution, so
   * `dawn.config.ts` is never read from disk (edge runtimes have none).
   */
  readonly config?: DawnConfig
  /** Boot-resolved checkpointer. Absent: config, then default sqlite. */
  readonly checkpointer?: BaseCheckpointSaver
  /** Boot-resolved threads store. Absent: config, then default sqlite. */
  readonly threadsStore?: ThreadsStore
  /**
   * Boot-resolved permissions store (instance or per-request factory - same
   * semantics as route execution's boot instances). When provided, it wins
   * REGARDLESS of `permissionsMode` - the caller has taken over permissions
   * resolution entirely. Absent: permissionsMode-driven construction from
   * `.dawn/permissions.json`.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  /** Lazy memory-store thunk. Absent: sqlite-backed resolveMemoryStore. */
  readonly memoryStore?: () => Promise<MemoryStore>
  /** Pre-loaded middleware. Absent: the dynamic src/middleware.ts probe. */
  readonly middleware?: DawnMiddleware
  /**
   * Pre-loaded thread access policy. Absent: the build manifest's entry, then
   * the dynamic src/thread-access.ts probe.
   */
  readonly threadAccess?: ThreadAccessPolicy
  /** Boot-resolved sandbox manager. Absent: built from `config.sandbox`. */
  readonly sandboxManager?: SandboxManager
  /**
   * The filesystem-backed resolutions this runtime may fall back to when a
   * store was not injected. `runtime-fetch-handler.ts` supplies
   * `nodeBootFallbacks` on every node path; an edge runtime supplies none, and
   * anything it did not inject then fails loudly on first use instead of
   * reaching for a disk or sqlite file that is not there.
   */
  readonly bootFallbacks?: RuntimeBootFallbacks
  /**
   * Stores built fresh for each request, then disposed when that request's
   * response (including a streaming SSE body) has fully settled.
   *
   * Exists for edge runtimes whose connections are bound to a request's I/O
   * context: on workerd a module-scope Postgres pool hands request N+1 an idle
   * WebSocket belonging to request N's dead context, which hangs for ~30s until
   * the runtime cancels - alternating, so half of all requests fail. Supplying
   * this replaces the boot-resolved stores for the matching keys, and makes the
   * boot resolution of the others optional on a runtime with no filesystem
   * fallback (they then fail loudly on first use, as an omitted store already
   * does).
   *
   * The factory owns cleanup of a PARTIAL allocation: `dispose` is only ever
   * called on a `RequestStores` this returned, so a factory that opens a pool
   * and then throws must close it itself — the runtime has nothing to dispose
   * in that case and will answer the request with a 500.
   */
  readonly requestStores?: (request: Request) => RequestStores | Promise<RequestStores>
}

// ---------------------------------------------------------------------------
// Server factory - listener-only (no port binding)
// ---------------------------------------------------------------------------

export interface RuntimeRequestListener {
  readonly listener: (req: IncomingMessage, res: ServerResponse) => void
  readonly close: () => Promise<void>
  readonly state: {
    acceptingRequests: boolean
    activeRequests: number
    closed: boolean
  }
  readonly shutdownController: AbortController
}

export async function createRuntimeRequestListener(
  options: StartRuntimeServerOptions,
): Promise<RuntimeRequestListener> {
  const core = await createRuntimeFetchHandler(options)

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // `toWebRequest` aborts the request signal when the client disconnects
      // (the response closes before it ended), which is what stops an
      // in-flight run on client disconnect (AG-UI only).
      const response = await core.fetch(toWebRequest(req, res))
      try {
        await writeNodeResponse(res, response)
      } catch {
        // Writing the response failed (e.g. writeHead threw) - the socket is
        // unusable for a JSON error at this point. Cancel the unread body
        // first so a tracked SSE stream releases its in-flight slot instead
        // of leaking it (which would wedge close()'s drain).
        void response.body?.cancel().catch(() => undefined)
        res.destroy()
      }
    })().catch(() => {
      // core.fetch itself rejected before a Response existed - nothing to
      // cancel; just tear the socket down.
      res.destroy()
    })
  }

  return {
    close: core.close,
    listener,
    shutdownController: core.shutdownController,
    state: core.state,
  }
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

  // The bind host (e.g. "0.0.0.0") is not always dialable directly - report a
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
      // sandboxes - the single shutdown path shared with the in-process
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
 * `0.0.0.0` -> `127.0.0.1`, `::` -> `::1`. Any IPv6 literal (contains `:` and is
 * not already bracketed) is wrapped in `[...]` so it forms a valid URL
 * authority, e.g. `::1` -> `[::1]`.
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
