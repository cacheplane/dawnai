import type { Command } from "commander"

import { discoverInitialApp } from "../lib/dev/dev-session.js"
import { type ServeRuntimeHandle, serveRuntime } from "../lib/dev/serve-runtime.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface StartOptions {
  readonly host?: string
  readonly port?: string
}

export function registerStartCommand(program: Command, io: CommandIo): void {
  program
    .command("start")
    .description("Serve the app in production (Dawn runtime; binds 0.0.0.0 by default)")
    .option("--host <host>", "Host to bind (default: 0.0.0.0)")
    .option("--port <number>", "Port to bind (default: 8000)")
    .action(async (options: StartOptions) => {
      await runStartCommand(options, io)

      // serveRuntime (installSignalHandlers: true) owns SIGTERM/SIGINT and
      // closes the listening server itself. Once that happens there is
      // nothing left keeping the event loop alive, so the process exits
      // naturally — we don't need to detect the close ourselves, and we must
      // not resolve early, since an early resolve would let the CLI's
      // top-level `process.exit()` tear the server down immediately after it
      // starts.
      await new Promise<void>(() => {})
    })
}

/**
 * Resolve the app root, boot the production runtime server, and log the
 * bound URL. Returns the `serveRuntime` handle (rather than blocking) so
 * tests can drive the server directly — `--port 0`, hit `/healthz`, then
 * call `close()` — without waiting on process signals. The CLI action above
 * is what supplies the "block forever" production behavior.
 */
export async function runStartCommand(
  options: StartOptions,
  io: CommandIo,
): Promise<ServeRuntimeHandle> {
  const port = parsePort(options.port)
  const discoveredApp = await discoverInitialApp(process.cwd())

  const handle = await serveRuntime({
    appRoot: discoveredApp.appRoot,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(port !== undefined ? { port } : {}),
    installSignalHandlers: true,
  })

  writeLine(io.stdout, `dawn start listening on ${handle.url}`)

  return handle
}

function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  const port = Number(rawPort)

  // Unlike dev.ts's parsePort, 0 is accepted here: it's a legitimate request
  // for a kernel-assigned ephemeral port (and how tests drive this command).
  if (!Number.isInteger(port) || port < 0) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  return port
}
