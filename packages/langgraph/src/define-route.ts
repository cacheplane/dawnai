import type { RouteConfig, RouteEntryKind } from "./route-module.js"

export interface RouteDefinition {
  readonly kind: RouteEntryKind
  readonly entry: string
  readonly config?: RouteConfig
}

export function defineRoute<TRoute extends RouteDefinition>(route: TRoute): TRoute {
  assertRelativeRouteEntry(route.entry)
  return route
}

function assertRelativeRouteEntry(entry: string): asserts entry is string {
  if (!entry.startsWith("./") && !entry.startsWith("../")) {
    throw new Error("Route entry must be a relative module path")
  }
}
