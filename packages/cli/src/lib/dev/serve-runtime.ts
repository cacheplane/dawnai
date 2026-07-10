import { startRuntimeServer } from "./runtime-server.js"

export interface ServeRuntimeOptions {
  readonly appRoot: string
  readonly host?: string
  readonly port?: number
  readonly installSignalHandlers?: boolean
}

export interface ServeRuntimeHandle {
  readonly url: string
  readonly close: () => Promise<void>
}

/** Default production listen port, matching the emitted Dockerfile healthcheck. */
const DEFAULT_SERVE_PORT = 8000

/**
 * Resolve the production listen port.
 *
 * An explicit `opts.port` always wins (including `0` for a random port). An
 * empty or non-numeric `PORT` env var is treated as "unset" and falls back to
 * {@link DEFAULT_SERVE_PORT} — this keeps `serveRuntime` in lockstep with the
 * Dockerfile healthcheck's `PORT||8000`, instead of `Number("")` silently
 * binding a random port.
 */
export function resolveServePort(
  explicitPort: number | undefined,
  envPort: string | undefined,
): number {
  if (explicitPort !== undefined) {
    return explicitPort
  }
  if (envPort === undefined) {
    return DEFAULT_SERVE_PORT
  }
  const trimmed = envPort.trim()
  if (trimmed === "") {
    return DEFAULT_SERVE_PORT
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : DEFAULT_SERVE_PORT
}

/**
 * Boot the Dawn runtime HTTP server for production use (`dawn serve`).
 *
 * Hands off directly to `startRuntimeServer`, the single assembly point
 * (runtime registry + threads store + checkpointer + sandbox manager + HTTP
 * listener) that `dawn dev` also uses in its child process. Unlike `dawn dev`,
 * serveRuntime never watches the filesystem or restarts — it starts once and
 * stays up.
 *
 * Deliberately does NOT run typegen at boot. The host `dawn build` already
 * generated `.dawn/*` (COPY'd into the image), and the runtime's schema
 * injection is best-effort with a fallback to discovered tools when those
 * artifacts are absent. Running typegen here would WRITE `.dawn/*`, crashing a
 * read-only-rootfs production container with EROFS — see PR #339 review.
 */
export async function serveRuntime(opts: ServeRuntimeOptions): Promise<ServeRuntimeHandle> {
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0"
  const port = resolveServePort(opts.port, process.env.PORT)
  const installSignalHandlers = opts.installSignalHandlers ?? false

  const server = await startRuntimeServer({ appRoot: opts.appRoot, host, port })

  if (!installSignalHandlers) {
    return server
  }

  let closed = false

  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
    await server.close()
  }

  const onSignal = (): void => {
    void close()
  }

  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)

  return { close, url: server.url }
}
