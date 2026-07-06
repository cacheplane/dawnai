import type { RouteManifest } from "@dawn-ai/core"
import { BUILT_IN_TOOL_NAMES } from "@dawn-ai/core"
import { isDawnAgent } from "@dawn-ai/sdk"

import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"
import { discoverToolDefinitions } from "./tool-discovery.js"

interface ToolScopeShape {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly approve?: readonly string[]
}

export interface ToolScopeIssues {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** Workspace tools with their own pattern-aware internal gates (bash/path). */
const INTERNALLY_GATED = new Set(["runBash", "readFile", "writeFile", "listDir"])

const BUILT_IN_TOOL_NAME_SET = new Set(BUILT_IN_TOOL_NAMES)

/** A route is a subagent when it lives under a `<parent>/subagents/<name>` directory (see
 * the `subagents` capability marker's `findConventionSubagents` in
 * packages/core/src/capabilities/built-in/subagents.ts, which uses the same convention).
 * Path heuristic only: a top-level route whose own segment is literally named
 * "subagents/<name>" would match too and draw a spurious (non-fatal) warning —
 * accepted for a best-effort check; actual dispatch relationships are only
 * known at composition time. */
function isSubagentRoute(routeDir: string): boolean {
  return /\/subagents\/[^/]+$/.test(routeDir)
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

export async function collectToolScopeIssues(
  manifest: RouteManifest,
  deps: Deps = defaultDeps,
): Promise<ToolScopeIssues> {
  const errors: string[] = []
  const warnings: string[] = []
  for (const route of manifest.routes) {
    if (route.kind !== "agent") continue
    const scope = await deps.loadScope(route.entryFile, manifest.appRoot)
    if (!scope || (!scope.allow && !scope.deny && !scope.approve)) continue
    const available = new Set([
      ...(await deps.routeLocalToolNames(manifest.appRoot, route.routeDir)),
      ...BUILT_IN_TOOL_NAMES,
    ])
    const unknown = [
      ...(scope.allow ?? []),
      ...(scope.deny ?? []),
      ...(scope.approve ?? []),
    ].filter((n) => !available.has(n))
    if (unknown.length > 0) {
      errors.push(
        `✗ ${route.pathname}: unknown tool name(s) in scope: ${unknown.join(", ")}.\n` +
          `    available: ${[...available].sort().join(", ")}`,
      )
    }
    const deny = new Set(scope.deny ?? [])
    const allow = new Set(scope.allow ?? [])
    const routeIsSubagent = isSubagentRoute(route.routeDir)
    for (const name of scope.approve ?? []) {
      if (INTERNALLY_GATED.has(name)) {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "${name}", which is already gated ` +
            `(pattern-aware bash/path permissions). The approve entry is redundant and would double-prompt.`,
        )
      }
      if (name === "task") {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "task", which has no effect — the subagent ` +
            `dispatch bridge replaces the task tool's run after the approval wrap. ` +
            `Gating subagent dispatch is not yet supported.`,
        )
      }
      if (deny.has(name)) {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "${name}" but deny revokes it — deny wins; the approve entry is dead.`,
        )
      }
      // Skip names another warning already fully covers — advising "add it to
      // allow" would conflict with those warnings' point: internally-gated
      // tools are redundant to approve either way, and task has no effect
      // regardless (the dispatch bridge replaces its run).
      if (
        routeIsSubagent &&
        BUILT_IN_TOOL_NAME_SET.has(name) &&
        !INTERNALLY_GATED.has(name) &&
        name !== "task" &&
        !allow.has(name)
      ) {
        warnings.push(
          `⚠ ${route.pathname}: approve lists "${name}", but subagents withhold capability tools ` +
            `by default — add it to allow or the approve entry has no effect.`,
        )
      }
    }
  }
  return { errors, warnings }
}
