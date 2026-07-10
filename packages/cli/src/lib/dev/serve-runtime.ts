import { buildRuntimeServerOptions } from "./boot-runtime.js"
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

/**
 * Boot the Dawn runtime HTTP server for production use (`dawn serve`).
 *
 * Shares the once-at-boot assembly (`buildRuntimeServerOptions`) with
 * `dawn dev`'s initial boot — see boot-runtime.ts — then hands off to
 * `startRuntimeServer`, the same single assembly point (runtime registry +
 * threads store + checkpointer + sandbox manager + HTTP listener) `dawn dev`
 * uses in its child process. Unlike `dawn dev`, serveRuntime never watches
 * the filesystem or restarts — it starts once and stays up.
 */
export async function serveRuntime(opts: ServeRuntimeOptions): Promise<ServeRuntimeHandle> {
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0"
  const port = opts.port ?? (process.env.PORT !== undefined ? Number(process.env.PORT) : 8000)
  const installSignalHandlers = opts.installSignalHandlers ?? false

  const assembled = await buildRuntimeServerOptions({ appRoot: opts.appRoot })
  const server = await startRuntimeServer({ ...assembled, host, port })

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
