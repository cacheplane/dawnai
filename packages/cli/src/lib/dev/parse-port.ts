import { CliError } from "../output.js"

/**
 * Parse a --port flag value. Shared by dawn dev and dawn inspect.
 *
 * NOTE: start.ts keeps its own deliberately-different parsePort — it accepts 0
 * as a request for a kernel-assigned ephemeral port. Here 0 is invalid: these
 * commands allocate their own free port when the flag is omitted.
 */
export function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  const port = Number(rawPort)

  if (!Number.isInteger(port) || port <= 0) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  return port
}
