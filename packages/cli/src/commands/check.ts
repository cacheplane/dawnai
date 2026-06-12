import { join } from "node:path"
import { discoverRoutes } from "@dawn-ai/core"
import { isDawnAgent, validateModelId } from "@dawn-ai/sdk"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { type NormalizedRouteModule, normalizeRouteModule } from "../lib/runtime/load-route-kind.js"
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

    for (const route of manifest.routes) {
      if (route.kind !== "agent") continue
      let normalized: NormalizedRouteModule
      try {
        normalized = await normalizeRouteModule(join(route.routeDir, "index.ts"))
      } catch {
        continue // load failures are surfaced by discovery paths, not this advisory pass
      }
      if (!isDawnAgent(normalized.entry)) continue
      const verdict = validateModelId({
        model: normalized.entry.model,
        ...(normalized.entry.provider ? { provider: normalized.entry.provider } : {}),
      })
      if (!verdict.ok) {
        const suggestions = verdict.suggestions.map((s) => `"${s}"`).join(", ")
        writeLine(
          io.stdout,
          `\n⚠ ${route.pathname}: model "${normalized.entry.model}" is not a known ${verdict.provider} model id.` +
            (suggestions ? ` Did you mean ${suggestions}?` : "") +
            `\n  Known-id lists are advisory — new or proxy model ids work if your provider accepts them.`,
        )
      }
    }
  } catch (error) {
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}
