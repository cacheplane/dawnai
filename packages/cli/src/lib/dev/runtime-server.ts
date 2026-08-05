import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { toWebRequest, writeNodeResponse } from "./node-web-adapter.js"
import { createRuntimeFetchHandler } from "./runtime-fetch-handler.js"

export interface RuntimeServer {
  readonly close: () => Promise<void>
  readonly url: string
}

export interface StartRuntimeServerOptions {
  readonly appRoot: string
  readonly host?: string
  readonly port?: number
  /**
   * How the runtime resolves the HITL permissions store.
   *
   * - `"per-request"` (default — `dawn dev` and unset callers): re-load
   *   `.dawn/permissions.json` on every request, so "Always" grants written
   *   mid-process by the HITL resume path apply on the very next request. The
   *   dev loop does not watch `.dawn/`, so a boot snapshot would go stale.
   * - `"boot"` (production `serveRuntime`): load once at boot and reuse the
   *   instance — no per-request read.
   */
  readonly permissionsMode?: "per-request" | "boot"
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
        // Writing the response failed (e.g. writeHead threw) — the socket is
        // unusable for a JSON error at this point. Cancel the unread body
        // first so a tracked SSE stream releases its in-flight slot instead
        // of leaking it (which would wedge close()'s drain).
        void response.body?.cancel().catch(() => undefined)
        res.destroy()
      }
    })().catch(() => {
      // core.fetch itself rejected before a Response existed — nothing to
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
