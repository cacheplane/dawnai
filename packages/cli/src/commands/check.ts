import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { DawnConfig, RouteManifest } from "@dawn-ai/core"
import { discoverRoutes } from "@dawn-ai/core/node"
import type { Command } from "commander"
import {
  assertEdgeCapabilities,
  collectEdgeDependencyNotice,
  type EdgeCapabilityInput,
} from "../lib/build/targets/edge-capabilities.js"
import { knownTargetNames } from "../lib/build/targets/index.js"
import { loadDawnConfig } from "../lib/node-config.js"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { collectDelegationErrors } from "../lib/runtime/collect-delegation-errors.js"
import { collectSandboxErrors } from "../lib/runtime/collect-sandbox-errors.js"
import { collectToolScopeIssues } from "../lib/runtime/collect-tool-scope-errors.js"
import { resolveMemoryWrites } from "../lib/runtime/resolve-memory.js"
import { createRouteAssistantId } from "../lib/runtime/route-identity.js"
import { loadStaticModules } from "../lib/runtime/static-modules.js"
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
    const delegationErrors = await collectDelegationErrors(manifest)
    if (delegationErrors.length > 0) {
      throw new CliError(`Invalid delegation policy:\n${delegationErrors.join("\n")}`, 1, {
        code: "DAWN_E1004",
      })
    }

    const scopeIssues = await collectToolScopeIssues(manifest, undefined, {
      memoryWrites,
    })
    for (const warning of scopeIssues.warnings) {
      writeLine(io.stdout, `\n${warning}`)
    }
    if (scopeIssues.errors.length > 0) {
      throw new CliError(`Invalid tool scope:\n${scopeIssues.errors.join("\n")}`, 1, {
        code: "DAWN_E1001",
      })
    }

    // Everything this command reads off dawn.config.ts. The edge half is spelled
    // as the GATE'S OWN input type rather than re-listed here, so the two cannot
    // drift: a hand-written `Pick` omitted all four store keys the gate reads
    // (`checkpointer`, `threadsStore`, `permissions.store`, `memory.store`), and
    // nothing objected — every DawnConfig field is optional, so a config typed
    // without them still satisfies `assertEdgeCapabilities`. The tests below the
    // gate are what actually catch a narrowed argument; this is what stops the
    // TYPE from claiming the command loads less than the gate inspects.
    let loadedConfig: EdgeCapabilityInput["config"] & Pick<DawnConfig, "build"> = {}
    try {
      const loaded = await loadDawnConfig({ appRoot: manifest.appRoot })
      loadedConfig = loaded.config
    } catch {
      loadedConfig = {}
    }

    const buildTargets = loadedConfig.build?.targets
    if (buildTargets) {
      const known = knownTargetNames()
      const unknown = buildTargets.filter((name) => !known.includes(name))
      if (unknown.length > 0) {
        throw new CliError(
          `Invalid build config:\nUnknown build target(s): ${unknown.join(", ")}. Known targets: ${known.join(", ")}.`,
          1,
          { code: "DAWN_E1003" },
        )
      }

      // The same gate edge targets apply at emit time, mirrored here so a user
      // finds out from `dawn check` rather than from a failed build. An app on
      // the node target may use all of these features.
      for (const targetName of buildTargets) {
        if (targetName !== "hono" && targetName !== "vercel") continue
        const notice = await collectEdgeDependencyNotice(manifest.appRoot, targetName)
        if (notice) writeLine(io.stdout, `\n${notice}`)
        assertEdgeCapabilities(
          { appRoot: manifest.appRoot, config: loadedConfig, manifest },
          targetName,
        )
      }
    }

    const { errors: sandboxErrors, warnings: sandboxWarnings } =
      await collectSandboxErrors(loadedConfig)
    for (const w of sandboxWarnings) console.warn(`⚠ sandbox: ${w}`)
    if (sandboxErrors.length > 0) {
      throw new CliError(`Invalid sandbox config:\n${sandboxErrors.join("\n")}`, 1, {
        code: "DAWN_E1002",
      })
    }

    await checkStaticModuleManifests(manifest, {
      includeEdge: Boolean(buildTargets?.includes("hono")),
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(`Validation failed: ${formatErrorMessage(error)}`)
  }
}

/**
 * Stale-manifest pass: for each manifest this app's targets can produce, load
 * it through the same `loadStaticModules` path the generated entry uses and
 * compare its routes' assistantId set against the discovered set. A mismatch
 * (route added/renamed/removed since the last `dawn build`) or a manifest that
 * fails to load (corrupt file, stale static imports after a rename) is a check
 * ERROR advising a rebuild. Absent file → no-op for that manifest.
 *
 * BOTH manifests, not just the node one. `modules.edge.mjs` is a separate
 * artifact with its own copy of every route's static imports, and an app built
 * for `hono` ALONE never emits `modules.mjs` at all — so keying the pass on the
 * node path made the whole check a silent no-op for exactly the deployment
 * shape that cannot re-discover routes at runtime. A stale edge bundle is the
 * more expensive of the two to ship: the node server would at least have
 * re-walked the route tree.
 *
 * The edge manifest is checked only when `hono` is a configured target, for the
 * same reason the capability gate is: an app on the node target may have a
 * leftover `modules.edge.mjs` from an experiment, and failing `dawn check` over
 * an artifact nothing deploys would be noise.
 *
 * No DAWN_E code: the error-code registry (@dawn-ai/sdk) has no entry for a
 * stale build artifact — the E1xxx config/check family stops at E1005 (edge
 * capability gate) and producers cannot invent codes. Follow-up: add a
 * registry code (e.g. "Stale static module manifest") in an sdk change.
 */
async function checkStaticModuleManifests(
  manifest: RouteManifest,
  options: { readonly includeEdge: boolean },
): Promise<void> {
  await checkStaticModuleManifest(manifest, "modules.mjs")
  if (options.includeEdge) {
    await checkStaticModuleManifest(manifest, "modules.edge.mjs")
  }
}

/** One manifest file, compared against the discovered route set. */
async function checkStaticModuleManifest(manifest: RouteManifest, fileName: string): Promise<void> {
  const modulesPath = join(manifest.appRoot, ".dawn", "build", fileName)
  if (!existsSync(modulesPath)) return

  let manifestIds: readonly string[]
  try {
    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    manifestIds = modules.routes.map((route) => route.assistantId)
  } catch (error) {
    throw new CliError(
      `Static module manifest failed to load:\n${modulesPath}\n${formatErrorMessage(error)}\n` +
        "The manifest is stale or corrupt — re-run `dawn build` to regenerate it.",
    )
  }

  const discoveredIds = new Set(
    manifest.routes.map((route) => createRouteAssistantId(route.id, route.kind)),
  )
  const staticIds = new Set(manifestIds)
  const missing = [...discoveredIds].filter((id) => !staticIds.has(id)).sort()
  const extra = [...staticIds].filter((id) => !discoveredIds.has(id)).sort()
  if (missing.length === 0 && extra.length === 0) return

  const lines: string[] = []
  if (missing.length > 0) {
    lines.push(`Routes missing from the manifest: ${missing.join(", ")}`)
  }
  if (extra.length > 0) {
    lines.push(`Routes in the manifest but not the app: ${extra.join(", ")}`)
  }
  throw new CliError(
    `Stale static module manifest (${modulesPath}):\n${lines.join("\n")}\n` +
      "Re-run `dawn build` to regenerate it.",
  )
}
