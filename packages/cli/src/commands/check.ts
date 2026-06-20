import { discoverRoutes } from "@dawn-ai/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { collectToolScopeErrors } from "../lib/runtime/collect-tool-scope-errors.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"
import { collectUnknownModelIdWarnings } from "../lib/runtime/warn-unknown-model-ids.js"

interface CheckOptions {
  readonly cwd?: string
}

export function registerCheckCommand(program: Command, io: CommandIo): void {
  program
    .command("check")
    .description("Validate a Dawn app")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (options: CheckOptions) => {
      await runCheckCommand(options, io)
    })
}

export async function runCheckCommand(options: CheckOptions, io: CommandIo): Promise<void> {
  try {
    const manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})

    for (const route of manifest.routes) {
      await discoverToolDefinitions({
        appRoot: manifest.appRoot,
        routeDir: route.routeDir,
      })
    }

    writeLine(io.stdout, `Dawn app is valid: ${manifest.routes.length} routes discovered.`)

    for (const route of manifest.routes) {
      writeLine(io.stdout, `- ${route.pathname} (${route.kind})`)
    }

    const warnings = await collectUnknownModelIdWarnings(manifest)
    for (const warning of warnings) {
      writeLine(io.stdout, `\n${warning}`)
    }

    const scopeErrors = await collectToolScopeErrors(manifest)
    if (scopeErrors.length > 0) {
      throw new CliError(`Invalid tool scope:\n${scopeErrors.join("\n")}`)
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}
