import { discoverRoutes, type RouteManifest } from "@dawn/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import {
  loadAuthoringRouteDefinition,
  loadAuthoringRouteHandler,
} from "../lib/runtime/route-definition.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"

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
    await validateAuthoringRoutes(manifest)
    writeLine(io.stdout, `Dawn app is valid: ${manifest.routes.length} routes discovered.`)

    for (const route of manifest.routes) {
      writeLine(io.stdout, `- ${route.pathname} (${route.entryKind})`)
    }
  } catch (error) {
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}

async function validateAuthoringRoutes(manifest: RouteManifest): Promise<void> {
  for (const route of manifest.routes) {
    if (route.entryKind !== "route") {
      continue
    }

    const definition = await loadAuthoringRouteDefinition(route.entryFile)

    if (!definition) {
      throw new Error(`Route definition ${route.entryFile} must export a Dawn route definition`)
    }

    await loadAuthoringRouteHandler(definition)
    await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })
  }
}
