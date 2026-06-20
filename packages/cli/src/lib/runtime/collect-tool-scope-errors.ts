import type { RouteManifest } from "@dawn-ai/core"
import { BUILT_IN_TOOL_NAMES } from "@dawn-ai/core"
import { isDawnAgent } from "@dawn-ai/sdk"

import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"
import { discoverToolDefinitions } from "./tool-discovery.js"

interface ToolScopeShape {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

interface Deps {
  loadScope: (entryFile: string, appRoot: string) => Promise<ToolScopeShape | undefined>
  routeLocalToolNames: (appRoot: string, routeDir: string) => Promise<readonly string[]>
}

const defaultDeps: Deps = {
  loadScope: async (entryFile, appRoot) => {
    let normalized: NormalizedRouteModule
    try {
      normalized = await normalizeRouteModule(entryFile, appRoot)
    } catch {
      return undefined // load failures surfaced elsewhere
    }
    if (!isDawnAgent(normalized.entry)) return undefined
    const entry = normalized.entry as { tools?: ToolScopeShape }
    return entry.tools
  },
  routeLocalToolNames: async (appRoot, routeDir) => {
    const defs = await discoverToolDefinitions({ appRoot, routeDir })
    return defs.map((d) => d.name)
  },
}

export async function collectToolScopeErrors(
  manifest: RouteManifest,
  deps: Deps = defaultDeps,
): Promise<readonly string[]> {
  const errors: string[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    const scope = await deps.loadScope(route.entryFile, manifest.appRoot)
    if (!scope || (!scope.allow && !scope.deny)) continue
    const available = new Set([
      ...(await deps.routeLocalToolNames(manifest.appRoot, route.routeDir)),
      ...BUILT_IN_TOOL_NAMES,
    ])
    const unknown = [...(scope.allow ?? []), ...(scope.deny ?? [])].filter((n) => !available.has(n))
    if (unknown.length > 0) {
      errors.push(
        `✗ ${route.pathname}: unknown tool name(s) in scope: ${unknown.join(", ")}.\n` +
          `    available: ${[...available].sort().join(", ")}`,
      )
    }
  }
  return errors
}
