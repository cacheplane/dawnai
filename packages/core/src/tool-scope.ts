import type { ToolScope } from "@dawn-ai/sdk"

export type ToolOrigin = "authored" | "capability"

/**
 * Capability-contributed tools are tagged with a synthetic filePath
 * `<capability:NAME>` at composition (see execute-route.ts). Everything else
 * is authored from the route's tools/*.ts.
 */
export function toolOrigin(tool: { readonly filePath: string }): ToolOrigin {
  return tool.filePath.startsWith("<capability:") ? "capability" : "authored"
}

export interface ScopeInput {
  readonly name: string
  readonly origin: ToolOrigin
}

/**
 * Resolve which tool names survive a route's scope.
 *
 * Base set: top route → all tools; subagent → authored only (capability
 * tools withheld). Then `allow` GRANTS named tools into the set, `deny`
 * REVOKES named tools, and deny wins. Unknown names in allow/deny/approve
 * (absent from the full available set) throw so authoring typos fail loud at
 * composition time.
 */
export function resolveToolScope(
  tools: readonly ScopeInput[],
  scope: ToolScope | undefined,
  context: { readonly isSubagent: boolean; readonly routeId: string },
): ReadonlySet<string> {
  const available = new Set(tools.map((t) => t.name))
  const unknown = [
    ...(scope?.allow ?? []),
    ...(scope?.deny ?? []),
    ...(scope?.approve ?? []),
  ].filter((n) => !available.has(n))
  if (unknown.length > 0) {
    throw new Error(
      `Route "${context.routeId}" tool scope references unknown tool(s): ${unknown.join(", ")}. ` +
        `Available: ${[...available].sort().join(", ")}.`,
    )
  }

  const allow = new Set(scope?.allow ?? [])
  const deny = new Set(scope?.deny ?? [])

  const keep = new Set<string>()
  for (const t of tools) {
    const inBase = context.isSubagent ? t.origin === "authored" : true
    if (inBase || allow.has(t.name)) keep.add(t.name)
  }
  for (const name of deny) keep.delete(name)
  return keep
}
