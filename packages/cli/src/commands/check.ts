import { type DawnConfig, discoverRoutes, loadDawnConfig } from "@dawn-ai/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { collectSandboxErrors } from "../lib/runtime/collect-sandbox-errors.js"
import { collectToolScopeIssues } from "../lib/runtime/collect-tool-scope-errors.js"
import { resolveMemoryWrites } from "../lib/runtime/resolve-memory.js"
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

    const memoryWrites = await resolveMemoryWrites(manifest.appRoot)
    const scopeIssues = await collectToolScopeIssues(manifest, undefined, { memoryWrites })
    for (const warning of scopeIssues.warnings) {
      writeLine(io.stdout, `\n${warning}`)
    }
    if (scopeIssues.errors.length > 0) {
      throw new CliError(`Invalid tool scope:\n${scopeIssues.errors.join("\n")}`)
    }

    let loadedConfig: Pick<DawnConfig, "sandbox"> = {}
    try {
      const loaded = await loadDawnConfig({ appRoot: manifest.appRoot })
      loadedConfig = loaded.config
    } catch {
      loadedConfig = {}
    }

    const { errors: sandboxErrors, warnings: sandboxWarnings } =
      await collectSandboxErrors(loadedConfig)
    for (const w of sandboxWarnings) console.warn(`⚠ sandbox: ${w}`)
    if (sandboxErrors.length > 0) {
      throw new CliError(`Invalid sandbox config:\n${sandboxErrors.join("\n")}`)
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}
