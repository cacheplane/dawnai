import { discoverRoutes, findDawnApp } from "@dawn-ai/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface TypegenOptions {
  readonly cwd?: string
}

export function registerTypegenCommand(program: Command, io: CommandIo): void {
  program
    .command("typegen")
    .description("Generate Dawn route and tool types")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (options: TypegenOptions) => {
      await runTypegenCommand(options, io)
    })
}

export async function runTypegenCommand(options: TypegenOptions, io: CommandIo): Promise<void> {
  try {
    const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
    const manifest = await discoverRoutes({ appRoot: app.appRoot })
    const result = await runTypegen({ appRoot: app.appRoot, manifest })

    writeLine(
      io.stdout,
      `Wrote types for ${result.routeCount} route(s), ${result.toolSchemaCount} tool schema(s), ${result.stateRouteCount} stateful route(s)`,
    )
  } catch (error) {
    throw new CliError(`Failed to generate route types: ${formatErrorMessage(error)}`)
  }
}
