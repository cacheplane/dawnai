import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { discoverRoutes, findDawnApp, renderRouteTypes } from "@dawn/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"

interface TypegenOptions {
  readonly cwd?: string
}

const OUTPUT_FILE = "dawn.generated.d.ts"

export function registerTypegenCommand(program: Command, io: CommandIo): void {
  program
    .command("typegen")
    .description("Generate Dawn route types")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (options: TypegenOptions) => {
      await runTypegenCommand(options, io)
    })
}

export async function runTypegenCommand(options: TypegenOptions, io: CommandIo): Promise<void> {
  try {
    const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
    const manifest = await discoverRoutes({ appRoot: app.appRoot })
    const outputPath = join(app.routesDir, OUTPUT_FILE)

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, renderRouteTypes(manifest), "utf8")

    writeLine(io.stdout, `Wrote route types to ${outputPath}`)
  } catch (error) {
    throw new CliError(`Failed to generate route types: ${formatErrorMessage(error)}`)
  }
}
