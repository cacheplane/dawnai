import type { Command } from "commander"

import { CliError, type CommandIo } from "../lib/output.js"
import { startDevSession } from "../lib/dev/dev-session.js"

interface DevOptions {
  readonly port?: string
}

export function registerDevCommand(program: Command, io: CommandIo): void {
  program
    .command("dev")
    .description("Start the Dawn local development runtime")
    .option("--port <number>", "Bind dawn dev to a stable localhost port")
    .action(async (options: DevOptions) => {
      await runDevCommand(options, io)
    })
}

export async function runDevCommand(options: DevOptions, io: CommandIo): Promise<void> {
  const port = parsePort(options.port)
  const session = await startDevSession({
    cwd: process.cwd(),
    io,
    ...(typeof port === "number" ? { port } : {}),
  })

  const shutdown = async () => {
    await session.close()
  }

  process.once("SIGINT", () => {
    void shutdown()
  })
  process.once("SIGTERM", () => {
    void shutdown()
  })

  await session.waitUntilClosed()
}

function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  const port = Number(rawPort)

  if (!Number.isInteger(port) || port <= 0) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  return port
}
