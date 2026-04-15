import type { RouteConfig, RouteEntryKind } from "./route-module.js"

export interface RouteDefinition {
  readonly kind: RouteEntryKind
  readonly entry: string
  readonly config?: RouteConfig
}

export function defineRoute<TRoute extends RouteDefinition>(route: TRoute): TRoute {
  assertCanonicalRouteEntry(route.entry)
  assertMatchingKindAndEntry(route.kind, route.entry)
  return route
}

function assertCanonicalRouteEntry(entry: string): asserts entry is "./graph.ts" | "./workflow.ts" {
  if (entry !== "./graph.ts" && entry !== "./workflow.ts") {
    throw new Error('Route entry must be exactly "./graph.ts" or "./workflow.ts"')
  }
}

function assertMatchingKindAndEntry(
  kind: RouteEntryKind,
  entry: "./graph.ts" | "./workflow.ts",
): void {
  if (
    (kind === "graph" && entry !== "./graph.ts") ||
    (kind === "workflow" && entry !== "./workflow.ts")
  ) {
    throw new Error(
      'Route kind and entry must match exactly: "graph" -> "./graph.ts", "workflow" -> "./workflow.ts"',
    )
  }
}
