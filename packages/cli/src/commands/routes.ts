import { discoverRoutes } from "@dawn/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"

interface RoutesOptions {
  readonly cwd?: string
  readonly json?: boolean
}

export function registerRoutesCommand(program: Command, io: CommandIo): void {
  program
    .command("routes")
    .description("List discovered Dawn routes")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .option("--json", "Print route metadata as JSON")
    .action(async (options: RoutesOptions) => {
      await runRoutesCommand(options, io)
    })
}

export async function runRoutesCommand(options: RoutesOptions, io: CommandIo): Promise<void> {
  try {
    const manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})

    if (options.json) {
      writeLine(io.stdout, JSON.stringify(manifest, null, 2))
      return
    }

    writeLine(io.stdout, `Discovered ${manifest.routes.length} Dawn routes in ${manifest.appRoot}`)

    for (const route of manifest.routes) {
      writeLine(io.stdout, `${route.pathname} -> ${route.entryFile}`)
    }
  } catch (error) {
    throw new CliError(`Failed to discover routes: ${formatErrorMessage(error)}`)
  }
}
